"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";

type Row = {
  wallet: string;
  points?: number;
  streak?: number;
  name?: string | null; // .skr name
  rank?: number;
};

function shortWallet(w: string) {
  if (!w) return "";
  return w.length <= 10 ? w : `${w.slice(0, 4)}…${w.slice(-4)}`;
}

async function safeJson(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `API did not return JSON. Got: ${contentType || "unknown"}\n` +
        `First chars: ${text.slice(0, 80)}`
    );
  }
  return res.json();
}

type CacheEntry = { value: string | null; expiresAt: number };

export default function LeaderboardPage() {
  const { publicKey, connected } = useWallet();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [myRow, setMyRow] = useState<Row | null>(null);
  const [myLoading, setMyLoading] = useState(false);

  const baseUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);

  const myWallet = useMemo(() => publicKey?.toBase58() ?? null, [publicKey]);

  // Local in-memory cache to avoid re-resolving during same page session
  // (backend now also caches with 24h TTL, but this makes UI extra safe)
  const nameCache = useRef<Map<string, CacheEntry>>(new Map());

  // Prevent duplicate in-flight batch resolves + cancel stale background tasks
  const loadSeq = useRef(0);
  const inflightWallets = useRef<Set<string>>(new Set());

  function getCachedName(wallet: string): string | null | undefined {
    const entry = nameCache.current.get(wallet);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      nameCache.current.delete(wallet);
      return undefined;
    }
    return entry.value;
  }

  function setCachedName(wallet: string, value: string | null) {
    // If name exists: cache 24h. If null: cache 24h as well (backend TTL should handle "none" too)
    // Keeping it 24h prevents client from re-hammering even if user refreshes quickly.
    const ttlMs = 24 * 60 * 60 * 1000;
    nameCache.current.set(wallet, { value, expiresAt: Date.now() + ttlMs });
  }

  function normalizeName(v: unknown): string | null {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return null;
    return s.toLowerCase().endsWith(".skr") ? s : null;
  }

  async function resolveNamesBatch(wallets: string[], seq: number) {
    const unique = Array.from(new Set(wallets)).filter(Boolean);

    // filter out ones we already have cached or are already in-flight
    const toFetch: string[] = [];
    for (const w of unique) {
      if (getCachedName(w) !== undefined) continue;
      if (inflightWallets.current.has(w)) continue;
      inflightWallets.current.add(w);
      toFetch.push(w);
    }

    if (toFetch.length === 0) return;

    try {
      const res = await fetch(`${baseUrl}/api/resolve-name-batch`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ wallets: toFetch }),
      });

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      const names: Record<string, string | null> =
        (data?.names && typeof data.names === "object" ? data.names : {}) as any;

      // Cache results
      for (const w of toFetch) {
        const n = normalizeName(names?.[w]);
        setCachedName(w, n);
      }

      // If a new load happened, don't apply
      if (loadSeq.current !== seq) return;

      // Apply to rows + myRow if present
      setRows((prev) =>
        prev.map((r) => {
          const existing = normalizeName(r.name);
          if (existing) return r;

          const cached = getCachedName(r.wallet);
          if (cached === undefined) return r;
          return { ...r, name: cached };
        })
      );

      setMyRow((prev) => {
        if (!prev) return prev;
        const existing = normalizeName(prev.name);
        if (existing) return prev;
        const cached = getCachedName(prev.wallet);
        if (cached === undefined) return prev;
        return { ...prev, name: cached };
      });
    } catch (e) {
      // IMPORTANT: no retry loops here. If resolver is rate-limited, we just skip.
      // Backend TTL + next refresh will handle it.
      console.warn("resolve-name-batch failed:", e);
    } finally {
      for (const w of toFetch) inflightWallets.current.delete(w);
    }
  }

  async function load() {
    setLoading(true);
    setErr(null);

    const seq = ++loadSeq.current;

    try {
      const res = await fetch(`${baseUrl}/api/leaderboard`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      const raw: any[] = Array.isArray(data?.rows)
        ? data.rows
        : Array.isArray(data)
        ? data
        : [];

      const normalized: Row[] = raw.map((r: any, i: number) => {
        const wallet = String(r.wallet ?? "");
        const dbName = normalizeName(r.name);

        // Prime local cache with DB names so we NEVER resolve them again client-side
        if (wallet && dbName) setCachedName(wallet, dbName);

        return {
          wallet,
          points: Number(r.points ?? 0),
          streak: Number(r.streak ?? 0),
          rank: Number(r.rank ?? i + 1),
          name: dbName,
        };
      });

      const top100 = normalized.slice(0, 100);

      // FAST render
      setRows(top100);
      setLoading(false);

      // Background: resolve ONLY wallets missing name (ONE batch call)
      const missingWallets = top100
        .filter((r) => !normalizeName(r.name) && r.wallet)
        .map((r) => r.wallet);

      if (missingWallets.length > 0) {
        void resolveNamesBatch(missingWallets, seq);
      }
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Failed to load leaderboard");
      setRows([]);
      setLoading(false);
    }
  }

  async function loadMyRank() {
    if (!myWallet) {
      setMyRow(null);
      return;
    }

    setMyLoading(true);
    const seq = loadSeq.current;

    try {
      const res = await fetch(
        `${baseUrl}/api/leaderboard?wallet=${encodeURIComponent(myWallet)}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }
      );

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      const me = data?.me as any;
      if (!me?.wallet) {
        setMyRow(null);
        return;
      }

      const wallet = String(me.wallet);
      const dbName = normalizeName(me?.name);

      if (wallet && dbName) setCachedName(wallet, dbName);

      setMyRow({
        wallet,
        points: Number(me.points ?? 0),
        streak: Number(me.streak ?? 0),
        rank: typeof me.rank === "number" ? Number(me.rank) : undefined,
        name: dbName,
      });

      // If my name missing, resolve via batch (single wallet) — no retries
      if (!dbName && wallet) {
        void resolveNamesBatch([wallet], seq);
      }
    } catch {
      setMyRow(null);
    } finally {
      setMyLoading(false);
    }
  }

  useEffect(() => {
    if (!baseUrl) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  useEffect(() => {
    if (!baseUrl) return;
    loadMyRank();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myWallet, baseUrl]);

  const myInTop100 = useMemo(() => {
    if (!myWallet) return false;
    return rows.some((r) => r.wallet === myWallet);
  }, [rows, myWallet]);

  return (
    <div style={styles.shell}>
      <div style={styles.card}>
        <div style={styles.headerRow}>
          <div>
            <div style={styles.title}>Leaderboard</div>

            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                fontWeight: 900,
                letterSpacing: 0.8,
                opacity: 0.9,
                textTransform: "uppercase",
              }}
            >
              Phase 1 — Founders Era
            </div>

            <div style={styles.sub}>
              Ranked by <span style={styles.badge}>longest streak</span>, then
              total points
            </div>
          </div>

          <div style={styles.actions}>
            <button
              onClick={() => {
                load();
                loadMyRank();
              }}
              style={styles.btnSecondary}
            >
              Refresh
            </button>
            <Link href="/" style={styles.btnPrimary as any}>
              Back
            </Link>
          </div>
        </div>

        {loading && (
          <div style={styles.loadingBox}>
            <div style={styles.spinner} />
            <div>Loading leaderboard…</div>
          </div>
        )}

        {!loading && err && (
          <div style={styles.errorBox}>
            <div style={styles.errorTitle}>Couldn’t load leaderboard</div>
            <div style={styles.errorText}>{err}</div>
            <div style={{ marginTop: 12 }}>
              <button onClick={load} style={styles.btnSecondary}>
                Try again
              </button>
            </div>
          </div>
        )}

        {!loading && !err && rows.length === 0 && (
          <div style={styles.emptyBox}>
            No entries yet. Verify + check in, then refresh.
          </div>
        )}

        {!loading && !err && rows.length > 0 && (
          <div style={styles.tableWrap} className="lbWrap">
            <div style={styles.tableHead} className="lbHead">
              <div style={styles.colRank}>#</div>
              <div style={styles.colName}>User</div>
              <div style={styles.colPoints}>Points</div>
              <div style={styles.colStreak}>Streak</div>
            </div>

            <div style={styles.tableBody}>
              {rows.map((r, idx) => {
                const display =
                  (normalizeName(r.name) || getCachedName(r.wallet) || "").trim() ||
                  shortWallet(r.wallet);

                const showSkr = display.toLowerCase().endsWith(".skr");

                return (
                  <div
                    key={`${r.wallet}-${idx}`}
                    style={styles.row}
                    className="lbRow"
                  >
                    <div style={styles.colRank}>
                      <span style={styles.rankPill}>{r.rank ?? idx + 1}</span>
                    </div>

                    <div style={styles.colName}>
                      <div style={styles.userLine}>
                        <span
                          className="lbUserName"
                          style={showSkr ? styles.userName : styles.userNameSingle}
                          title={display}
                        >
                          {display}
                          {showSkr && <span style={styles.skrGlow}> •</span>}
                        </span>
                      </div>
                      <div className="lbWalletLine" style={styles.walletLine}>
                        {shortWallet(r.wallet)}
                      </div>
                    </div>

                    <div style={styles.colPoints}>
                      <div style={styles.statNum}>{Number(r.points ?? 0)}</div>
                      <div style={styles.statLabel}>Points</div>
                    </div>

                    <div style={styles.colStreak}>
                      <div style={styles.statNum}>{Number(r.streak ?? 0)}</div>
                      <div style={styles.statLabel}>Streak</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={styles.footerNote}>
              Only verified and locked in 👀 users show here.
            </div>
          </div>
        )}

        {!loading && !err && connected && myWallet && !myInTop100 && (
          <div
            style={{
              marginTop: 14,
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.04)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 12px",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                fontWeight: 900,
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                opacity: 0.9,
              }}
            >
              Your position
            </div>

            {myLoading ? (
              <div
                style={{
                  padding: 14,
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <div style={styles.spinner} />
                <div>Loading your rank…</div>
              </div>
            ) : myRow ? (
              <div
                style={{
                  ...styles.row,
                  gridTemplateColumns: "70px 1fr 110px 110px",
                  borderTop: "none",
                  background: "rgba(0,0,0,0.12)",
                }}
                className="lbRow"
              >
                <div style={styles.colRank}>
                  <span style={styles.rankPill}>
                    {typeof myRow.rank === "number" ? myRow.rank : "—"}
                  </span>
                </div>

                <div style={styles.colName}>
                  <div style={styles.userLine}>
                    {(() => {
                      const display =
                        (normalizeName(myRow.name) ||
                          getCachedName(myRow.wallet) ||
                          "").trim() || shortWallet(myRow.wallet);

                      const showSkr = display.toLowerCase().endsWith(".skr");
                      return (
                        <span
                          className="lbUserName"
                          style={showSkr ? styles.userName : styles.userNameSingle}
                          title={display}
                        >
                          {display}
                          {showSkr && <span style={styles.skrGlow}> •</span>}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="lbWalletLine" style={styles.walletLine}>
                    {shortWallet(myRow.wallet)}
                  </div>
                </div>

                <div style={styles.colPoints}>
                  <div style={styles.statNum}>{Number(myRow.points ?? 0)}</div>
                  <div style={styles.statLabel}>Points</div>
                </div>

                <div style={styles.colStreak}>
                  <div style={styles.statNum}>{Number(myRow.streak ?? 0)}</div>
                  <div style={styles.statLabel}>Streak</div>
                </div>
              </div>
            ) : (
              <div style={{ padding: 14, opacity: 0.85, fontSize: 13 }}>
                Couldn’t load your rank right now.
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        .lbRow > div:nth-child(2),
        .lbHead > div:nth-child(2) {
          min-width: 0;
        }

        @media (max-width: 520px) {
          .lbHead, .lbRow {
            grid-template-columns: 58px 1fr 74px 74px !important;
          }
          .lbWrap {
            overflow-x: hidden !important;
          }
          .lbRow .lbUserName {
            font-size: 13px !important;
            letter-spacing: 0.1px !important;
          }
          .lbRow .lbWalletLine {
            font-size: 11px !important;
          }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: "100vh",
    background:
      "radial-gradient(1000px 600px at 15% 10%, rgba(0,255,163,0.14), transparent 60%)," +
      "radial-gradient(800px 500px at 85% 20%, rgba(102,102,255,0.18), transparent 60%)," +
      "linear-gradient(180deg, #05060a 0%, #070816 40%, #05060a 100%)",
    display: "flex",
    justifyContent: "center",
    padding: "28px 14px",
    color: "#EAEAF2",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  },
  card: {
    width: "min(980px, 100%)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 18,
    background: "rgba(10, 12, 22, 0.72)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
    padding: 18,
    backdropFilter: "blur(10px)",
  },
  headerRow: {
    display: "flex",
    gap: 16,
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    marginBottom: 14,
  },
  title: {
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: 0.2,
  },
  sub: {
    marginTop: 4,
    fontSize: 13,
    opacity: 0.8,
  },
  badge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 999,
    border: "1px solid rgba(0,255,163,0.35)",
    background: "rgba(0,255,163,0.08)",
    color: "rgba(210,255,240,1)",
    fontWeight: 700,
  },
  actions: {
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  btnPrimary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(0,255,163,0.45)",
    background:
      "linear-gradient(90deg, rgba(0,255,163,0.18), rgba(102,102,255,0.12))",
    color: "#EFFFF9",
    fontWeight: 800,
    textDecoration: "none",
  },
  btnSecondary: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#EAEAF2",
    fontWeight: 700,
    cursor: "pointer",
  },
  loadingBox: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    padding: 14,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
  },
  spinner: {
    width: 16,
    height: 16,
    borderRadius: 999,
    border: "2px solid rgba(255,255,255,0.25)",
    borderTop: "2px solid rgba(0,255,163,0.9)",
    animation: "spin 0.9s linear infinite",
  },
  errorBox: {
    padding: 14,
    borderRadius: 14,
    border: "1px solid rgba(255,90,90,0.35)",
    background: "rgba(255,90,90,0.08)",
  },
  errorTitle: { fontWeight: 900, marginBottom: 6 },
  errorText: { opacity: 0.9, fontSize: 13, whiteSpace: "pre-wrap" },
  emptyBox: {
    padding: 14,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    opacity: 0.9,
  },
  tableWrap: {
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.10)",
    overflow: "hidden",
  },
  tableHead: {
    display: "grid",
    gridTemplateColumns: "70px 1fr 110px 110px",
    gap: 0,
    padding: "12px 12px",
    background: "rgba(255,255,255,0.04)",
    fontWeight: 900,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  tableBody: {
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "70px 1fr 110px 110px",
    padding: "12px 12px",
    borderTop: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(0,0,0,0.14)",
  },
  colRank: { display: "flex", alignItems: "center" },
  colName: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    justifyContent: "center",
  },
  colPoints: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    justifyContent: "center",
  },
  colStreak: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    justifyContent: "center",
  },
  rankPill: {
    display: "inline-flex",
    minWidth: 44,
    justifyContent: "center",
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(102,102,255,0.30)",
    background: "rgba(102,102,255,0.10)",
    fontWeight: 900,
  },
  userLine: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },

  // 2-line clamp for long .skr usernames
  userName: {
    fontWeight: 900,
    letterSpacing: 0.2,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    whiteSpace: "normal",
    wordBreak: "break-word",
    lineHeight: 1.15,
  },

  // Keep non-.skr (wallet short) single line
  userNameSingle: {
    fontWeight: 900,
    letterSpacing: 0.2,
    display: "block",
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  skrGlow: {
    color: "rgba(0,255,163,0.95)",
    textShadow: "0 0 12px rgba(0,255,163,0.45)",
    marginLeft: 6,
  },
  walletLine: { fontSize: 12, opacity: 0.7, marginTop: 2 },
  statNum: { fontWeight: 900, fontSize: 16 },
  statLabel: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  footerNote: {
    padding: 12,
    fontSize: 12,
    opacity: 0.7,
    borderTop: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(255,255,255,0.03)",
  },
};