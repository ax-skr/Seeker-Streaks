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

type Pair = [wallet: string, name: string | null];

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

function cacheShort(res: NextResponse) {
  res.headers.set(
    "Cache-Control",
    "public, max-age=0, s-maxage=30, stale-while-revalidate=120"
  );
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
    return `${md.domain}${md.tld}`;
  } catch {
    return null;
  }
}

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

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  let i = 0;
  const results: R[] = new Array(items.length) as any;
  const runners = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    const wallets: string[] = (Array.isArray(body?.wallets) ? body.wallets : [])
      .map((w: unknown) => String(w ?? "").trim())
      .filter((w: string) => w.length > 0);

    if (wallets.length === 0) {
      return cacheShort(
        NextResponse.json({ ok: false, error: "wallets required" }, { status: 400 })
      );
    }

    // 1) Pull cached domains + timestamps in one query
    const { data: cachedRows, error: selErr } = await supabaseAdmin
      .from("users")
      .select(
        "wallet, main_domain, main_domain_updated_at, skr_name, skr_name_updated_at"
      )
      .in("wallet", wallets);

    if (selErr) {
      return cacheShort(
        NextResponse.json({ ok: false, error: selErr.message }, { status: 500 })
      );
    }

    const out: Record<string, string | null> = {};
    const cachedFreshSet = new Set<string>();

    for (const r of cachedRows ?? []) {
      const w = String((r as any).wallet ?? "");
      if (!w) continue;

      const cachedMain = looksLikeDomain((r as any).main_domain);
      const cachedSkr = looksLikeSkr((r as any).skr_name);

      const tMain = parseTsMs((r as any).main_domain_updated_at);
      const tSkr = parseTsMs((r as any).skr_name_updated_at);
      const lastCheckMs = Math.max(tMain, tSkr);

      const fresh = lastCheckMs > 0 && Date.now() - lastCheckMs < TTL_MS;

      if (fresh) {
        cachedFreshSet.add(w);
        out[w] = cachedSkr || cachedMain || null; // display name
      }
    }

    // 2) Resolve missing/stale wallets only
    const missing: string[] = wallets.filter((wallet) => !cachedFreshSet.has(wallet));

    const resolved: Pair[] = await runWithConcurrency<string, Pair>(
      missing,
      6,
      async (wallet): Promise<Pair> => {
        const resolvedMain = looksLikeDomain(await resolveMainDomain(wallet));

        const resolvedSkr =
          (resolvedMain && resolvedMain.toLowerCase().endsWith(".skr") ? resolvedMain : null) ||
          looksLikeSkr(await resolveFallbackSkrDomain(wallet));

        const nowIso = new Date().toISOString();

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
        return [wallet, display];
      }
    );

    for (const [wallet, name] of resolved) out[wallet] = name;

    return cacheShort(NextResponse.json({ ok: true, names: out }));
  } catch (e: any) {
    return cacheShort(
      NextResponse.json(
        { ok: false, error: "Internal server error", detail: String(e?.message || e) },
        { status: 500 }
      )
    );
  }
}