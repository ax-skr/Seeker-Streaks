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

async function resolveName(wallet: string): Promise<string | null> {
  const main = await resolveMainDomain(wallet);
  if (main) return main;
  return resolveFallbackSkrDomain(wallet);
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

    // 1) Pull cached names + timestamps from DB in one query
    const { data: cachedRows, error: selErr } = await supabaseAdmin
      .from("users")
      .select("wallet, skr_name, skr_name_updated_at")
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

      const nRaw = (r as any).skr_name ? String((r as any).skr_name).trim() : "";
      const name =
        nRaw && nRaw.toLowerCase().endsWith(".skr") ? nRaw : null;

      const tMs = parseTsMs((r as any).skr_name_updated_at);
      const fresh = tMs > 0 && Date.now() - tMs < TTL_MS;

      // If fresh, we treat it as cached (even if name is null)
      if (fresh) {
        cachedFreshSet.add(w);
        out[w] = name;
      }
    }

    // 2) Resolve missing/stale wallets only
    const missing: string[] = wallets.filter((wallet) => !cachedFreshSet.has(wallet));

    const resolved: Pair[] = await runWithConcurrency<string, Pair>(
      missing,
      6,
      async (wallet): Promise<Pair> => {
        const name = await resolveName(wallet);
        const cleaned = name && String(name).trim() ? String(name).trim() : null;
        const finalName =
          cleaned && cleaned.toLowerCase().endsWith(".skr") ? cleaned : null;

        // Upsert and ALWAYS update last-checked timestamp (even if null)
        await supabaseAdmin
          .from("users")
          .upsert(
            {
              wallet,
              skr_name: finalName,
              skr_name_updated_at: new Date().toISOString(),
            },
            { onConflict: "wallet" }
          );

        return [wallet, finalName];
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