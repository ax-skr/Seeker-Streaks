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

  // cache to avoid re-resolving names
  const nameCache = useRef<Map<string, string | null>>(new Map());

  async function resolveName(wallet: string): Promise<string | null> {
    if (!wallet) return null;
    if (nameCache.current.has(wallet))
      return nameCache.current.get(wallet) ?? null;

    // Try POST first (most common)
    try {
      const res = await fetch(`${baseUrl}/api/resolve-name`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ wallet }),
        cache: "no-store",
      });

      const data = await safeJson(res);
      const name =
        (data?.name ??
          data?.skr ??
          data?.username ??
          data?.displayName ??
          null) as string | null;

      const cleaned = name && String(name).trim() ? String(name).trim() : null;
      nameCache.current.set(wallet, cleaned);
      return cleaned;
    } catch {
      // fallback GET if your route uses querystring
      try {
        const res2 = await fetch(
          `${baseUrl}/api/resolve-name?wallet=${encodeURIComponent(wallet)}`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          }
        );

        const data2 = await safeJson(res2);
        const name2 =
          (data2?.name ??
            data2?.skr ??
            data2?.username ??
            data2?.displayName ??
            null) as string | null;

        const cleaned2 =
          name2 && String(name2).trim() ? String(name2).trim() : null;
        nameCache.current.set(wallet, cleaned2);
        return cleaned2;
      } catch {
        nameCache.current.set(wallet, null);
        return null;
      }
    }
  }

  async function load() {
    setLoading(true);
    setErr(null);

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

      const normalized: Row[] = raw.map((r: any, i: number) => ({
        wallet: String(r.wallet ?? ""),
        points: Number(r.points ?? 0),
        streak: Number(r.streak ?? 0),
        rank: Number(r.rank ?? i + 1),
        name: null,
      }));

      // ✅ Only show top 100
      const top100 = normalized.slice(0, 100);
      setRows(top100);

      // Resolve .skr names (non-blocking) for top 100 only
      const resolved = await Promise.all(
        top100.map(async (r) => {
          const n = await resolveName(r.wallet);
          return { ...r, name: n };
        })
      );
      setRows(resolved);
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Failed to load leaderboard");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadMyRank() {
    if (!myWallet) {
      setMyRow(null);
      return;
    }

    setMyLoading(true);
    try {
      // Try to find my row from the same leaderboard payload (no new API required)
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

      const normalized: Row[] = raw.map((r: any, i: number) => ({
        wallet: String(r.wallet ?? ""),
        points: Number(r.points ?? 0),
        streak: Number(r.streak ?? 0),
        rank: Number(r.rank ?? i + 1),
        name: null,
      }));

      const mine = normalized.find(
        (r) => r.wallet && r.wallet === myWallet
      );

      if (!mine) {
        setMyRow({
          wallet: myWallet,
          points: 0,
          streak: 0,
          rank: undefined,
          name: null,
        });
        return;
      }

      const n = await resolveName(mine.wallet);
      setMyRow({ ...mine, name: n });
    } catch {
      // If this fails, we just don't show the bottom card.
      setMyRow(null);
    } finally {
      setMyLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  useEffect(() => {
    // load user's row when they connect / change wallet
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

            {/* ✅ Add this line */}
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
                  (r.name && r.name.trim()) || // prefer .skr
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
                        <span style={styles.userName}>
                          {display}
                          {showSkr && <span style={styles.skrGlow}> •</span>}
                        </span>
                      </div>
                      <div style={styles.walletLine}>{shortWallet(r.wallet)}</div>
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

        {/* ✅ Show connected user's rank at bottom if not in top 100 */}
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
              <div style={{ padding: 14, display: "flex", gap: 12, alignItems: "center" }}>
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
              >
                <div style={styles.colRank}>
                  <span style={styles.rankPill}>
                    {myRow.rank ? myRow.rank : "—"}
                  </span>
                </div>

                <div style={styles.colName}>
                  <div style={styles.userLine}>
                    <span style={styles.userName}>
                      {(myRow.name && myRow.name.trim()) || shortWallet(myRow.wallet)}
                      {((myRow.name && myRow.name.trim()) || "")
                        .toLowerCase()
                        .endsWith(".skr") && <span style={styles.skrGlow}> •</span>}
                    </span>
                  </div>
                  <div style={styles.walletLine}>{shortWallet(myRow.wallet)}</div>
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

      {/* CSS for spinner + mobile smoothing */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        /* Mobile: stop the table feeling “clipped” */
        @media (max-width: 520px) {
          .lbHead, .lbRow {
            grid-template-columns: 58px 1fr 86px 86px !important;
          }
          .lbWrap {
            overflow-x: hidden !important;
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
  colName: { display: "flex", flexDirection: "column", justifyContent: "center" },
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
  userLine: { display: "flex", alignItems: "center", gap: 10 },
  userName: { fontWeight: 900, letterSpacing: 0.2 },
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
