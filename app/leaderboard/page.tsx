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
          --cyan: #19e6ff;
          --violet: #8a5cff;
          --pink: #ff38d1;
          --green: #00ffa3;
          --text: #f4f7ff;
          --muted: rgba(244,247,255,.68);
          --line: rgba(255,255,255,.12);
          --glass: rgba(7, 9, 22, .72);
          --gold: #ffd76a;
          --silver: #d9e7ff;
          --bronze: #d99a5f;
        }

        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes glowPulse {
          0%, 100% { box-shadow: 0 0 0 rgba(0,255,163,0); }
          50% { box-shadow: 0 0 54px rgba(0,255,163,.20); }
        }
        @keyframes bgShift {
          0%, 100% { transform: scale(1.02) translate3d(0,0,0); }
          50% { transform: scale(1.06) translate3d(-10px, -8px, 0); }
        }
        @keyframes orbitSweep {
          0% { transform: rotate(0deg) scale(1); opacity: .34; }
          50% { opacity: .68; }
          100% { transform: rotate(360deg) scale(1); opacity: .34; }
        }
        @keyframes starTwinkle {
          0%, 100% { opacity: .20; transform: scale(1); }
          50% { opacity: .55; transform: scale(1.05); }
        }

        .lbShell {
          min-height: 100vh;
          width: 100%;
          color: var(--text);
          padding: 28px 14px;
          display: flex;
          justify-content: center;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
          position: relative;
          overflow: hidden;
          background: #03040b;
        }

        .lbShell::before {
          content: "";
          position: fixed;
          inset: -28px;
          pointer-events: none;
          background-image:
            linear-gradient(180deg, rgba(0,0,0,.30), rgba(0,0,0,.82)),
            radial-gradient(850px 520px at 20% 18%, rgba(255,56,209,.20), transparent 68%),
            radial-gradient(760px 520px at 82% 22%, rgba(25,230,255,.22), transparent 66%),
            radial-gradient(720px 460px at 50% 80%, rgba(138,92,255,.18), transparent 68%),
            image-set(url("/leaderboard-cosmic.png") 1x, url("/leaderboard-cosmic@2x.png") 2x),
            radial-gradient(rgba(255,255,255,.16) 1px, transparent 1px);
          background-size: auto, auto, auto, auto, cover, 150px 150px;
          background-position: center;
          background-repeat: no-repeat, no-repeat, no-repeat, no-repeat, no-repeat, repeat;
          filter: saturate(1.12) contrast(1.06);
          animation: bgShift 28s ease-in-out infinite;
          transform-origin: center;
        }

        .lbShell::after {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background:
            radial-gradient(circle at 18% 20%, rgba(255,255,255,.55) 0 1px, transparent 2px),
            radial-gradient(circle at 76% 24%, rgba(255,255,255,.44) 0 1px, transparent 2px),
            radial-gradient(circle at 42% 68%, rgba(25,230,255,.42) 0 1px, transparent 2px),
            linear-gradient(90deg, transparent, rgba(255,255,255,.035), transparent),
            radial-gradient(rgba(255,255,255,.055) 1px, transparent 1px);
          background-size: 520px 520px, 680px 680px, 780px 780px, auto, 3px 3px;
          opacity: .30;
          mix-blend-mode: screen;
          animation: starTwinkle 6s ease-in-out infinite;
        }

        .lbCard {
          width: min(1060px, 100%);
          position: relative;
          z-index: 1;
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 30px;
          background:
            radial-gradient(1000px 360px at 50% -10%, rgba(25,230,255,.13), transparent 56%),
            radial-gradient(880px 310px at 12% 0%, rgba(255,56,209,.15), transparent 60%),
            radial-gradient(900px 320px at 92% 6%, rgba(138,92,255,.18), transparent 62%),
            linear-gradient(180deg, rgba(8,10,26,.86), rgba(4,5,15,.80));
          backdrop-filter: blur(20px) saturate(1.15);
          -webkit-backdrop-filter: blur(20px) saturate(1.15);
          box-shadow:
            0 34px 130px rgba(0,0,0,.78),
            inset 0 1px 0 rgba(255,255,255,.08),
            inset 0 -1px 0 rgba(255,255,255,.04);
          padding: 18px;
          overflow: hidden;
        }

        .lbCard::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(135deg, rgba(255,56,209,.42), rgba(25,230,255,.38), rgba(0,255,163,.20), rgba(255,215,106,.16));
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
        }

        .lbCard::after {
          content: "";
          position: absolute;
          width: 560px;
          height: 560px;
          right: -220px;
          top: -270px;
          border-radius: 50%;
          border: 1px solid rgba(25,230,255,.18);
          box-shadow:
            inset 0 0 46px rgba(138,92,255,.10),
            0 0 72px rgba(25,230,255,.10);
          pointer-events: none;
          animation: orbitSweep 34s linear infinite;
        }

        .lbHero {
          position: relative;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
          flex-wrap: wrap;
          padding: 18px 18px 20px;
          margin-bottom: 14px;
          border: 1px solid rgba(255,255,255,.10);
          border-radius: 24px;
          background:
            radial-gradient(900px 220px at 22% 0%, rgba(255,56,209,.12), transparent 62%),
            radial-gradient(900px 220px at 80% 0%, rgba(25,230,255,.12), transparent 62%),
            rgba(255,255,255,.035);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
          overflow: hidden;
        }
        .lbHero::after {
          content: "";
          position: absolute;
          right: 26px;
          bottom: -72px;
          width: 240px;
          height: 240px;
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,.10);
          box-shadow: inset 0 0 42px rgba(25,230,255,.08);
          pointer-events: none;
        }

        .lbEyebrow {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: rgba(244,247,255,.78);
          text-transform: uppercase;
          letter-spacing: 1.8px;
          font-size: 12px;
          font-weight: 950;
        }

        .lbEyebrow::before {
          content: "";
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--pink), var(--cyan));
          box-shadow: 0 0 22px rgba(25,230,255,.72);
        }

        .lbHero h1 {
          margin: 8px 0 6px;
          font-size: clamp(28px, 5vw, 54px);
          line-height: .96;
          letter-spacing: -.06em;
          font-weight: 1000;
        }

        .lbHero p {
          margin: 0;
          color: var(--muted);
          max-width: 650px;
          font-size: 14px;
          line-height: 1.55;
        }

        .lbHero p span {
          color: white;
          font-weight: 950;
          background: linear-gradient(90deg, var(--pink), var(--cyan));
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }

        .lbActions {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .lbButton {
          height: 42px;
          border-radius: 14px;
          padding: 0 15px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          text-decoration: none;
          font-weight: 950;
          font-size: 13px;
          cursor: pointer;
          transition: transform .14s ease, border-color .14s ease, background .14s ease, box-shadow .14s ease;
        }

        .lbButton:hover { transform: translateY(-1px); }
        .lbButton:active { transform: translateY(0) scale(.99); }
        .lbButton.small { height: 36px; margin-top: 10px; }

        .lbButtonGhost {
          border: 1px solid rgba(255,255,255,.16);
          background: rgba(255,255,255,.055);
          color: white;
        }

        .lbButtonSolid {
          border: 1px solid rgba(25,230,255,.40);
          background: linear-gradient(135deg, rgba(138,92,255,.35), rgba(25,230,255,.22));
          color: white;
          box-shadow: 0 14px 34px rgba(0,0,0,.28), 0 0 28px rgba(25,230,255,.10);
        }

        .lbPodium {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          margin: 0 0 14px;
        }

        .lbPodiumCard {
          position: relative;
          border: 1px solid rgba(255,255,255,.13);
          border-radius: 24px;
          padding: 16px;
          min-width: 0;
          overflow: hidden;
          background:
            radial-gradient(420px 170px at 50% 0%, rgba(25,230,255,.13), transparent 62%),
            linear-gradient(180deg, rgba(255,255,255,.060), rgba(255,255,255,.032));
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,.10),
            0 18px 52px rgba(0,0,0,.30);
        }
        .lbPodiumCard::before {
          content: "";
          position: absolute;
          inset: -1px;
          pointer-events: none;
          background: radial-gradient(280px 120px at 50% 0%, rgba(255,255,255,.16), transparent 64%);
          opacity: .72;
        }
        .lbPodiumCard::after {
          content: "";
          position: absolute;
          right: -48px;
          top: -72px;
          width: 150px;
          height: 150px;
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,.08);
          pointer-events: none;
        }

        .lbPodiumCard.p1 {
          border-color: rgba(255,215,106,.54);
          background:
            radial-gradient(420px 180px at 50% -8%, rgba(255,215,106,.34), transparent 64%),
            radial-gradient(360px 160px at 18% 0%, rgba(255,56,209,.16), transparent 62%),
            linear-gradient(180deg, rgba(255,215,106,.100), rgba(255,255,255,.035));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.15), 0 22px 70px rgba(255,184,61,.12), 0 18px 58px rgba(0,0,0,.34);
        }
        .lbPodiumCard.p2 {
          border-color: rgba(217,231,255,.48);
          background:
            radial-gradient(420px 180px at 50% -8%, rgba(217,231,255,.25), transparent 64%),
            radial-gradient(360px 160px at 80% 0%, rgba(25,230,255,.13), transparent 62%),
            linear-gradient(180deg, rgba(217,231,255,.080), rgba(255,255,255,.032));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 22px 70px rgba(217,231,255,.09), 0 18px 58px rgba(0,0,0,.34);
        }
        .lbPodiumCard.p3 {
          border-color: rgba(217,154,95,.50);
          background:
            radial-gradient(420px 180px at 50% -8%, rgba(217,154,95,.28), transparent 64%),
            radial-gradient(360px 160px at 14% 0%, rgba(138,92,255,.13), transparent 62%),
            linear-gradient(180deg, rgba(217,154,95,.090), rgba(255,255,255,.032));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.12), 0 22px 70px rgba(217,154,95,.10), 0 18px 58px rgba(0,0,0,.34);
        }

        .lbPodiumCard.mine { border-color: rgba(0,255,163,.55); box-shadow: 0 0 34px rgba(0,255,163,.13); }
        .podiumRank { position: relative; color: var(--muted); font-size: 12px; font-weight: 950; letter-spacing: .8px; }
        .p1 .podiumRank { color: var(--gold); text-shadow: 0 0 18px rgba(255,215,106,.35); }
        .p2 .podiumRank { color: var(--silver); text-shadow: 0 0 18px rgba(217,231,255,.25); }
        .p3 .podiumRank { color: var(--bronze); text-shadow: 0 0 18px rgba(217,154,95,.28); }
        .podiumName { position: relative; margin-top: 8px; font-size: 18px; line-height: 1.1; font-weight: 1000; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .podiumStats { position: relative; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        .podiumStats span { font-size: 12px; color: rgba(244,247,255,.78); border: 1px solid rgba(255,255,255,.12); border-radius: 999px; padding: 5px 8px; background: rgba(0,0,0,.18); }

        .lbState {
          border: 1px solid var(--line);
          border-radius: 18px;
          min-height: 74px;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px;
          color: rgba(244,247,255,.82);
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
          border: 1px solid rgba(255,255,255,.13);
          border-radius: 24px;
          overflow: hidden;
          background:
            radial-gradient(900px 260px at 50% 0%, rgba(25,230,255,.055), transparent 70%),
            rgba(0,0,0,.28);
          box-shadow:
            0 22px 70px rgba(0,0,0,.38),
            inset 0 1px 0 rgba(255,255,255,.06);
        }

        .lbHead, .lbRow {
          display: grid;
          grid-template-columns: 72px 1fr 112px 112px;
          align-items: center;
          gap: 0;
        }

        .lbHead {
          padding: 12px 14px;
          font-size: 11px;
          letter-spacing: 1.1px;
          font-weight: 1000;
          text-transform: uppercase;
          color: rgba(244,247,255,.64);
          background:
            linear-gradient(90deg, rgba(255,56,209,.065), rgba(25,230,255,.065)),
            rgba(255,255,255,.050);
          border-bottom: 1px solid rgba(255,255,255,.09);
        }

        .lbHead > div:nth-child(3), .lbHead > div:nth-child(4) { text-align: right; }

        .lbRow {
          position: relative;
          padding: 12px 14px;
          border-top: 1px solid rgba(255,255,255,.07);
          background: linear-gradient(180deg, rgba(255,255,255,.030), rgba(255,255,255,.018));
          transition: transform .16s ease, box-shadow .16s ease, background .16s ease, border-color .16s ease;
        }

        .lbRow:first-child { border-top: 0; }
        .lbRow:hover { transform: translateY(-1px); background: rgba(255,255,255,.055); box-shadow: 0 12px 30px rgba(0,0,0,.24); }

        .lbRowSkr {
          background:
            radial-gradient(650px 90px at 10% 50%, rgba(0,255,163,.13), transparent 60%),
            linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.018));
        }

        .lbRow.rank1 {
          border-color: rgba(255,215,106,.44);
          background:
            radial-gradient(760px 140px at 5% 50%, rgba(255,215,106,.18), transparent 62%),
            radial-gradient(760px 140px at 90% 50%, rgba(255,56,209,.08), transparent 62%),
            linear-gradient(180deg, rgba(255,215,106,.055), rgba(255,255,255,.020));
        }
        .lbRow.rank2 {
          border-color: rgba(217,231,255,.34);
          background:
            radial-gradient(760px 140px at 5% 50%, rgba(217,231,255,.14), transparent 62%),
            radial-gradient(760px 140px at 90% 50%, rgba(25,230,255,.08), transparent 62%),
            linear-gradient(180deg, rgba(217,231,255,.045), rgba(255,255,255,.020));
        }
        .lbRow.rank3 {
          border-color: rgba(217,154,95,.38);
          background:
            radial-gradient(760px 140px at 5% 50%, rgba(217,154,95,.15), transparent 62%),
            radial-gradient(760px 140px at 90% 50%, rgba(138,92,255,.08), transparent 62%),
            linear-gradient(180deg, rgba(217,154,95,.048), rgba(255,255,255,.020));
        }
        .lbRow.rank1 .lbRank span {
          color: #180f00;
          border-color: rgba(255,215,106,.72);
          background: linear-gradient(135deg, #fff1a8, #ffd76a 52%, #b8781d);
          box-shadow: 0 0 28px rgba(255,215,106,.30);
        }
        .lbRow.rank2 .lbRank span {
          color: #07111f;
          border-color: rgba(217,231,255,.64);
          background: linear-gradient(135deg, #ffffff, #d9e7ff 52%, #8d9bb3);
          box-shadow: 0 0 24px rgba(217,231,255,.20);
        }
        .lbRow.rank3 .lbRank span {
          color: #170904;
          border-color: rgba(217,154,95,.66);
          background: linear-gradient(135deg, #ffd0a4, #d99a5f 52%, #8b4a23);
          box-shadow: 0 0 24px rgba(217,154,95,.22);
        }

        .lbRowMe {
          z-index: 2;
          border-color: rgba(0,255,163,.50);
          background:
            radial-gradient(760px 150px at 18% 50%, rgba(0,255,163,.20), transparent 60%),
            radial-gradient(760px 150px at 88% 50%, rgba(138,92,255,.16), transparent 60%),
            rgba(255,255,255,.045);
          animation: glowPulse 2.4s ease-in-out infinite;
        }

        .lbRowCompact { border-top: 0; }

        .lbRank span {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 42px;
          height: 34px;
          border-radius: 999px;
          font-weight: 1000;
          border: 1px solid rgba(138,92,255,.34);
          background: linear-gradient(180deg, rgba(138,92,255,.16), rgba(25,230,255,.06));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.09);
        }

        .lbIdentity { min-width: 0; }
        .lbUserLine { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .lbUserName { display: block; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 1000; letter-spacing: -.01em; }
        .lbUserMe { color: white; }
        .lbWalletLine { margin-top: 3px; font-size: 12px; color: rgba(244,247,255,.52); }

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
        .lbMetric span { display: block; margin-top: 4px; font-size: 11px; color: rgba(244,247,255,.58); }
        .streakMetric strong { color: white; text-shadow: 0 0 22px rgba(25,230,255,.18); }

        .lbFooter {
          padding: 12px 14px;
          color: rgba(244,247,255,.58);
          font-size: 12px;
          border-top: 1px solid rgba(255,255,255,.08);
          background: rgba(255,255,255,.035);
        }

        .lbMyRank { margin-top: 14px; }
        .lbMyRankTitle {
          padding: 12px 14px;
          font-size: 11px;
          letter-spacing: 1.1px;
          font-weight: 1000;
          text-transform: uppercase;
          color: rgba(244,247,255,.68);
          border-bottom: 1px solid rgba(255,255,255,.08);
          background: rgba(255,255,255,.045);
        }

        @media (max-width: 640px) {
          .lbShell { padding: 14px 10px; }
          .lbCard { border-radius: 22px; padding: 12px; }
          .lbHero { padding: 4px 2px 14px; }
          .lbActions { width: 100%; }
          .lbButton { flex: 1; }
          .lbPodium { grid-template-columns: 1fr; }
          .lbHead, .lbRow { grid-template-columns: 58px 1fr 74px 74px; }
          .lbHead { padding: 10px 10px; font-size: 10px; }
          .lbRow { padding: 11px 10px; }
          .lbRank span { min-width: 36px; height: 31px; font-size: 12px; }
          .lbUserName { font-size: 13px; }
          .lbWalletLine { font-size: 11px; }
          .lbMetric strong { font-size: 15px; }
          .lbMetric span { font-size: 10px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .lbShell::before, .lbRowMe, .lbSpinner { animation: none !important; }
          .lbButton, .lbRow { transition: none !important; }
        }
      `}</style>
    </main>
  );
}
