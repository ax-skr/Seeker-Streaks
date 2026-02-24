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

function looksLikeSkr(v: unknown) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.toLowerCase().endsWith(".skr") ? s : null;
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

// Fallback: find any owned .skr even if not set as main
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

    // 1) DB cache check (use the newest of the two timestamps)
    const { data: user, error: selErr } = await supabaseAdmin
      .from("users")
      .select("wallet, main_domain, main_domain_updated_at, skr_name, skr_name_updated_at")
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

    const cachedMain = looksLikeDomain((user as any)?.main_domain);
    const cachedSkr = looksLikeSkr((user as any)?.skr_name);

    const tMain = parseTsMs((user as any)?.main_domain_updated_at);
    const tSkr = parseTsMs((user as any)?.skr_name_updated_at);
    const lastCheckMs = Math.max(tMain, tSkr);

    const isFresh = lastCheckMs > 0 && Date.now() - lastCheckMs < TTL_MS;

    const cachedDisplay = cachedSkr || cachedMain || null;

    if (cachedDisplay && isFresh) {
      return withCacheHeaders(
        NextResponse.json({
          ok: true,
          wallet,
          name: cachedDisplay, // display name
          main_domain: cachedMain,
          skr_name: cachedSkr,
          cached: true,
          source: "db_cache",
          fresh: true,
        }),
        true
      );
    }

    if (!cachedDisplay && isFresh) {
      return withCacheHeaders(
        NextResponse.json({
          ok: true,
          wallet,
          name: null,
          main_domain: cachedMain,
          skr_name: cachedSkr,
          cached: true,
          source: "db_cache_none",
          fresh: true,
          note: "Checked within last 24h; skipping onchain resolve.",
        }),
        false
      );
    }

    // 2) Resolve from chain
    const resolvedMain = looksLikeDomain(await resolveMainDomain(wallet));

    // If main domain is .skr, that's the skr_name too.
    // Otherwise fallback to find any owned .skr.
    const resolvedSkr =
      (resolvedMain && resolvedMain.toLowerCase().endsWith(".skr") ? resolvedMain : null) ||
      looksLikeSkr(await resolveFallbackSkrDomain(wallet));

    const nowIso = new Date().toISOString();

    // 3) Write back both (always update timestamps)
    await supabaseAdmin
      .from("users")
      .upsert(
        {
          wallet,
          main_domain: resolvedMain,
          main_domain_updated_at: nowIso,
          skr_name: resolvedSkr,
          skr_name_updated_at: nowIso,
        },
        { onConflict: "wallet" }
      );

    const display = resolvedSkr || resolvedMain || null;

    return withCacheHeaders(
      NextResponse.json({
        ok: true,
        wallet,
        name: display,
        main_domain: resolvedMain,
        skr_name: resolvedSkr,
        cached: false,
        source: display ? "onchain" : "none",
        note: display
          ? undefined
          : "No main domain set (and no owned .skr found). User may need to set a main domain in AllDomains.",
      }),
      !!display
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