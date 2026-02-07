import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { Connection, PublicKey } from "@solana/web3.js";
import { MainDomain, findMainDomain } from "@onsol/tldparser";

const RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function fetchMainDomainString(
  connection: Connection,
  wallet: string
): Promise<string | null> {
  try {
    const pubkey = new PublicKey(wallet);
    const [mainDomainPubkey] = findMainDomain(pubkey);
    const md = await MainDomain.fromAccountAddress(connection, mainDomainPubkey);
    if (!md?.domain || !md?.tld) return null;
    return `${md.domain}${md.tld}`;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    // ✅ Sort in Supabase: streak DESC, then points DESC
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("wallet, points, streak, verified_at, skr_name")
      .not("verified_at", "is", null)
      .order("streak", { ascending: false })
      .order("points", { ascending: false });

    if (error?.code === "PGRST204") {
      return NextResponse.json(
        {
          error:
            "Missing users.skr_name column. Add it in Supabase (SQL provided).",
        },
        { status: 500 }
      );
    }

    if (error) {
      console.error("leaderboard select error:", error);
      return NextResponse.json(
        { error: "Failed to load leaderboard" },
        { status: 500 }
      );
    }

    const rows = (data ?? []).map((u) => ({
      wallet: String(u.wallet),
      points: Number(u.points ?? 0),
      streak: Number(u.streak ?? 0),
      skr_name: u.skr_name ? String(u.skr_name) : null,
    }));

    // 2) Resolve missing skr_name values (small list = fine)
    const connection = new Connection(RPC_URL);

    const resolved = await Promise.all(
      rows.map(async (r) => {
        if (r.skr_name) return r;

        const name = await fetchMainDomainString(connection, r.wallet);
        if (name) {
          // cache (best-effort)
          await supabaseAdmin
            .from("users")
            .update({ skr_name: name })
            .eq("wallet", r.wallet);
          return { ...r, skr_name: name };
        }
        return r;
      })
    );

    // 3) Return consistent shape for your UI
    const out = resolved.map((r, i) => ({
      rank: i + 1,
      wallet: r.wallet,
      points: r.points,
      streak: r.streak,
      name: r.skr_name, // <-- UI reads this
    }));

    return NextResponse.json({ ok: true, rows: out });
  } catch (e) {
    console.error("leaderboard error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
