import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { Connection, PublicKey } from "@solana/web3.js";
import { MainDomain, findMainDomain, TldParser } from "@onsol/tldparser";

const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC_URL, "confirmed");
const parser = new TldParser(connection);

// 24h TTL: do not resolve on-chain more than once per day per wallet
const TTL_MS = 24 * 60 * 60 * 1000;

function withCacheHeaders(res: NextResponse, nameFound: boolean) {
  if (nameFound) {
    res.headers.set(
      "Cache-Control",
      "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800"
    );
  } else {
    res.headers.set(
      "Cache-Control",
      "public, max-age=0, s-maxage=300, stale-while-revalidate=3600"
    );
  }
  return res;
}

function looksLikeDomain(v: unknown) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (!s.includes(".")) return null;
  if (s.length > 80) return null;
  return s;
}

function parseTsMs(v: unknown): number {
  const s = typeof v === "string" ? v : "";
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function resolveMainDomain(wallet: string): Promise<string | null> {
  try {
    const owner = new PublicKey(wallet);
    const [mainDomainPubkey] = findMainDomain(owner);
    const md = await MainDomain.fromAccountAddress(connection, mainDomainPubkey);
    if (!md?.domain || !md?.tld) return null;
    return `${md.domain}${md.tld}`; // md.tld includes dot
  } catch {
    return null;
  }
}

// Keep your skr fallback (nice-to-have if user owns .skr but hasn't set main)
async function resolveFallbackSkrDomain(wallet: string): Promise<string | null> {
  try {
    const owner = new PublicKey(wallet);
    const domains: any[] = await parser.getParsedAllUserDomainsFromTld(owner, "skr");
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
  // ✅ Any main domain first (could be .sol, .skr, etc.)
  const main = await resolveMainDomain(wallet);
  if (main) return main;

  // ✅ Optional fallback: find owned .skr even if not set as main
  const fallback = await resolveFallbackSkrDomain(wallet);
  if (fallback) return fallback;

  return null;
}

async function readWalletFromReq(req: NextRequest): Promise<string> {
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
      return withCacheHeaders(
        NextResponse.json({ ok: false, error: "wallet required" }, { status: 400 }),
        false
      );
    }

    // 1) DB cache check (includes last resolve attempt time)
    const { data: user, error: selErr } = await supabaseAdmin
      .from("users")
      .select("wallet, main_domain, main_domain_updated_at")
      .eq("wallet", wallet)
      .maybeSingle();

    if (selErr) {
      return withCacheHeaders(
        NextResponse.json(
          { ok: false, error: "Failed to load user", detail: selErr.message },
          { status: 500 }
        ),
        false
      );
    }

    const cachedRaw = looksLikeDomain((user as any)?.main_domain);
    const lastCheckMs = parseTsMs((user as any)?.main_domain_updated_at);
    const isFresh = lastCheckMs > 0 && Date.now() - lastCheckMs < TTL_MS;

    // ✅ If we have a cached name and it's fresh → return it
    if (cachedRaw && isFresh) {
      return withCacheHeaders(
        NextResponse.json({
          ok: true,
          wallet,
          name: cachedRaw,
          cached: true,
          source: "db_cache",
          fresh: true,
        }),
        true
      );
    }

    // ✅ If cached null and fresh → do NOT hit chain again
    if (!cachedRaw && isFresh) {
      return withCacheHeaders(
        NextResponse.json({
          ok: true,
          wallet,
          name: null,
          cached: true,
          source: "db_cache_none",
          fresh: true,
          note: "Checked within last 24h; skipping onchain resolve.",
        }),
        false
      );
    }

    // 2) Resolve from chain (slow path)
    const resolved = await resolveNameForWallet(wallet);
    const cleaned = looksLikeDomain(resolved);

    // 3) Write back attempt time ALWAYS (+ name if found)
    await supabaseAdmin
      .from("users")
      .upsert(
        {
          wallet,
          main_domain: cleaned,
          main_domain_updated_at: new Date().toISOString(),
        },
        { onConflict: "wallet" }
      );

    return withCacheHeaders(
      NextResponse.json({
        ok: true,
        wallet,
        name: cleaned,
        cached: false,
        source: cleaned ? "onchain" : "none",
        note: cleaned
          ? undefined
          : "No main domain set (and no owned .skr found). User may need to set a main domain in AllDomains.",
      }),
      !!cleaned
    );
  } catch (e: any) {
    console.error("resolve-name error:", e);
    return withCacheHeaders(
      NextResponse.json(
        { ok: false, error: "Internal server error", detail: String(e?.message || e) },
        { status: 500 }
      ),
      false
    );
  }
}