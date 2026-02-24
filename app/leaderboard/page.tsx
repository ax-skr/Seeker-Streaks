"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";

type Row = {
  wallet: string;
  points?: number;
  streak?: number;
  name?: string | null; // main domain (any TLD)
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
    const ttlMs = 24 * 60 * 60 * 1000;
    nameCache.current.set(wallet, { value, expiresAt: Date.now() + ttlMs });
  }

  // MAIN DOMAIN NORMALIZATION (Option B)
  function normalizeName(v: unknown): string | null {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return null;
    if (!s.includes(".")) return null; // accept any "name.tld"
    if (s.length > 80) return null; // prevent layout abuse
    return s;
  }

  function isSkrDisplay(display: string) {
    return display.toLowerCase().endsWith(".skr");
  }

  async function resolveNamesBatch(wallets: string[], seq: number) {
    const unique = Array.from(new Set(wallets)).filter(Boolean);

    const toFetch: string[] = [];
    for (const w of unique) {
      if (getCachedName(w) !== undefined) continue;
      if (inflightWallets.current.has(w)) continue;
      inflightWallets.current.add(w);
      toFetch.push(w);
    }

    if (toFetch.length === 0) return;

    try {
      const res = await fetch(`${baseUrl}/api/resolve-names-batch`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ wallets: toFetch }),
      });

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      const names: Record<string, string | null> =
        (data?.names && typeof data.names === "object" ? data.names : {}) as any;

      for (const w of toFetch) {
        const n = normalizeName(names?.[w]);
        setCachedName(w, n);
      }

      if (loadSeq.current !== seq) return;

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
      console.warn("resolve-names-batch failed:", e);
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

      setRows(top100);
      setLoading(false);

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
    <div className="lbShell" style={styles.shell}>
      <div style={styles.card} className="lbCard">
        <div style={styles.headerRow}>
          <div>
            <div style={styles.title}>Leaderboard</div>

            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                fontWeight: 900,
                letterSpacing: 0.9,
                opacity: 0.92,
                textTransform: "uppercase",
              }}
            >
              Phase 1 — Founders Era
            </div>

            <div style={styles.sub}>
              Ranked by <span style={styles.badge}>longest streak</span>, then total
              points
            </div>
          </div>

          <div style={styles.actions}>
            <button
              onClick={() => {
                load();
                loadMyRank();
              }}
              style={styles.btnSecondary}
              className="lbBtn lbBtnSecondary"
            >
              Refresh
            </button>
            <Link href="/" style={styles.btnPrimary as any} className="lbBtn lbBtnPrimary">
              Back
            </Link>
          </div>
        </div>

        {loading && (
          <div style={styles.loadingBox} className="lbGlass">
            <div style={styles.spinner} />
            <div>Loading leaderboard…</div>
          </div>
        )}

        {!loading && err && (
          <div style={styles.errorBox} className="lbGlassDanger">
            <div style={styles.errorTitle}>Couldn’t load leaderboard</div>
            <div style={styles.errorText}>{err}</div>
            <div style={{ marginTop: 12 }}>
              <button onClick={load} style={styles.btnSecondary} className="lbBtn lbBtnSecondary">
                Try again
              </button>
            </div>
          </div>
        )}

        {!loading && !err && rows.length === 0 && (
          <div style={styles.emptyBox} className="lbGlass">
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

                const showSkr = isSkrDisplay(display);
                const isMe = !!myWallet && r.wallet === myWallet && connected;

                return (
                  <div
                    key={`${r.wallet}-${idx}`}
                    style={{
                      ...styles.row,
                      ...(showSkr ? styles.rowSkrGlow : null),
                      ...(isMe ? styles.rowMePop : null),
                    }}
                    className={`lbRow ${showSkr ? "lbRowSkr" : ""} ${isMe ? "lbRowMe" : ""}`}
                  >
                    <div style={styles.colRank}>
                      <span style={{ ...styles.rankPill, ...(isMe ? styles.rankPillMe : null) }}>
                        {r.rank ?? idx + 1}
                      </span>
                    </div>

                    <div style={styles.colName}>
                      <div style={styles.userLine}>
                        <span
                          className="lbUserName"
                          style={
                            isMe
                              ? styles.userNameMe
                              : showSkr
                              ? styles.userName
                              : styles.userNameSingle
                          }
                          title={display}
                        >
                          {display}
                        </span>

                        {isMe && (
                          <span style={styles.mePill} className="lbMePill">
                            YOU
                          </span>
                        )}
                      </div>

                      <div
                        className="lbWalletLine"
                        style={isMe ? styles.walletLineMe : styles.walletLine}
                      >
                        {shortWallet(r.wallet)}
                      </div>
                    </div>

                    <div style={styles.colPoints}>
                      <div style={isMe ? styles.statNumMe : styles.statNum}>
                        {Number(r.points ?? 0)}
                      </div>
                      <div style={styles.statLabel}>Points</div>
                    </div>

                    <div style={styles.colStreak}>
                      <div style={isMe ? styles.statNumMe : styles.statNum}>
                        {Number(r.streak ?? 0)}
                      </div>
                      <div style={styles.statLabel}>Streak</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={styles.footerNote} className="lbFooterNote">
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
            className="lbGlass"
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
              (() => {
                const display =
                  (normalizeName(myRow.name) || getCachedName(myRow.wallet) || "").trim() ||
                  shortWallet(myRow.wallet);

                const showSkr = isSkrDisplay(display);

                return (
                  <div
                    style={{
                      ...styles.row,
                      gridTemplateColumns: "70px 1fr 110px 110px",
                      borderTop: "none",
                      background: "rgba(0,0,0,0.18)",
                      ...(showSkr ? styles.rowSkrGlow : null),
                    }}
                    className={`lbRow ${showSkr ? "lbRowSkr" : ""}`}
                  >
                    <div style={styles.colRank}>
                      <span style={styles.rankPill}>
                        {typeof myRow.rank === "number" ? myRow.rank : "—"}
                      </span>
                    </div>

                    <div style={styles.colName}>
                      <div style={styles.userLine}>
                        <span
                          className="lbUserName"
                          style={showSkr ? styles.userName : styles.userNameSingle}
                          title={display}
                        >
                          {display}
                        </span>
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
                );
              })()
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

        /* Clean pulse: brightness only (no blobby shadow) */
        @keyframes mePulse {
          0%   { filter: brightness(1); }
          50%  { filter: brightness(1.05); }
          100% { filter: brightness(1); }
        }

        /* Slow drift / parallax vibe (background-position only: cheap to run) */
        @keyframes cosmicDrift {
          0%   { background-position: 0 0, 0 0, 0 0, center top, 0 0, 40px 60px, 0 0; }
          50%  { background-position: 20px -14px, -18px 10px, 12px 16px, center top, 14px 10px, 52px 74px, 0 0; }
          100% { background-position: 0 0, 0 0, 0 0, center top, 0 0, 40px 60px, 0 0; }
        }

        .lbShell { position: relative; overflow: hidden; }

        .lbShell::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;

          background-image:
            radial-gradient(900px 520px at 18% 22%, rgba(0,255,163,0.18), transparent 62%),
            radial-gradient(900px 520px at 82% 18%, rgba(120,120,255,0.20), transparent 62%),
            radial-gradient(900px 520px at 68% 80%, rgba(170, 80, 255, 0.16), transparent 60%),
            url("/leaderboard-cosmic.png"),
            radial-gradient(rgba(255,255,255,0.20) 1px, transparent 1px),
            radial-gradient(rgba(255,255,255,0.12) 1px, transparent 1px),
            linear-gradient(180deg, #04050a 0%, #070816 45%, #04050a 100%);

          /* === make image less zoomed + sharper === */
          background-size:
            auto,
            auto,
            auto,
            min(1400px, 120vw) auto,
            120px 120px,
            220px 220px,
            auto;

          background-position:
            0 0,
            0 0,
            0 0,
            center top,
            0 0,
            40px 60px,
            0 0;

          background-repeat:
            no-repeat,
            no-repeat,
            no-repeat,
            no-repeat,
            repeat,
            repeat,
            no-repeat;

          image-rendering: auto;
          filter: saturate(1.08) contrast(1.10) brightness(1.03);
          opacity: 1;

          animation: cosmicDrift 34s ease-in-out infinite;
          will-change: background-position;
          transform: translateZ(0);
        }

        /* subtle grain */
        .lbShell::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image: radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px);
          background-size: 3px 3px;
          opacity: 0.10;
          mix-blend-mode: overlay;
        }

        /* Keep the center card crisp against the cosmic edges */
        .lbCard { box-shadow: 0 22px 80px rgba(0,0,0,0.68); }

        /* Glass helpers */
        .lbGlass {
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .lbGlassDanger {
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }

        /* Buttons */
        .lbBtn {
          transition: transform 120ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease;
          will-change: transform;
        }
        .lbBtn:hover { transform: translateY(-1px); }
        .lbBtn:active { transform: translateY(0px) scale(0.99); }

        /* Rows */
        .lbRow {
          transition: transform 160ms ease, box-shadow 180ms ease, border-color 180ms ease, background 180ms ease;
          position: relative;
        }
        .lbRow:hover {
          transform: translateY(-1px);
          box-shadow: 0 12px 30px rgba(0,0,0,0.28);
        }

        /* === Connected wallet row: CLEAN pop (no scale, no spacing changes) === */
        .lbRowMe {
          transform: translateY(-2px);
          position: relative;
          z-index: 1;
          animation: mePulse 2.2s ease-in-out infinite;
        }

        /* inner frame */
        .lbRowMe::before {
          content: "";
          position: absolute;
          inset: 6px;
          border-radius: 14px;
          pointer-events: none;
          box-shadow:
            inset 0 0 0 1px rgba(0,255,163,0.32),
            0 10px 26px rgba(0,0,0,0.35),
            0 0 22px rgba(0,255,163,0.16);
        }

        /* left accent bar */
        .lbRowMe::after {
          content: "";
          position: absolute;
          left: 8px;
          top: 10px;
          bottom: 10px;
          width: 3px;
          border-radius: 999px;
          background: linear-gradient(180deg, rgba(0,255,163,0.85), rgba(120,120,255,0.55));
          opacity: 0.9;
          pointer-events: none;
        }

        .lbRowMe:hover { transform: translateY(-3px); }

        /* Keep columns from overflowing */
        .lbRow > div:nth-child(2),
        .lbHead > div:nth-child(2) { min-width: 0; }

        /* Responsive */
        @media (max-width: 520px) {
          .lbHead, .lbRow { grid-template-columns: 58px 1fr 74px 74px !important; }
          .lbWrap { overflow-x: hidden !important; }
          .lbRow .lbUserName { font-size: 13px !important; letter-spacing: 0.1px !important; }
          .lbRow .lbWalletLine { font-size: 11px !important; }
        }

        /* Respect reduced-motion */
        @media (prefers-reduced-motion: reduce) {
          .lbShell::before { animation: none !important; }
          .lbRowMe { animation: none !important; }
          .lbBtn, .lbRow { transition: none !important; }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: "100vh",
    display: "flex",
    justifyContent: "center",
    padding: "28px 14px",
    color: "#EAEAF2",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  },

  card: {
    width: "min(980px, 100%)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 20,
    background: "rgba(6, 7, 12, 0.82)",
    boxShadow: "0 22px 70px rgba(0,0,0,0.62)",
    padding: 18,
    backdropFilter: "blur(12px)",
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
    fontWeight: 900,
    letterSpacing: 0.2,
  },

  sub: {
    marginTop: 6,
    fontSize: 13,
    opacity: 0.82,
  },

  badge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 999,
    border: "1px solid rgba(0,255,163,0.38)",
    background: "rgba(0,255,163,0.09)",
    color: "rgba(225,255,246,1)",
    fontWeight: 900,
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
    border: "1px solid rgba(0,255,163,0.46)",
    background:
      "linear-gradient(90deg, rgba(0,255,163,0.18), rgba(102,102,255,0.14))",
    color: "#EFFFF9",
    fontWeight: 900,
    textDecoration: "none",
    boxShadow: "0 10px 24px rgba(0,0,0,0.28)",
  },

  btnSecondary: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#EAEAF2",
    fontWeight: 800,
    cursor: "pointer",
    boxShadow: "0 10px 24px rgba(0,0,0,0.22)",
  },

  loadingBox: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    padding: 14,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.05)",
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
    borderRadius: 16,
    border: "1px solid rgba(255,90,90,0.35)",
    background: "rgba(255,90,90,0.08)",
  },

  errorTitle: { fontWeight: 900, marginBottom: 6 },
  errorText: { opacity: 0.9, fontSize: 13, whiteSpace: "pre-wrap" },

  emptyBox: {
    padding: 14,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.05)",
    opacity: 0.9,
  },

  tableWrap: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.10)",
    overflow: "hidden",
    boxShadow: "0 18px 55px rgba(0,0,0,0.30)",
  },

  tableHead: {
    display: "grid",
    gridTemplateColumns: "70px 1fr 110px 110px",
    gap: 0,
    padding: "12px 12px",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))",
    fontWeight: 900,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.9,
    borderBottom: "1px solid rgba(255,255,255,0.06)",
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
    background:
      "linear-gradient(180deg, rgba(0,0,0,0.16), rgba(0,0,0,0.10))",
  },

  rowSkrGlow: {
    borderTop: "1px solid rgba(0,255,163,0.22)",
    boxShadow:
      "inset 0 0 0 1px rgba(0,255,163,0.16), 0 0 20px rgba(0,255,163,0.10)",
    background:
      "radial-gradient(900px 140px at 12% 50%, rgba(0,255,163,0.18), transparent 60%)," +
      "radial-gradient(700px 140px at 88% 40%, rgba(0,255,163,0.10), transparent 55%)," +
      "linear-gradient(180deg, rgba(0,0,0,0.18), rgba(0,0,0,0.10))",
  },

  /* IMPORTANT: keep spacing identical to normal rows (no padding/radius here) */
  rowMePop: {
    borderTop: "1px solid rgba(0,255,163,0.40)",
    boxShadow: "inset 0 0 0 1px rgba(0,255,163,0.14)",
    background:
      "radial-gradient(800px 170px at 20% 45%, rgba(0,255,163,0.18), transparent 62%)," +
      "radial-gradient(700px 160px at 84% 55%, rgba(120,120,255,0.12), transparent 60%)," +
      "linear-gradient(180deg, rgba(0,0,0,0.18), rgba(0,0,0,0.10))",
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

  rankPillMe: {
    border: "1px solid rgba(0,255,163,0.60)",
    background: "rgba(0,255,163,0.12)",
    boxShadow: "0 0 22px rgba(0,255,163,0.22)",
  },

  userLine: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },

  mePill: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 18,
    padding: "0 8px",
    borderRadius: 999,
    border: "1px solid rgba(0,255,163,0.60)",
    background:
      "linear-gradient(90deg, rgba(0,255,163,0.18), rgba(102,102,255,0.10))",
    color: "#EFFFF9",
    fontSize: 11,
    fontWeight: 900,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    boxShadow: "0 0 14px rgba(0,255,163,0.20)",
    flex: "0 0 auto",
  },

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

  userNameMe: {
    fontWeight: 950 as any,
    letterSpacing: 0.2,
    display: "block",
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 15,
    lineHeight: 1.15,
  },

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

  walletLine: { fontSize: 12, opacity: 0.72, marginTop: 2 },
  walletLineMe: { fontSize: 12, opacity: 0.82, marginTop: 2 },

  statNum: { fontWeight: 900, fontSize: 16 },
  statNumMe: { fontWeight: 950 as any, fontSize: 18 },

  statLabel: { fontSize: 11, opacity: 0.7, marginTop: 2 },

  footerNote: {
    padding: 12,
    fontSize: 12,
    opacity: 0.72,
    borderTop: "1px solid rgba(255,255,255,0.06)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))",
  },
};