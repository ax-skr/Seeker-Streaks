"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";

type Row = {
  wallet: string;
  points?: number;
  streak?: number;
  name?: string | null;
  rank?: number;
};

type CacheEntry = { value: string | null; expiresAt: number };

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

  const nameCache = useRef<Map<string, CacheEntry>>(new Map());
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
    nameCache.current.set(wallet, {
      value,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
  }

  function normalizeName(v: unknown): string | null {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return null;
    if (!s.includes(".")) return null;
    if (s.length > 80) return null;
    return s;
  }

  function isSkrDisplay(display: string) {
    return display.toLowerCase().endsWith(".skr");
  }

  function displayName(row: Row) {
    return (
      (normalizeName(row.name) || getCachedName(row.wallet) || "").trim() ||
      shortWallet(row.wallet)
    );
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
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ wallets: toFetch }),
      });

      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      const names: Record<string, string | null> =
        data?.names && typeof data.names === "object" ? data.names : {};

      for (const w of toFetch) {
        setCachedName(w, normalizeName(names?.[w]));
      }

      if (loadSeq.current !== seq) return;

      setRows((prev) =>
        prev.map((r) => {
          if (normalizeName(r.name)) return r;
          const cached = getCachedName(r.wallet);
          if (cached === undefined) return r;
          return { ...r, name: cached };
        })
      );

      setMyRow((prev) => {
        if (!prev) return prev;
        if (normalizeName(prev.name)) return prev;
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

  const topThree = rows.slice(0, 3);

  function RowItem({ row, idx, compact = false }: { row: Row; idx: number; compact?: boolean }) {
    const display = displayName(row);
    const showSkr = isSkrDisplay(display);
    const isMe = !!myWallet && row.wallet === myWallet && connected;

    return (
      <div
        className={`lbRow rank${row.rank ?? idx + 1} ${showSkr ? "lbRowSkr" : ""} ${isMe ? "lbRowMe" : ""} ${
          compact ? "lbRowCompact" : ""
        }`}
      >
        <div className="lbRank">
          <span>{row.rank ?? idx + 1}</span>
        </div>

        <div className="lbIdentity">
          <div className="lbUserLine">
            <span className={`lbUserName ${isMe ? "lbUserMe" : ""}`} title={display}>
              {display}
            </span>
            {isMe && <span className="lbYou">YOU</span>}
          </div>
          <div className="lbWalletLine">{shortWallet(row.wallet)}</div>
        </div>

        <div className="lbMetric">
          <strong>{Number(row.points ?? 0)}</strong>
          <span>Points</span>
        </div>

        <div className="lbMetric streakMetric">
          <strong>{Number(row.streak ?? 0)}</strong>
          <span>Streak</span>
        </div>
      </div>
    );
  }

  return (
    <main className="lbShell">
      <section className="lbCard">
        <header className="lbHero">
          <div>
            <div className="lbEyebrow">Seeker Streaks</div>
            <h1>All-Time Leaderboard</h1>
            <p>
              Ranked by <span>longest streak</span>, then total points. The current line keeps moving.
            </p>
          </div>

          <div className="lbActions">
            <button
              onClick={() => {
                load();
                loadMyRank();
              }}
              className="lbButton lbButtonGhost"
            >
              Refresh
            </button>
            <Link href="/" className="lbButton lbButtonSolid">
              Back
            </Link>
          </div>
        </header>

        {!loading && !err && rows.length > 0 && (
          <div className="lbPodium" aria-label="Top 3 leaderboard positions">
            {topThree.map((r, i) => {
              const display = displayName(r);
              const isMe = !!myWallet && r.wallet === myWallet && connected;
              return (
                <div key={`podium-${r.wallet}-${i}`} className={`lbPodiumCard p${i + 1} ${isMe ? "mine" : ""}`}>
                  <div className="podiumRank">#{r.rank ?? i + 1}</div>
                  <div className="podiumName" title={display}>{display}</div>
                  <div className="podiumStats">
                    <span>{Number(r.streak ?? 0)} streak</span>
                    <span>{Number(r.points ?? 0)} points</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {loading && (
          <div className="lbState">
            <div className="lbSpinner" />
            <span>Loading leaderboard…</span>
          </div>
        )}

        {!loading && err && (
          <div className="lbState lbError">
            <strong>Couldn’t load leaderboard</strong>
            <span>{err}</span>
            <button onClick={load} className="lbButton lbButtonGhost small">
              Try again
            </button>
          </div>
        )}

        {!loading && !err && rows.length === 0 && (
          <div className="lbState">No entries yet. Verify + check in, then refresh.</div>
        )}

        {!loading && !err && rows.length > 0 && (
          <div className="lbBoard">
            <div className="lbHead">
              <div>#</div>
              <div>User</div>
              <div>Points</div>
              <div>Streak</div>
            </div>

            <div className="lbRows">
              {rows.map((r, idx) => (
                <RowItem key={`${r.wallet}-${idx}`} row={r} idx={idx} />
              ))}
            </div>

            <div className="lbFooter">Top 100 verified users. Streaks continue daily at 00:00 UTC.</div>
          </div>
        )}

        {!loading && !err && connected && myWallet && !myInTop100 && (
          <div className="lbMyRank">
            <div className="lbMyRankTitle">Your position</div>
            {myLoading ? (
              <div className="lbState compactState">
                <div className="lbSpinner" />
                <span>Loading your rank…</span>
              </div>
            ) : myRow ? (
              <RowItem row={myRow} idx={0} compact />
            ) : (
              <div className="lbState compactState">Couldn’t load your rank right now.</div>
            )}
          </div>
        )}
      </section>

      <style>{`
        :root {
          --bg: #02030a;
          --panel: rgba(8, 10, 24, 0.72);
          --panel2: rgba(14, 18, 40, 0.54);
          --line: rgba(255,255,255,0.12);
          --line2: rgba(255,255,255,0.08);
          --text: #f6f8ff;
          --muted: rgba(246,248,255,0.64);
          --soft: rgba(246,248,255,0.44);
          --cyan: #22e7ff;
          --blue: #3d7cff;
          --violet: #8d5cff;
          --magenta: #ff3fd7;
          --green: #00ffa3;
          --gold: #ffd76f;
          --silver: #e6efff;
          --bronze: #df9c64;
        }

        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slowSpace {
          0%, 100% { transform: scale(1.025) translate3d(0,0,0); }
          50% { transform: scale(1.055) translate3d(-10px,-7px,0); }
        }
        @keyframes shimmer {
          0% { transform: translateX(-120%); opacity: 0; }
          20% { opacity: .45; }
          100% { transform: translateX(120%); opacity: 0; }
        }
        @keyframes pulseMe {
          0%, 100% { box-shadow: 0 0 0 rgba(0,255,163,0), inset 0 0 0 1px rgba(0,255,163,.28); }
          50% { box-shadow: 0 0 48px rgba(0,255,163,.16), inset 0 0 0 1px rgba(0,255,163,.48); }
        }
        @keyframes orbit {
          to { transform: rotate(360deg); }
        }

        .lbShell {
          width: 100%;
          min-height: 100vh;
          position: relative;
          overflow: hidden;
          display: flex;
          justify-content: center;
          padding: 28px 14px;
          color: var(--text);
          background: var(--bg);
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        }

        .lbShell::before {
          content: "";
          position: fixed;
          inset: -34px;
          pointer-events: none;
          background-image:
            linear-gradient(180deg, rgba(1,2,9,.24), rgba(1,2,9,.82)),
            radial-gradient(900px 520px at 16% 14%, rgba(255,63,215,.20), transparent 62%),
            radial-gradient(850px 520px at 84% 18%, rgba(34,231,255,.22), transparent 64%),
            radial-gradient(720px 520px at 52% 86%, rgba(141,92,255,.18), transparent 68%),
            image-set(url("/leaderboard-cosmic.png") 1x, url("/leaderboard-cosmic@2x.png") 2x),
            radial-gradient(rgba(255,255,255,.18) 1px, transparent 1px);
          background-size: auto, auto, auto, auto, cover, 180px 180px;
          background-position: center;
          background-repeat: no-repeat, no-repeat, no-repeat, no-repeat, no-repeat, repeat;
          filter: saturate(1.16) contrast(1.06);
          animation: slowSpace 34s ease-in-out infinite;
          transform-origin: center;
        }

        .lbShell::after {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background:
            radial-gradient(circle at 20% 18%, rgba(255,255,255,.62) 0 1px, transparent 2px),
            radial-gradient(circle at 72% 22%, rgba(34,231,255,.48) 0 1px, transparent 2px),
            radial-gradient(circle at 58% 68%, rgba(255,63,215,.42) 0 1px, transparent 2px),
            radial-gradient(rgba(255,255,255,.05) 1px, transparent 1px);
          background-size: 520px 520px, 640px 640px, 760px 760px, 4px 4px;
          opacity: .28;
          mix-blend-mode: screen;
        }

        .lbCard {
          width: min(1080px, 100%);
          position: relative;
          z-index: 1;
          padding: 16px;
          border-radius: 32px;
          overflow: hidden;
          background:
            linear-gradient(180deg, rgba(255,255,255,.075), rgba(255,255,255,.028)),
            radial-gradient(900px 360px at 18% -12%, rgba(255,63,215,.12), transparent 58%),
            radial-gradient(900px 360px at 86% -8%, rgba(34,231,255,.13), transparent 60%),
            rgba(5, 7, 18, .72);
          border: 1px solid rgba(255,255,255,.16);
          backdrop-filter: blur(22px) saturate(1.2);
          -webkit-backdrop-filter: blur(22px) saturate(1.2);
          box-shadow:
            0 34px 140px rgba(0,0,0,.78),
            inset 0 1px 0 rgba(255,255,255,.12),
            inset 0 -1px 0 rgba(255,255,255,.04);
        }

        .lbCard::before {
          content: "";
          position: absolute;
          inset: 0;
          padding: 1px;
          border-radius: inherit;
          pointer-events: none;
          background: linear-gradient(135deg, rgba(255,63,215,.52), rgba(34,231,255,.46), rgba(141,92,255,.26), rgba(255,215,111,.18));
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
        }

        .lbCard::after {
          content: "";
          position: absolute;
          top: -190px;
          right: -180px;
          width: 430px;
          height: 430px;
          border-radius: 999px;
          border: 1px solid rgba(34,231,255,.16);
          box-shadow:
            inset 0 0 52px rgba(141,92,255,.10),
            0 0 80px rgba(34,231,255,.10);
          pointer-events: none;
          animation: orbit 42s linear infinite;
        }

        .lbHero {
          position: relative;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 18px;
          flex-wrap: wrap;
          padding: 20px;
          margin-bottom: 14px;
          border-radius: 26px;
          border: 1px solid rgba(255,255,255,.11);
          background:
            radial-gradient(780px 220px at 18% 0%, rgba(255,63,215,.13), transparent 60%),
            radial-gradient(820px 230px at 86% 10%, rgba(34,231,255,.13), transparent 62%),
            linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.025));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
          overflow: hidden;
        }

        .lbHero::before {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(100deg, transparent 0%, rgba(255,255,255,.10) 48%, transparent 72%);
          width: 50%;
          animation: shimmer 7s ease-in-out infinite;
          pointer-events: none;
        }

        .lbEyebrow {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: rgba(246,248,255,.72);
        }

        .lbEyebrow::before {
          content: "";
          width: 9px;
          height: 9px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--magenta), var(--cyan));
          box-shadow: 0 0 24px rgba(34,231,255,.72);
        }

        .lbHero h1 {
          margin: 8px 0 7px;
          font-size: clamp(30px, 5vw, 56px);
          line-height: .94;
          letter-spacing: -.065em;
          font-weight: 1000;
          text-wrap: balance;
        }

        .lbHero p {
          margin: 0;
          max-width: 640px;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.55;
        }

        .lbHero p span {
          font-weight: 1000;
          background: linear-gradient(90deg, var(--magenta), var(--cyan));
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }

        .lbActions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .lbButton {
          height: 42px;
          border-radius: 999px;
          padding: 0 16px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          text-decoration: none;
          border: 1px solid rgba(255,255,255,.15);
          color: white;
          font-size: 13px;
          font-weight: 1000;
          cursor: pointer;
          transition: transform .14s ease, border-color .14s ease, background .14s ease, box-shadow .14s ease;
        }

        .lbButton:hover { transform: translateY(-1px); }
        .lbButton:active { transform: translateY(0) scale(.99); }
        .lbButton.small { height: 36px; margin-top: 10px; }

        .lbButtonGhost {
          background: rgba(255,255,255,.055);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
        }

        .lbButtonSolid {
          border-color: rgba(34,231,255,.42);
          background: linear-gradient(135deg, rgba(141,92,255,.42), rgba(34,231,255,.22));
          box-shadow: 0 14px 38px rgba(0,0,0,.28), 0 0 32px rgba(34,231,255,.12);
        }

        .lbPodium {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 14px;
        }

        .lbPodiumCard {
          position: relative;
          min-width: 0;
          padding: 16px;
          border-radius: 26px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.13);
          background:
            linear-gradient(180deg, rgba(255,255,255,.068), rgba(255,255,255,.030)),
            rgba(0,0,0,.18);
          box-shadow:
            0 20px 58px rgba(0,0,0,.30),
            inset 0 1px 0 rgba(255,255,255,.10);
        }

        .lbPodiumCard::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background:
            radial-gradient(340px 150px at 50% -20%, rgba(255,255,255,.18), transparent 62%),
            radial-gradient(240px 120px at 102% -20%, rgba(34,231,255,.10), transparent 62%);
        }

        .lbPodiumCard::after {
          content: "";
          position: absolute;
          right: -54px;
          top: -72px;
          width: 160px;
          height: 160px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,.09);
          box-shadow: inset 0 0 34px rgba(255,255,255,.04);
          pointer-events: none;
        }

        .lbPodiumCard.p1 {
          border-color: rgba(255,215,111,.58);
          background:
            radial-gradient(420px 180px at 50% -12%, rgba(255,215,111,.34), transparent 64%),
            radial-gradient(320px 160px at 0% 10%, rgba(255,63,215,.12), transparent 62%),
            linear-gradient(180deg, rgba(255,215,111,.10), rgba(255,255,255,.03));
          box-shadow: 0 22px 72px rgba(255,198,82,.12), 0 20px 58px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.16);
        }

        .lbPodiumCard.p2 {
          border-color: rgba(230,239,255,.48);
          background:
            radial-gradient(420px 180px at 50% -12%, rgba(230,239,255,.25), transparent 64%),
            radial-gradient(320px 160px at 100% 10%, rgba(34,231,255,.12), transparent 62%),
            linear-gradient(180deg, rgba(230,239,255,.08), rgba(255,255,255,.03));
          box-shadow: 0 22px 72px rgba(230,239,255,.08), 0 20px 58px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.14);
        }

        .lbPodiumCard.p3 {
          border-color: rgba(223,156,100,.52);
          background:
            radial-gradient(420px 180px at 50% -12%, rgba(223,156,100,.28), transparent 64%),
            radial-gradient(320px 160px at 0% 10%, rgba(141,92,255,.12), transparent 62%),
            linear-gradient(180deg, rgba(223,156,100,.09), rgba(255,255,255,.03));
          box-shadow: 0 22px 72px rgba(223,156,100,.10), 0 20px 58px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.13);
        }

        .lbPodiumCard.mine {
          border-color: rgba(0,255,163,.58);
          box-shadow: 0 0 42px rgba(0,255,163,.13), 0 20px 58px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.12);
        }

        .podiumRank {
          position: relative;
          z-index: 1;
          color: var(--muted);
          font-size: 12px;
          font-weight: 1000;
          letter-spacing: .9px;
        }
        .p1 .podiumRank { color: var(--gold); text-shadow: 0 0 20px rgba(255,215,111,.34); }
        .p2 .podiumRank { color: var(--silver); text-shadow: 0 0 20px rgba(230,239,255,.24); }
        .p3 .podiumRank { color: var(--bronze); text-shadow: 0 0 20px rgba(223,156,100,.26); }

        .podiumName {
          position: relative;
          z-index: 1;
          margin-top: 8px;
          font-size: 18px;
          line-height: 1.1;
          font-weight: 1000;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .podiumStats {
          position: relative;
          z-index: 1;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 13px;
        }

        .podiumStats span {
          font-size: 12px;
          font-weight: 850;
          color: rgba(246,248,255,.76);
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 999px;
          padding: 5px 8px;
          background: rgba(0,0,0,.22);
        }

        .lbState {
          min-height: 74px;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px;
          border: 1px solid var(--line);
          border-radius: 20px;
          color: rgba(246,248,255,.82);
          background: rgba(255,255,255,.045);
        }

        .compactState { min-height: 58px; border: 0; border-radius: 0; background: transparent; }
        .lbError { border-color: rgba(255,80,110,.34); background: rgba(255,80,110,.08); flex-direction: column; align-items: flex-start; }
        .lbError span { white-space: pre-wrap; font-size: 13px; opacity: .82; }

        .lbSpinner {
          width: 18px;
          height: 18px;
          border-radius: 999px;
          border: 2px solid rgba(255,255,255,.20);
          border-top-color: var(--cyan);
          animation: spin .9s linear infinite;
        }

        .lbBoard, .lbMyRank {
          border-radius: 26px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.13);
          background:
            radial-gradient(900px 260px at 50% 0%, rgba(34,231,255,.060), transparent 70%),
            rgba(0,0,0,.30);
          box-shadow:
            0 24px 74px rgba(0,0,0,.40),
            inset 0 1px 0 rgba(255,255,255,.07);
        }

        .lbHead, .lbRow {
          display: grid;
          grid-template-columns: 70px minmax(0, 1fr) 108px 108px;
          align-items: center;
          gap: 0;
        }

        .lbHead {
          padding: 12px 14px;
          font-size: 11px;
          letter-spacing: 1.1px;
          font-weight: 1000;
          text-transform: uppercase;
          color: rgba(246,248,255,.62);
          background:
            linear-gradient(90deg, rgba(255,63,215,.06), rgba(34,231,255,.06)),
            rgba(255,255,255,.045);
          border-bottom: 1px solid rgba(255,255,255,.09);
        }

        .lbHead > div:nth-child(3),
        .lbHead > div:nth-child(4) {
          text-align: right;
        }

        .lbRows {
          display: flex;
          flex-direction: column;
        }

        .lbRow {
          position: relative;
          padding: 11px 14px;
          min-height: 66px;
          border-top: 1px solid rgba(255,255,255,.065);
          background: linear-gradient(180deg, rgba(255,255,255,.026), rgba(255,255,255,.014));
          transition: transform .16s ease, box-shadow .16s ease, background .16s ease, border-color .16s ease;
        }

        .lbRow:first-child { border-top: 0; }

        .lbRow:hover {
          transform: translateY(-1px);
          background: rgba(255,255,255,.052);
          box-shadow: 0 14px 34px rgba(0,0,0,.26);
        }

        .lbRowSkr {
          background:
            radial-gradient(620px 88px at 8% 50%, rgba(0,255,163,.11), transparent 60%),
            linear-gradient(180deg, rgba(255,255,255,.030), rgba(255,255,255,.014));
        }

        .lbRow.rank1 {
          border-color: rgba(255,215,111,.43);
          background:
            radial-gradient(720px 132px at 0% 50%, rgba(255,215,111,.17), transparent 62%),
            radial-gradient(680px 132px at 100% 50%, rgba(255,63,215,.07), transparent 62%),
            linear-gradient(180deg, rgba(255,215,111,.050), rgba(255,255,255,.017));
        }
        .lbRow.rank2 {
          border-color: rgba(230,239,255,.34);
          background:
            radial-gradient(720px 132px at 0% 50%, rgba(230,239,255,.13), transparent 62%),
            radial-gradient(680px 132px at 100% 50%, rgba(34,231,255,.07), transparent 62%),
            linear-gradient(180deg, rgba(230,239,255,.040), rgba(255,255,255,.017));
        }
        .lbRow.rank3 {
          border-color: rgba(223,156,100,.38);
          background:
            radial-gradient(720px 132px at 0% 50%, rgba(223,156,100,.14), transparent 62%),
            radial-gradient(680px 132px at 100% 50%, rgba(141,92,255,.07), transparent 62%),
            linear-gradient(180deg, rgba(223,156,100,.043), rgba(255,255,255,.017));
        }

        .lbRow.rank1 .lbRank span {
          color: #211300;
          border-color: rgba(255,215,111,.72);
          background: linear-gradient(135deg, #fff4b5, #ffd76f 52%, #a96b18);
          box-shadow: 0 0 30px rgba(255,215,111,.28);
        }
        .lbRow.rank2 .lbRank span {
          color: #07111f;
          border-color: rgba(230,239,255,.64);
          background: linear-gradient(135deg, #ffffff, #e6efff 52%, #8b9ab5);
          box-shadow: 0 0 24px rgba(230,239,255,.20);
        }
        .lbRow.rank3 .lbRank span {
          color: #180904;
          border-color: rgba(223,156,100,.66);
          background: linear-gradient(135deg, #ffd4aa, #df9c64 52%, #884720);
          box-shadow: 0 0 24px rgba(223,156,100,.22);
        }

        .lbRowMe {
          z-index: 2;
          border-color: rgba(0,255,163,.50);
          background:
            radial-gradient(720px 140px at 18% 50%, rgba(0,255,163,.18), transparent 60%),
            radial-gradient(720px 140px at 88% 50%, rgba(141,92,255,.15), transparent 60%),
            rgba(255,255,255,.042);
          animation: pulseMe 2.4s ease-in-out infinite;
        }

        .lbRowCompact {
          border-top: 0;
        }

        .lbRank span {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 40px;
          height: 32px;
          border-radius: 999px;
          font-weight: 1000;
          border: 1px solid rgba(141,92,255,.32);
          background: linear-gradient(180deg, rgba(141,92,255,.15), rgba(34,231,255,.055));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
        }

        .lbIdentity { min-width: 0; }
        .lbUserLine { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .lbUserName {
          display: block;
          min-width: 0;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-weight: 1000;
          letter-spacing: -.01em;
        }
        .lbUserMe { color: white; }
        .lbWalletLine { margin-top: 3px; font-size: 12px; color: rgba(246,248,255,.50); }

        .lbYou {
          flex: 0 0 auto;
          font-size: 10px;
          letter-spacing: .7px;
          font-weight: 1000;
          padding: 3px 7px;
          border-radius: 999px;
          color: white;
          border: 1px solid rgba(0,255,163,.46);
          background: rgba(0,255,163,.12);
        }

        .lbMetric { text-align: right; }
        .lbMetric strong { display: block; font-size: 17px; line-height: 1; font-weight: 1000; }
        .lbMetric span { display: block; margin-top: 4px; font-size: 11px; color: rgba(246,248,255,.56); }
        .streakMetric strong { color: white; text-shadow: 0 0 22px rgba(34,231,255,.18); }

        .lbFooter {
          padding: 12px 14px;
          color: rgba(246,248,255,.56);
          font-size: 12px;
          border-top: 1px solid rgba(255,255,255,.08);
          background: rgba(255,255,255,.032);
        }

        .lbMyRank { margin-top: 14px; }
        .lbMyRankTitle {
          padding: 12px 14px;
          font-size: 11px;
          letter-spacing: 1.1px;
          font-weight: 1000;
          text-transform: uppercase;
          color: rgba(246,248,255,.66);
          border-bottom: 1px solid rgba(255,255,255,.08);
          background: rgba(255,255,255,.042);
        }

        @media (max-width: 640px) {
          .lbShell { padding: 14px 10px; }
          .lbCard { border-radius: 24px; padding: 12px; }
          .lbHero { padding: 16px; border-radius: 20px; }
          .lbActions { width: 100%; }
          .lbButton { flex: 1; }
          .lbPodium { grid-template-columns: 1fr; }
          .lbHead, .lbRow { grid-template-columns: 54px minmax(0, 1fr) 72px 72px; }
          .lbHead { padding: 10px 10px; font-size: 10px; }
          .lbRow { padding: 10px; min-height: 62px; }
          .lbRank span { min-width: 34px; height: 30px; font-size: 12px; }
          .lbUserName { font-size: 13px; }
          .lbWalletLine { font-size: 11px; }
          .lbMetric strong { font-size: 15px; }
          .lbMetric span { font-size: 10px; }
          .podiumName { font-size: 16px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .lbShell::before,
          .lbCard::after,
          .lbHero::before,
          .lbRowMe,
          .lbSpinner {
            animation: none !important;
          }
          .lbButton, .lbRow { transition: none !important; }
        }
      `}</style>
    </main>
  );
}
