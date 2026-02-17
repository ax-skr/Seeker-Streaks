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

// Sentinel = we store this in users.skr_name to mean "no .skr"
const NONE = "__NONE__";

function withCacheHeaders(res: NextResponse) {
  // Cache at Vercel edge/CDN
  res.headers.set(
    "Cache-Control",
    "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800"
  );
  return res;
}

async function resolveMainDomain(wallet: string): Promise<string | null> {
  try {
    const owner = new PublicKey(wallet);
    const [mainDomainPubkey] = findMainDomain(owner);

    const md = await MainDomain.fromAccountAddress(connection, mainDomainPubkey);
    if (!md?.domain || !md?.tld) return null;

    // md.tld includes the dot (".skr")
    return `${md.domain}${md.tld}`;
  } catch {
    return null;
  }
}

async function resolveFallbackSkrDomain(wallet: string): Promise<string | null> {
  try {
    const owner = new PublicKey(wallet);

    // "skr" WITHOUT the dot
    const domains: any[] = await parser.getParsedAllUserDomainsFromTld(
      owner,
      "skr"
    );

    if (!Array.isArray(domains) || domains.length === 0) return null;

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
  const main = await resolveMainDomain(wallet);
  if (main) return main;

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
  // Still supported, but leaderboard will use GET
  return handle(req);
}

async function handle(req: NextRequest) {
  try {
    const wallet = await readWalletFromReq(req);

    if (!wallet) {
      return withCacheHeaders(
        NextResponse.json({ ok: false, error: "wallet required" }, { status: 400 })
      );
    }

    // 1) DB cache check (also caches NONE)
    const { data: user, error: selErr } = await supabaseAdmin
      .from("users")
      .select("wallet, skr_name")
      .eq("wallet", wallet)
      .maybeSingle();

    if (selErr) {
      return withCacheHeaders(
        NextResponse.json(
          { ok: false, error: "Failed to load user", detail: selErr.message },
          { status: 500 }
        )
      );
    }

    // If cached (including NONE), return immediately
    if (user?.skr_name) {
      const raw = String(user.skr_name);
      const name = raw === NONE ? null : raw;

      return withCacheHeaders(
        NextResponse.json({
          ok: true,
          wallet,
          name,
          cached: true,
          source: "db_cache",
        })
      );
    }

    // 2) Resolve from chain (slow path)
    const name = await resolveNameForWallet(wallet);

    // 3) Cache result in DB: store real name OR NONE sentinel
    if (user?.wallet) {
      const toStore = name ? name : NONE;
      await supabaseAdmin.from("users").update({ skr_name: toStore }).eq("wallet", wallet);
    }

    return withCacheHeaders(
      NextResponse.json({
        ok: true,
        wallet,
        name: name ?? null,
        cached: false,
        source: name ? "onchain" : "none",
        note: name
          ? undefined
          : "No main .skr set (and no owned .skr found). User may need to set a main domain in AllDomains.",
      })
    );
  } catch (e: any) {
    console.error("resolve-name error:", e);
    return withCacheHeaders(
      NextResponse.json(
        { ok: false, error: "Internal server error", detail: String(e?.message || e) },
        { status: 500 }
      )
    );
  }
}
