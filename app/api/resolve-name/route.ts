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

// Legacy sentinel some older code stored in users.skr_name
const LEGACY_NONE = "__NONE__";

// Cache headers tuned by result
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
        NextResponse.json(
          { ok: false, error: "wallet required" },
          { status: 400 }
        ),
        false
      );
    }

    // 1) DB cache check
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
        ),
        false
      );
    }

    const cachedRaw = user?.skr_name ? String(user.skr_name).trim() : "";

    // ✅ If we see legacy sentinel in DB, auto-clean it to NULL (best-effort)
    if (user?.wallet && cachedRaw === LEGACY_NONE) {
      // Fire-and-forget: don't block response (no .then/.catch -> no TS underline)
      void supabaseAdmin
        .from("users")
        .update({ skr_name: null })
        .eq("wallet", wallet);
    }

    // ✅ Trust only real .skr values
    const cachedLooksValid =
      !!cachedRaw &&
      cachedRaw !== LEGACY_NONE &&
      cachedRaw.toLowerCase().endsWith(".skr");

    if (cachedLooksValid) {
      return withCacheHeaders(
        NextResponse.json({
          ok: true,
          wallet,
          name: cachedRaw,
          cached: true,
          source: "db_cache",
        }),
        true
      );
    }

    // 2) Resolve from chain (slow path)
    const resolved = await resolveNameForWallet(wallet);
    const cleaned =
      resolved && String(resolved).trim() ? String(resolved).trim() : null;

    const finalName =
      cleaned && cleaned.toLowerCase().endsWith(".skr") ? cleaned : null;

    // 3) Cache ONLY real .skr names (never write __NONE__)
    if (user?.wallet && finalName) {
      await supabaseAdmin
        .from("users")
        .update({ skr_name: finalName })
        .eq("wallet", wallet);
    }

    return withCacheHeaders(
      NextResponse.json({
        ok: true,
        wallet,
        name: finalName,
        cached: false,
        source: finalName ? "onchain" : "none",
        note: finalName
          ? undefined
          : "No main .skr set (and no owned .skr found). User may need to set a main domain in AllDomains.",
      }),
      !!finalName
    );
  } catch (e: any) {
    console.error("resolve-name error:", e);
    return withCacheHeaders(
      NextResponse.json(
        {
          ok: false,
          error: "Internal server error",
          detail: String(e?.message || e),
        },
        { status: 500 }
      ),
      false
    );
  }
}