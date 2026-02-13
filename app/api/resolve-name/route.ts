import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { Connection, PublicKey } from "@solana/web3.js";
import { MainDomain, findMainDomain, TldParser } from "@onsol/tldparser";

// Mainnet RPC (AllDomains is mainnet)
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

// Reuse 1 connection/parser (faster + less flaky)
const connection = new Connection(RPC_URL, "confirmed");
const parser = new TldParser(connection);

async function resolveMainDomain(wallet: string): Promise<string | null> {
  try {
    const owner = new PublicKey(wallet);
    const [mainDomainPubkey] = findMainDomain(owner);

    const md = await MainDomain.fromAccountAddress(connection, mainDomainPubkey);
    if (!md?.domain || !md?.tld) return null;

    // md.tld already includes the dot (example: ".skr")
    return `${md.domain}${md.tld}`; // "ax.skr"
  } catch {
    return null;
  }
}

async function resolveFallbackSkrDomain(wallet: string): Promise<string | null> {
  try {
    const owner = new PublicKey(wallet);

    // "skr" WITHOUT the dot (per AllDomains docs examples)
    const domains: any[] = await parser.getParsedAllUserDomainsFromTld(owner, "skr");

    if (!Array.isArray(domains) || domains.length === 0) return null;

    // Try to normalize different shapes returned by the SDK
    // Common patterns: { domain: "name", tld: ".skr" } OR { domainName: "name.skr" } OR { name: "name.skr" }
    for (const d of domains) {
      const asString =
        (typeof d === "string" ? d : null) ||
        (typeof d?.domainName === "string" ? d.domainName : null) ||
        (typeof d?.name === "string" ? d.name : null);

      if (asString && asString.toLowerCase().endsWith(".skr")) return asString;

      const dom = typeof d?.domain === "string" ? d.domain : null;
      const tld = typeof d?.tld === "string" ? d.tld : null;

      if (dom && tld) {
        const combined = `${dom}${tld}`;
        if (combined.toLowerCase().endsWith(".skr")) return combined;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function resolveNameForWallet(wallet: string): Promise<string | null> {
  // 1) Main domain (best UX)
  const main = await resolveMainDomain(wallet);
  if (main) return main;

  // 2) Fallback: first owned .skr domain (if they own one)
  const fallback = await resolveFallbackSkrDomain(wallet);
  if (fallback) return fallback;

  return null;
}

async function readWalletFromReq(req: NextRequest): Promise<string> {
  // supports both POST JSON and GET query param
  if (req.method === "GET") {
    const { searchParams } = new URL(req.url);
    return String(searchParams.get("wallet") ?? "").trim();
  }

  const body = await req.json().catch(() => ({}));
  return String(body?.wallet ?? "").trim();
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  try {
    const wallet = await readWalletFromReq(req);

    if (!wallet) {
      return NextResponse.json(
        { ok: false, error: "wallet required" },
        { status: 400 }
      );
    }

    // 1) Cache check
    const { data: user, error: selErr } = await supabaseAdmin
      .from("users")
      .select("wallet, skr_name")
      .eq("wallet", wallet)
      .maybeSingle();

    if (selErr) {
      return NextResponse.json(
        { ok: false, error: "Failed to load user", detail: selErr.message },
        { status: 500 }
      );
    }

    // If cached, return immediately
    if (user?.skr_name) {
      return NextResponse.json({
        ok: true,
        wallet,
        name: user.skr_name,
        cached: true,
        source: "db_cache",
      });
    }

    // 2) Resolve from chain
    const name = await resolveNameForWallet(wallet);

    // 3) Cache (only if the row exists)
    if (name && user?.wallet) {
      await supabaseAdmin.from("users").update({ skr_name: name }).eq("wallet", wallet);
    }

    return NextResponse.json({
      ok: true,
      wallet,
      name: name ?? null,
      cached: false,
      source: name ? "onchain" : "none",
      note: name
        ? undefined
        : "No main .skr set (and no owned .skr found). User may need to set a main domain in AllDomains.",
    });
  } catch (e: any) {
    console.error("resolve-name error:", e);
    return NextResponse.json(
      { ok: false, error: "Internal server error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
