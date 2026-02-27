import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

const MAX_RESCUE_DAYS = 4;
const SKR_PER_DAY = 500;

const SKR_MINT = new PublicKey(
  process.env.SKR_MINT || "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3"
);

const TREASURY_WALLET = new PublicKey(
  process.env.TREASURY_WALLET || process.env.NEXT_PUBLIC_TREASURY_WALLET || ""
);

function todayUTCISO(): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  return d.toISOString().slice(0, 10);
}

function daysBetweenUTC(aISO: string, bISO: string): number {
  const a = new Date(aISO + "T00:00:00Z");
  const b = new Date(bISO + "T00:00:00Z");
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function getRpc(): string {
  return (
    process.env.SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}

async function getMintDecimals(
  connection: Connection,
  mint: PublicKey
): Promise<number> {
  const info = await connection.getParsedAccountInfo(mint, "confirmed");
  const v: any = info?.value;
  const decimals = v?.data?.parsed?.info?.decimals;
  return typeof decimals === "number" ? decimals : 6;
}

function isTransferCheckedToTreasury(
  ix: any,
  opts: {
    payerWallet: string;
    mint: string;
    destinationAta: string;
    expectedRawAmount: string;
  }
): boolean {
  if (!ix) return false;
  if (ix.program !== "spl-token" && ix.program !== "spl-token-2022") return false;

  const parsed = ix.parsed;
  if (!parsed || parsed.type !== "transferChecked" || !parsed.info) return false;

  const info = parsed.info;
  const destination = String(info.destination ?? "");
  const authority = String(info.authority ?? "");
  const mint = String(info.mint ?? "");
  const amt = String(info.tokenAmount?.amount ?? "");

  return (
    destination === opts.destinationAta &&
    authority === opts.payerWallet &&
    mint === opts.mint &&
    amt === opts.expectedRawAmount
  );
}

function minuteBucketUTC(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}Z`;
}

/**
 * Soft rate limit:
 * - insert unique (wallet, route, bucket) into rate_limits
 * - on duplicate (23505), treat as cooldown but return 200 (no “error” rows in Vercel)
 */
async function rateLimit(wallet: string, route: string) {
  const bucket = minuteBucketUTC();

  const { error } = await supabaseAdmin
    .from("rate_limits")
    .insert({ wallet, route, bucket });

  if (error) {
    const code = (error as any).code;
    if (code === "23505") return { ok: false, bucket };
    console.error("RATE LIMIT ERROR:", error);
    return { ok: true, bucket }; // fail-open
  }

  return { ok: true, bucket };
}

// helper: attach protection keys to any payload
function withProtectionAliases<T extends Record<string, any>>(payload: T) {
  const missedDays = payload.missedDays;
  const remainingRescue = payload.remainingRescue;
  const canRescue = payload.canRescue;
  const costSKR = payload.costSKR;

  return {
    ...payload,
    canProtect: typeof canRescue === "boolean" ? canRescue : undefined,
    protectionRequired: typeof canRescue === "boolean" ? canRescue : undefined,
    protectionCostSKR: typeof costSKR === "number" ? costSKR : undefined,
    protectionsLeft:
      typeof remainingRescue === "number" ? remainingRescue : undefined,
    missedDays,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const wallet = String(body?.wallet ?? "").trim();
    const action = String(body?.action ?? "").trim();
    const rescueDays = Number(body?.rescueDays ?? 0);
    const txSig = String(body?.txSig ?? "").trim();

    // For “no errors in logs”, return 200 with ok:false for most client mistakes too.
    // If you prefer strict, you can switch some of these back to 400/403.
    if (!wallet || !action) {
      return NextResponse.json({ ok: false, status: "bad_request", message: "wallet and action required" });
    }

    const rl = await rateLimit(wallet, "/api/checkin/commit");
    if (!rl.ok) {
      // no 429 => no red errors in Vercel
      return NextResponse.json({
        ok: false,
        status: "cooldown",
        message: "Too many requests. Try again in a moment.",
        retryAfterSeconds: 10,
      });
    }

    if (action === "rescue_paid" && rescueDays > MAX_RESCUE_DAYS) {
      return NextResponse.json({
        ok: false,
        status: "bad_request",
        message: "rescueDays exceeds MAX_RESCUE_DAYS",
      });
    }

    const { data: user, error: userErr } = await supabaseAdmin
      .from("users")
      .select(
        "wallet, points, streak, last_checkin_date, rescued_days_used_run, verified_at"
      )
      .eq("wallet", wallet)
      .maybeSingle();

    if (userErr) {
      console.error("USER SELECT ERROR:", userErr);
      return NextResponse.json({ ok: false, status: "server_error", message: "Failed to load user" }, { status: 500 });
    }

    let u = user ?? null;

    if (!u) {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("users")
        .insert({
          wallet,
          points: 0,
          streak: 0,
          last_checkin_date: null,
          rescued_days_used_run: 0,
          verified_at: null,
        })
        .select(
          "wallet, points, streak, last_checkin_date, rescued_days_used_run, verified_at"
        )
        .single();

      if (insErr || !inserted) {
        console.error("USER INSERT ERROR:", insErr);
        return NextResponse.json({ ok: false, status: "server_error", message: "Failed to create user" }, { status: 500 });
      }

      u = inserted;
    }

    if (!u?.verified_at) {
      // return 200 so it doesn’t appear as “error” in Vercel
      return NextResponse.json({
        ok: false,
        status: "not_verified",
        message: "Wallet not verified. Verify in the app first.",
      });
    }

    const today = todayUTCISO();

    const computeMissedDays = () => {
      if (!u?.last_checkin_date) return 0;
      return Math.max(0, daysBetweenUTC(u.last_checkin_date, today) - 1);
    };

    // -------- CHECKIN --------
    if (action === "checkin") {
      if (u.last_checkin_date === today) {
        // ✅ “double check” should be 200, not 409
        return NextResponse.json({
          ok: true,
          status: "already_checked_in",
          action: "checkin",
          streak: u.streak ?? 0,
          points: u.points ?? 0,
        });
      }

      if (u.last_checkin_date) {
        const d = daysBetweenUTC(u.last_checkin_date, today);

        if (d > 1) {
          const missedDays = Math.max(0, d - 1);
          const used = u.rescued_days_used_run ?? 0;
          const remainingRescue = MAX_RESCUE_DAYS - used;

          const canRescue =
            missedDays > 0 &&
            missedDays <= remainingRescue &&
            missedDays <= MAX_RESCUE_DAYS;

          if (canRescue) {
            // ✅ rescue required is normal UX state, not an error -> 200
            return NextResponse.json(
              withProtectionAliases({
                ok: true,
                status: "rescue_required",
                protection_required: true,
                missedDays,
                remainingRescue,
                costSKR: missedDays * SKR_PER_DAY,
                treasury: TREASURY_WALLET.toBase58(),
                mint: SKR_MINT.toBase58(),
                canRescue,
              })
            );
          }

          // Missed too many days -> reset streak (points kept)
          await supabaseAdmin
            .from("users")
            .update({
              streak: 1,
              last_checkin_date: today,
              rescued_days_used_run: 0,
            })
            .eq("wallet", wallet);

          return NextResponse.json({
            ok: true,
            status: "streak_reset_due_to_missed_days",
            action: "checkin",
            streak: 1,
            points: u.points ?? 0,
            note: "Too many missed days to protect. Streak reset — keep checking in daily.",
          });
        }
      }

      let newStreak = 1;
      if (u.last_checkin_date) {
        const d = daysBetweenUTC(u.last_checkin_date, today);
        newStreak = d === 1 ? (u.streak ?? 0) + 1 : 1;
      }

      const newPoints = (u.points ?? 0) + 1;

      const { error: upErr } = await supabaseAdmin
        .from("users")
        .update({
          streak: newStreak,
          last_checkin_date: today,
          points: newPoints,
        })
        .eq("wallet", wallet);

      if (upErr) {
        console.error("CHECKIN UPDATE ERROR:", upErr);
        return NextResponse.json({ ok: false, status: "server_error", message: "Failed to check in" }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        status: "checked_in",
        action: "checkin",
        streak: newStreak,
        points: newPoints,
      });
    }

    // -------- RESET STREAK (FREE) --------
    if (action === "reset_streak") {
      if (u.last_checkin_date === today) {
        return NextResponse.json({
          ok: true,
          status: "already_applied_today",
          action: "reset_streak",
          streak: u.streak ?? 1,
          points: u.points ?? 0,
          note: "Already applied today.",
        });
      }

      const newPoints = (u.points ?? 0) + 1;

      const { error: resetErr } = await supabaseAdmin
        .from("users")
        .update({
          streak: 1,
          last_checkin_date: today,
          points: newPoints,
          rescued_days_used_run: 0,
        })
        .eq("wallet", wallet);

      if (resetErr) {
        console.error("RESET STREAK ERROR:", resetErr);
        return NextResponse.json({ ok: false, status: "server_error", message: "Failed to reset streak" }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        status: "streak_reset",
        action: "reset_streak",
        streak: 1,
        points: newPoints,
        remainingRescue: MAX_RESCUE_DAYS,
        protectionsLeft: MAX_RESCUE_DAYS,
        note: "Streak reset. Points kept. Protections refreshed. Check in daily.",
      });
    }

    // -------- RESCUE (PAID) --------
    if (action === "rescue_paid") {
      if (!Number.isFinite(rescueDays) || rescueDays <= 0) {
        return NextResponse.json({
          ok: false,
          status: "bad_request",
          message: "rescueDays required (>0)",
        });
      }

      if (!txSig) {
        return NextResponse.json({ ok: false, status: "bad_request", message: "txSig required" });
      }

      const missedDays = computeMissedDays();
      const used = u.rescued_days_used_run ?? 0;
      const remainingRescue = MAX_RESCUE_DAYS - used;

      const stillAllowed =
        missedDays > 0 &&
        missedDays <= remainingRescue &&
        missedDays <= MAX_RESCUE_DAYS;

      if (!stillAllowed) {
        return NextResponse.json({
          ok: false,
          status: "not_allowed",
          message: "Protection is not allowed right now.",
        });
      }

      if (rescueDays !== missedDays) {
        return NextResponse.json({ ok: false, status: "bad_request", message: "rescueDays mismatch" });
      }

      const conn = new Connection(getRpc(), "confirmed");
      const decimals = await getMintDecimals(conn, SKR_MINT);

      const expectedRaw = (
        BigInt(SKR_PER_DAY) *
        BigInt(rescueDays) *
        BigInt(10) ** BigInt(decimals)
      ).toString();

      const treasuryAta = await getAssociatedTokenAddress(
        SKR_MINT,
        TREASURY_WALLET,
        false
      );

      const tx = await conn.getParsedTransaction(txSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        return NextResponse.json({
          ok: false,
          status: "tx_not_confirmed",
          message: "Transaction not confirmed yet.",
        });
      }
      if (tx.meta?.err) {
        return NextResponse.json({
          ok: false,
          status: "tx_failed",
          message: "Transaction failed on-chain.",
        });
      }

      const mintStr = SKR_MINT.toBase58();
      const treasuryAtaStr = treasuryAta.toBase58();

      const top = tx.transaction.message.instructions ?? [];
      const inner = (tx.meta?.innerInstructions ?? []).flatMap(
        (x: any) => x.instructions ?? []
      );
      const allInstructions = [...top, ...inner];

      const okPay = allInstructions.some((ix: any) =>
        isTransferCheckedToTreasury(ix, {
          payerWallet: wallet,
          mint: mintStr,
          destinationAta: treasuryAtaStr,
          expectedRawAmount: expectedRaw,
        })
      );

      if (!okPay) {
        // Still “not applied”, but return 200 so it’s not a Vercel “error row”
        return NextResponse.json({
          ok: false,
          status: "payment_verification_failed",
          message: "Payment verification failed.",
        });
      }

      const paymentPayload = {
        sig: txSig,
        wallet,
        mint: mintStr,
        treasury: TREASURY_WALLET.toBase58(),
        treasury_ata: treasuryAtaStr,
        rescue_days: rescueDays,
        amount_raw: expectedRaw,
      };

      const { error: upsertErr } = await supabaseAdmin
        .from("skr_payments")
        .upsert(paymentPayload, { onConflict: "sig" });

      if (upsertErr) {
        console.error("SKR PAYMENTS UPSERT ERROR:", upsertErr);
        return NextResponse.json({ ok: false, status: "server_error", message: "Failed to record payment." }, { status: 500 });
      }

      const { data: freshUser, error: fuErr } = await supabaseAdmin
        .from("users")
        .select("wallet, rescued_days_used_run, last_checkin_date")
        .eq("wallet", wallet)
        .maybeSingle();

      if (fuErr || !freshUser) {
        return NextResponse.json({ ok: false, status: "server_error", message: "Failed to refresh user" }, { status: 500 });
      }

      if (freshUser.last_checkin_date === today) {
        const usedNow = freshUser.rescued_days_used_run ?? 0;
        return NextResponse.json({
          ok: true,
          status: "already_applied_today",
          action: "rescue_paid",
          rescuedDays: rescueDays,
          protectedDays: rescueDays,
          remainingRescue: Math.max(0, MAX_RESCUE_DAYS - usedNow),
          protectionsLeft: Math.max(0, MAX_RESCUE_DAYS - usedNow),
          note: "Already applied.",
        });
      }

      const usedNow = freshUser.rescued_days_used_run ?? 0;

      const { error: applyErr } = await supabaseAdmin
        .from("users")
        .update({
          rescued_days_used_run: usedNow + rescueDays,
          last_checkin_date: today,
        })
        .eq("wallet", wallet);

      if (applyErr) {
        console.error("RESCUE APPLY ERROR:", applyErr);
        return NextResponse.json({ ok: false, status: "server_error", message: "Failed to apply protection" }, { status: 500 });
      }

      const left = Math.max(0, MAX_RESCUE_DAYS - (usedNow + rescueDays));

      return NextResponse.json({
        ok: true,
        status: "protected",
        action: "rescue_paid",
        rescuedDays: rescueDays,
        protectedDays: rescueDays,
        remainingRescue: left,
        protectionsLeft: left,
      });
    }

    return NextResponse.json({ ok: false, status: "bad_request", message: "Unknown action" });
  } catch (e) {
    console.error("CHECKIN COMMIT ERROR:", e);
    return NextResponse.json({ ok: false, status: "server_error", message: "Internal server error" }, { status: 500 });
  }
}