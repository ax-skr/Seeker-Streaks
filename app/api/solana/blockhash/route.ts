import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";

const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";

function normalize(url: string) {
  return url.trim().replace(/\/+$/, "");
}

function getRpcList(): string[] {
  const env1 = process.env.SOLANA_RPC_URL?.trim() || "";
  const env2 = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || "";

  const candidates = [
    env1,
    env2,

    // Hard fallbacks (no keys)
    "https://rpc.ankr.com/solana",
    FALLBACK_RPC,
  ]
    .filter(Boolean)
    .map(normalize);

  return Array.from(new Set(candidates));
}

function isForbiddenError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("403") ||
    lower.includes("forbidden") ||
    lower.includes("-32052") ||
    lower.includes("api key is not allowed to access blockchain")
  );
}

export async function GET() {
  const rpcs = getRpcList();

  const attempts: Array<{ rpc: string; ok: boolean; error?: string }> = [];
  const attempted = new Set<string>();

  const tryRpc = async (rpc: string, reason?: string) => {
    if (attempted.has(rpc)) return null;
    attempted.add(rpc);

    if (reason) {
      console.warn(`[blockhash] ${reason}. Trying ${rpc}`);
    } else {
      console.info(`[blockhash] Trying ${rpc}`);
    }

    try {
      const connection = new Connection(rpc, "confirmed");
      const bh = await connection.getLatestBlockhash("confirmed");

      attempts.push({ rpc, ok: true });
      console.info(`[blockhash] Success ${rpc}`);

      return { rpc, bh };
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      attempts.push({ rpc, ok: false, error: msg });
      console.warn(`[blockhash] Error ${rpc}: ${msg}`);

      if (isForbiddenError(msg) && rpc !== FALLBACK_RPC) {
        return await tryRpc(
          FALLBACK_RPC,
          "403/forbidden detected, falling back to public RPC"
        );
      }

      return null;
    }
  };

  for (const rpc of rpcs) {
    const result = await tryRpc(rpc);
    if (!result) continue;

    return NextResponse.json({
      ok: true,
      rpcUsed: result.rpc,
      blockhash: result.bh.blockhash,
      lastValidBlockHeight: result.bh.lastValidBlockHeight,
      attempts,
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: "Failed to fetch latest blockhash from all RPCs",
      attempts,
    },
    { status: 500 }
  );
}
