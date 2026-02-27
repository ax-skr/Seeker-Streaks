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

function todayUTCISO(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function isSameUtcDay(tsMs: number, yyyyMmDd: string): boolean {
  if (!tsMs) return false;
  const d = new Date(tsMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` === yyyyMmDd;
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
      // return 200 to avoid “error” rows in Vercel logs
      return cacheShort(NextResponse.json({ ok: false, error: "wallets required" }));
    }

    const today = todayUTCISO();

    // 1) Pull cached domains + timestamps in one query
    const { data: cachedRows, error: selErr } = await supabaseAdmin
      .from("users")
      .select("wallet, main_domain, main_domain_updated_at, skr_name, skr_name_updated_at")
      .in("wallet", wallets);

    if (selErr) {
      // return 200 to avoid “error” rows in Vercel logs
      return cacheShort(NextResponse.json({ ok: false, error: selErr.message }));
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

      // ✅ NEW: “fresh” means updated today (UTC), not “within 24h”
      const fresh = lastCheckMs > 0 && isSameUtcDay(lastCheckMs, today);

      if (fresh) {
        cachedFreshSet.add(w);
        out[w] = cachedSkr || cachedMain || null; // display name
      }
    }

    // 2) Resolve missing/stale wallets only
    const missing: string[] = wallets.filter((wallet) => !cachedFreshSet.has(wallet));
    if (missing.length === 0) {
      return cacheShort(NextResponse.json({ ok: true, names: out }));
    }

    // ✅ NEW: acquire per-wallet-per-day locks so we only resolve each wallet once per UTC day
    const lockRows = Array.from(new Set(missing)).map((wallet) => ({
      wallet,
      day: today, // date string is fine; Supabase will cast
    }));

    const { data: lockWins, error: lockErr } = await supabaseAdmin
      .from("skr_name_refresh_locks")
      .upsert(lockRows, { onConflict: "wallet,day", ignoreDuplicates: true })
      .select("wallet");

    if (lockErr) {
      // Fail open: just return what we already have cached (don’t stampede RPC)
      return cacheShort(NextResponse.json({ ok: true, names: out }));
    }

    const canResolve = new Set<string>((lockWins ?? []).map((r: any) => String(r.wallet)));

    // 3) Resolve ONLY wallets we won locks for
    const toResolve = missing.filter((w) => canResolve.has(w));
    if (toResolve.length === 0) {
      // Nobody won locks in this request -> return cached; other request is refreshing
      return cacheShort(NextResponse.json({ ok: true, names: out }));
    }

    const resolved: Pair[] = await runWithConcurrency<string, Pair>(
      toResolve,
      6,
      async (wallet): Promise<Pair> => {
        const resolvedMain = looksLikeDomain(await resolveMainDomain(wallet));

        const resolvedSkr =
          (resolvedMain && resolvedMain.toLowerCase().endsWith(".skr") ? resolvedMain : null) ||
          looksLikeSkr(await resolveFallbackSkrDomain(wallet));

        const nowIso = new Date().toISOString();

        // write back cache
        await supabaseAdmin.from("users").upsert(
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

    // NOTE: wallets that were missing but didn’t win the lock will stay as undefined in `out`.
    // That’s fine: your client normalizeName() will keep showing shortWallet until next refresh.
    // If you want explicit nulls, uncomment this:
    // for (const w of missing) if (!(w in out)) out[w] = null;

    return cacheShort(NextResponse.json({ ok: true, names: out }));
  } catch (e: any) {
    // return 200 to avoid “error” rows in Vercel logs
    return cacheShort(
      NextResponse.json({
        ok: false,
        error: "Internal server error",
        detail: String(e?.message || e),
      })
    );
  }
}