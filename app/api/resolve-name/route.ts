import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { Connection, PublicKey } from "@solana/web3.js";
import { MainDomain, findMainDomain } from "@onsol/tldparser";

// Uses mainnet by default (fine for AllDomains main domain lookup)
const RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function fetchMainDomainString(wallet: string): Promise<string | null> {
  const connection = new Connection(RPC_URL);

  const pubkey = new PublicKey(wallet);
  const [mainDomainPubkey] = findMainDomain(pubkey);

  try {
    const md = await MainDomain.fromAccountAddress(connection, mainDomainPubkey);
    if (!md?.domain || !md?.tld) return null;
    return `${md.domain}${md.tld}`; // e.g. "yourname.skr"
  } catch {
    return null; // no main domain set
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const wallet = String(body?.wallet ?? "").trim();

    if (!wallet) {
      return NextResponse.json({ ok: false, error: "wallet required" }, { status: 400 });
    }

    // 1) Try cached value first
    const { data: user, error: selErr } = await supabaseAdmin
      .from("users")
      .select("wallet, skr_name")
      .eq("wallet", wallet)
      .maybeSingle();

    // If schema cache complains (column missing), return clean error
    if (selErr?.code === "PGRST204") {
      return NextResponse.json(
        {
          ok: false,
          error: "Missing users.skr_name column. Add it in Supabase (SQL provided).",
        },
        { status: 500 }
      );
    }

    if (selErr) {
      return NextResponse.json({ ok: false, error: "Failed to load user" }, { status: 500 });
    }

    if (user?.skr_name) {
      return NextResponse.json({ ok: true, wallet, name: user.skr_name, cached: true });
    }

    // 2) Resolve via AllDomains main domain
    const name = await fetchMainDomainString(wallet);

    // 3) Cache it if we found one (only if user row exists)
    if (name && user?.wallet) {
      await supabaseAdmin.from("users").update({ skr_name: name }).eq("wallet", wallet);
    }

    return NextResponse.json({ ok: true, wallet, name: name ?? null, cached: false });
  } catch (e) {
    console.error("resolve-name error:", e);
    return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
  }
}
