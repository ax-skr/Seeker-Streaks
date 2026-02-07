import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

function getRpc(): string {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const pubkey = String(body?.pubkey ?? "").trim();
    if (!pubkey) return NextResponse.json({ ok: false, error: "pubkey required" }, { status: 400 });

    const connection = new Connection(getRpc(), "confirmed");
    const info = await connection.getAccountInfo(new PublicKey(pubkey), "confirmed");

    return NextResponse.json({ ok: true, exists: !!info });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "internal_error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
