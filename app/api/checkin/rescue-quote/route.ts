import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { PublicKey } from "@solana/web3.js";

const MAX_RESCUE_DAYS = 4;
const SKR_PER_DAY = 100;
const SKR_DECIMALS = 6;

const SKR_MINT = new PublicKey(
  process.env.SKR_MINT || "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3"
);

const TREASURY_WALLET = new PublicKey(
  process.env.TREASURY_WALLET || process.env.NEXT_PUBLIC_TREASURY_WALLET || ""
);

function todayUTCISO(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

function daysBetweenUTC(aISO: string, bISO: string): number {
  const a = new Date(aISO + "T00:00:00Z");
  const b = new Date(bISO + "T00:00:00Z");
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const wallet = String(body?.wallet ?? "").trim();

    if (!wallet) {
      return NextResponse.json({ ok: false, error: "wallet required" }, { status: 400 });
    }

    const { data: user, error: userErr } = await supabaseAdmin
      .from("users")
      .select("wallet, streak, points, last_checkin_date, rescued_days_used_run, verified_at")
      .eq("wallet", wallet)
      .maybeSingle();

    if (userErr) {
      return NextResponse.json(
        { ok: false, error: "supabase_error", detail: userErr.message },
        { status: 500 }
      );
    }

    const u = user;
    const today = todayUTCISO();

    let missedDays = 0;
    if (u?.last_checkin_date) {
      missedDays = Math.max(0, daysBetweenUTC(u.last_checkin_date, today) - 1);
    }

    const used = u?.rescued_days_used_run ?? 0;
    const remainingRescue = Math.max(0, MAX_RESCUE_DAYS - used);

    const canRescue =
      missedDays > 0 && missedDays <= remainingRescue && missedDays <= MAX_RESCUE_DAYS;

    const costSKR = canRescue ? missedDays * SKR_PER_DAY : 0;

    // ✅ Translation layer: return BOTH old + new keys
    return NextResponse.json({
      ok: true,
      verified: !!u?.verified_at,
      streak: u?.streak ?? 0,
      points: u?.points ?? 0,
      missedDays,

      // OLD keys
      canRescue,
      costSKR,
      remainingRescue,

      // NEW keys
      canProtect: canRescue,
      protectionRequired: canRescue,
      protectionCostSKR: costSKR,
      protectionsLeft: remainingRescue,

      treasury: TREASURY_WALLET.toBase58(),
      mint: SKR_MINT.toBase58(),
      decimals: SKR_DECIMALS,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "internal_error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
