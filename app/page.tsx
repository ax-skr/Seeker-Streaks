"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

/* ---------------- TERMS UPDATE BANNER CONFIG ---------------- */
const TERMS_URL = "https://seeker-streaks.vercel.app/terms";
const TERMS_UPDATED_UNTIL_UTC = "2026-03-08T15:00:00Z"; // 8th March 2026, 3pm UTC
/* ----------------------------------------------------------- */

const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

type BlockhashResult = {
  conn: Connection;
  blockhash: string;
  lastValidBlockHeight: number;
  rpc: string;
};

async function getWorkingConnectionForBlockhash(): Promise<BlockhashResult> {
  const rpcs = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
  ];

  const errors: string[] = [];

  for (const rpc of rpcs) {
    try {
      const conn = new Connection(rpc, "confirmed");
      const { blockhash, lastValidBlockHeight } =
        await conn.getLatestBlockhash("confirmed");
      return { conn, blockhash, lastValidBlockHeight, rpc };
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      errors.push(`${rpc}: ${msg}`);
    }
  }

  throw new Error(
    `Failed to fetch latest blockhash from fallback RPCs. ${errors.join(" | ")}`
  );
}

// ---------- helpers ----------
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function shortWallet(w?: string | null) {
  if (!w) return "";
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

// ---------- types ----------
type RescueQuote = {
  ok: boolean;
  verified: boolean;
  missedDays: number;

  // old keys (still possible)
  canRescue?: boolean;
  costSKR?: number;
  remainingRescue?: number;

  // new keys (preferred)
  canProtect?: boolean;
  protectionCostSKR?: number;
  protectionsLeft?: number;

  streak: number;
  treasury: string;
  mint: string;
  decimals?: number;
};

export default function Home() {
  const { publicKey, connected, signMessage, wallet } = useWallet();
  const { connection } = useConnection();

  const [mounted, setMounted] = useState(false);
  const [sessionVerified, setSessionVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [msg, setMsg] = useState<string>("");

  const [skrName, setSkrName] = useState<string | null>(null);
  const lastResolvedWallet = useRef<string | null>(null);

  const [quote, setQuote] = useState<RescueQuote | null>(null);
  const [paying, setPaying] = useState(false);
  const [resetting, setResetting] = useState(false);

  // ---------------- banner state (UI only; no functionality changes) ----------------
  const [showTermsBanner, setShowTermsBanner] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const until = new Date(TERMS_UPDATED_UNTIL_UTC).getTime();
    setShowTermsBanner(Date.now() < until);
  }, []);
  // -------------------------------------------------------------------------------

  useEffect(() => {
    setSessionVerified(false);
    setStatus(null);
    setSkrName(null);
    setQuote(null);
    lastResolvedWallet.current = null;
    setMsg("");
  }, [publicKey]);

  const walletStr = useMemo(() => publicKey?.toBase58() ?? null, [publicKey]);

  // ---------- load protection quote ----------
  const loadQuote = useCallback(async () => {
    if (!walletStr) return;

    const res = await fetch("/api/checkin/rescue-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: walletStr }),
      cache: "no-store",
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      setMsg(`Protection quote failed (${res.status}).`);
      console.error("quote error:", t);
      return;
    }

    const q = (await res.json()) as RescueQuote;
    setQuote(q);
  }, [walletStr]);

  // ---------- resolve .skr name ----------
  const resolveSkr = useCallback(async () => {
    if (!walletStr) return;
    if (lastResolvedWallet.current === walletStr) return;
    lastResolvedWallet.current = walletStr;

    try {
      const res = await fetch("/api/resolve-name", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ wallet: walletStr }),
        cache: "no-store",
      });

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        setSkrName(null);
        return;
      }

      const data = await res.json();
      const name =
        (data?.name ??
          data?.skr ??
          data?.username ??
          data?.displayName ??
          null) as string | null;

      const cleaned = name && String(name).trim() ? String(name).trim() : null;
      setSkrName(cleaned);
    } catch {
      setSkrName(null);
    }
  }, [walletStr]);

  useEffect(() => {
    if (!connected || !walletStr) return;
    resolveSkr();
  }, [connected, walletStr, resolveSkr]);

  // ---------- load status ----------
  const loadStatus = useCallback(async () => {
    if (!walletStr) return;

    const res = await fetch("/api/checkin/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: walletStr }),
      cache: "no-store",
    });

    const json = await res.json().catch(() => ({}));
    setStatus(json);

    if (json?.missedDays > 0) {
      await loadQuote();
    } else {
      setQuote(null);
    }
  }, [walletStr, loadQuote]);

  // ---------- verify ----------
  const verifyWallet = useCallback(async () => {
    if (!connected || !walletStr || !signMessage) {
      setMsg("Connect a wallet first.");
      return;
    }

    try {
      setVerifying(true);
      setMsg("");

      const nonceRes = await fetch("/api/auth/nonce", { cache: "no-store" });
      const nonceJson = await nonceRes.json().catch(() => ({}));

      if (!nonceRes.ok || !nonceJson?.message) {
        setMsg(nonceJson?.error || "Failed to get auth nonce");
        return;
      }

      const signature = await signMessage(
        new TextEncoder().encode(nonceJson.message)
      );

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: walletStr,
          message: nonceJson.message,
          signature: toBase64(signature),
        }),
        cache: "no-store",
      });

      const verifyJson = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !verifyJson.ok) {
        setMsg(verifyJson?.error || "Verification failed.");
        return;
      }

      setSessionVerified(true);
      setMsg("Wallet verified");
      await loadStatus();
      await loadQuote();
    } catch {
      setMsg("Verification error.");
    } finally {
      setVerifying(false);
    }
  }, [connected, walletStr, signMessage, loadStatus, loadQuote]);

  // ---------- check in (NORMAL / NO NONCE) ----------
  const checkIn = useCallback(async () => {
    if (!walletStr) return;

    setMsg("");

    try {
      const res = await fetch("/api/checkin/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: walletStr,
          action: "checkin",
        }),
        cache: "no-store",
      });

      const json = await res.json().catch(() => ({}));

      if (res.status === 409 && json?.error === "rescue_required") {
        await loadQuote();
        return;
      }

      if (!res.ok) {
        setMsg(json?.error || "Check-in failed.");
        return;
      }

      setMsg(`Checked in • Streak ${json.streak}`);
      setQuote(null);
      await loadStatus();
    } catch (e: any) {
      setMsg(e?.message || "Check-in failed.");
    }
  }, [walletStr, loadStatus, loadQuote]);

  // ---------- reset streak (free) ----------
  const resetStreak = useCallback(async () => {
    if (!walletStr) return;

    try {
      setResetting(true);
      setMsg("");

      const res = await fetch("/api/checkin/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: walletStr,
          action: "reset_streak",
        }),
        cache: "no-store",
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to reset streak");

      setMsg("Streak reset — protections refreshed. Keep checking in daily.");
      setQuote(null);
      await loadStatus();
      await loadQuote();
    } catch (e: any) {
      setMsg(e?.message || "Failed to reset streak");
    } finally {
      setResetting(false);
    }
  }, [walletStr, loadStatus, loadQuote]);

  // ---------- pay protection (still rescue_paid on backend) ----------
  const payProtection = useCallback(async () => {
    if (!publicKey || !walletStr) {
      setMsg("Wallet not ready.");
      return;
    }

    const canProtect = !!(quote?.canProtect ?? quote?.canRescue);
    if (!canProtect) {
      setMsg("Protection not available.");
      return;
    }

    const adapter: any = wallet?.adapter;
    if (!adapter?.signTransaction) {
      setMsg("Wallet cannot sign transactions (signTransaction missing).");
      return;
    }

    try {
      setPaying(true);
      setMsg("");

      const mint = new PublicKey(quote!.mint);
      const treasuryOwner = new PublicKey(quote!.treasury);
      const decimals = quote!.decimals ?? 6;

      const cost = Number(quote!.protectionCostSKR ?? quote!.costSKR ?? 0);

      const fromAta = getAssociatedTokenAddressSync(mint, publicKey);
      const toAta = getAssociatedTokenAddressSync(mint, treasuryOwner);

      const rawAmount = BigInt(cost) * BigInt(10) ** BigInt(decimals);

      const ixs = [
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          toAta,
          treasuryOwner,
          mint
        ),
        createTransferCheckedInstruction(
          fromAta,
          mint,
          toAta,
          publicKey,
          rawAmount,
          decimals
        ),
      ];

      const { conn: rpcConn, blockhash, lastValidBlockHeight, rpc } =
        await getWorkingConnectionForBlockhash();

      console.info(`[payProtection] using rpc=${rpc} (v0 tx)`);

      const msgV0 = new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const vtx = new VersionedTransaction(msgV0);
      const signed: VersionedTransaction = await adapter.signTransaction(vtx);

      const sig = await rpcConn.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      const latest = await rpcConn.getLatestBlockhash("confirmed");

      await rpcConn.confirmTransaction(
      {
      signature: sig,
      blockhash: latest.blockhash,
     lastValidBlockHeight: latest.lastValidBlockHeight,
     },
      "confirmed"
      );

      setMsg("Payment sent. Verifying…");

      const commitRes = await fetch("/api/checkin/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: walletStr,
          action: "rescue_paid",
          rescueDays: quote!.missedDays,
          txSig: sig,
        }),
        cache: "no-store",
      });

      const commitJson = await commitRes.json().catch(() => ({}));
      if (!commitRes.ok) throw new Error(commitJson?.error || "Commit failed");

      setMsg(
        `Protected ${commitJson.protectedDays ?? commitJson.rescuedDays} day(s) ✓`
      );
      await loadStatus();
      await loadQuote();
    } catch (e: any) {
      setMsg(e?.message || "Payment failed");
    } finally {
      setPaying(false);
    }
  }, [publicKey, walletStr, quote, wallet, loadStatus, loadQuote]);

  if (!mounted) return null;

  const connectedLabel = (skrName && skrName.trim()) || shortWallet(walletStr);

  const showProtectionCard =
    !!quote &&
    quote.ok &&
    !!(quote.canProtect ?? quote.canRescue) &&
    quote.missedDays > 0;

  const protectionsLeft =
    Number(status?.protectionsLeft ?? status?.remainingRescue ?? 0);

  return (
    <main className="ssShell">
      <section className="ssCard">
        <div className="ssHero">
          <div className="ssOrbit" />
          <div className="ssKicker">Proof of Consistency</div>
          <h1>Seeker Streaks</h1>
          <p>Daily streaks for Solana Seeker users</p>
        </div>

        {/* ---------------- TERMS UPDATE BANNER (UI ONLY) ---------------- */}
        {showTermsBanner && (
          <a
            href={TERMS_URL}
            target="_blank"
            rel="noreferrer"
            className="ssNotice"
          >
            <strong>Terms updated:</strong> Continued use of Seeker Streaks
            constitutes acceptance of the updated Terms. <span>View Terms →</span>
          </a>
        )}
        {/* -------------------------------------------------------------- */}

        <div className="ssPanel ssWalletPanel">
          <WalletMultiButton />

          {connected && (
            <div className="ssConnected">
              <span>Connected:</span>{" "}
              <strong>{connectedLabel}</strong>

              {!skrName && (
                <div className="ssHint">
                  Set your .skr as Main Domain in AllDomains to display your name
                </div>
              )}
            </div>
          )}

          {connected && !sessionVerified && (
            <button
              onClick={verifyWallet}
              disabled={verifying}
              className="ssButton ssButtonPrimary"
            >
              {verifying ? "Verifying…" : "Verify wallet"}
            </button>
          )}

          {sessionVerified && (
            <div className="ssVerified">
              <span className="ssVerifiedDot" />
              Verified
            </div>
          )}
        </div>

        {status && (
          <div className="ssStats">
            <div className="ssStat">
              <span>Streak</span>
              <strong>{status.streak}</strong>
            </div>
            <div className="ssStat">
              <span>Missed days</span>
              <strong>{status.missedDays}</strong>
            </div>
            <div className="ssStat">
              <span>Protections left</span>
              <strong>{protectionsLeft}</strong>
            </div>
          </div>
        )}

        {showProtectionCard && (
          <div className="ssPanel ssProtection">
            <div className="ssPanelTitle">Protect your streak</div>

            <p>
              You missed <strong>{quote!.missedDays}</strong> day(s). Pay{" "}
              <strong>{quote!.protectionCostSKR ?? quote!.costSKR} SKR</strong>{" "}
              to protect your current streak.
            </p>

            <button
              onClick={payProtection}
              disabled={paying || resetting}
              className="ssButton ssButtonPrimary"
            >
              {paying
                ? "Paying…"
                : `Pay ${quote!.protectionCostSKR ?? quote!.costSKR} SKR`}
            </button>

            <button
              onClick={resetStreak}
              disabled={resetting || paying}
              className="ssButton ssButtonGhost"
            >
              {resetting ? "Resetting…" : "Reset streak (free)"}
            </button>

            <div className="ssSmallText">
              Resets your streak to <strong>1</strong> but{" "}
              <strong>refreshes protections</strong>. You still keep your points.
            </div>
          </div>
        )}

        <button
          onClick={checkIn}
          disabled={!sessionVerified || showProtectionCard}
          className={`ssButton ssCheckIn ${
            !sessionVerified || showProtectionCard ? "disabled" : ""
          }`}
        >
          {showProtectionCard ? "Protection required" : "Check in"}
        </button>

        {msg && <div className="ssMessage">{msg}</div>}

        <div className="ssNavButtons">
          <Link href="/leaderboard" className="ssNavButton ssNavPrimary">
            <span>
              <strong>All-Time Leaderboard</strong>
              <small>The line continues</small>
            </span>
            <b>→</b>
          </Link>

          <Link href="/founder-era" className="ssNavButton ssNavFounder">
            <span>
              <strong>Founder Era Snapshot</strong>
              <small>104 days preserved</small>
            </span>
            <b>→</b>
          </Link>
        </div>
      </section>

      <style>{`
        :root {
          --ss-bg: #030412;
          --ss-card: rgba(7, 9, 24, 0.74);
          --ss-panel: rgba(255, 255, 255, 0.055);
          --ss-line: rgba(255, 255, 255, 0.13);
          --ss-text: #f3f7ff;
          --ss-muted: rgba(243, 247, 255, 0.68);
          --ss-cyan: #27e7ff;
          --ss-violet: #8c52ff;
          --ss-pink: #ff3bd4;
          --ss-gold: #ffd66b;
          --ss-green: #00ffa3;
        }

        @keyframes ssDrift {
          0%, 100% { transform: scale(1.02) translate3d(0, 0, 0); }
          50% { transform: scale(1.06) translate3d(-10px, -8px, 0); }
        }

        @keyframes ssPulse {
          0%, 100% { opacity: .58; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.04); }
        }

        .ssShell {
          min-height: 100vh;
          width: 100%;
          position: relative;
          overflow: hidden;
          display: flex;
          justify-content: center;
          align-items: flex-start;
          padding: 24px;
          color: var(--ss-text);
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
          background: var(--ss-bg);
        }

        .ssShell::before {
          content: "";
          position: fixed;
          inset: -32px;
          pointer-events: none;
          background-image:
            linear-gradient(180deg, rgba(0,0,0,.08), rgba(0,0,0,.70)),
            radial-gradient(800px 450px at 18% 8%, rgba(255,59,212,.24), transparent 62%),
            radial-gradient(760px 430px at 86% 10%, rgba(39,231,255,.25), transparent 62%),
            radial-gradient(700px 480px at 54% 100%, rgba(140,82,255,.23), transparent 68%),
            image-set(url("/leaderboard-cosmic.png") 1x, url("/leaderboard-cosmic@2x.png") 2x),
            radial-gradient(rgba(255,255,255,.12) 1px, transparent 1px);
          background-size: auto, auto, auto, auto, cover, 150px 150px;
          background-position: center;
          background-repeat: no-repeat, no-repeat, no-repeat, no-repeat, no-repeat, repeat;
          filter: saturate(1.08) contrast(1.06);
          animation: ssDrift 32s ease-in-out infinite;
          transform-origin: center;
        }

        .ssShell::after {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background:
            linear-gradient(180deg, transparent, rgba(3,4,18,.38)),
            radial-gradient(circle at 24% 22%, rgba(255,255,255,.50) 0 1px, transparent 2px),
            radial-gradient(circle at 78% 28%, rgba(39,231,255,.40) 0 1px, transparent 2px),
            radial-gradient(circle at 52% 76%, rgba(255,59,212,.30) 0 1px, transparent 2px);
          background-size: auto, 520px 520px, 700px 700px, 860px 860px;
          mix-blend-mode: screen;
          opacity: .32;
        }

        .ssCard {
          width: min(480px, 100%);
          position: relative;
          z-index: 1;
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 28px;
          padding: 18px;
          background:
            radial-gradient(760px 260px at 18% 0%, rgba(255,59,212,.14), transparent 62%),
            radial-gradient(760px 260px at 88% 0%, rgba(39,231,255,.14), transparent 62%),
            linear-gradient(180deg, rgba(8,10,28,.82), rgba(4,6,20,.76));
          backdrop-filter: blur(20px) saturate(1.15);
          -webkit-backdrop-filter: blur(20px) saturate(1.15);
          box-shadow:
            0 30px 120px rgba(0,0,0,.72),
            inset 0 1px 0 rgba(255,255,255,.08);
          overflow: hidden;
        }

        .ssCard::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(140deg, rgba(255,59,212,.42), rgba(39,231,255,.36), rgba(255,214,107,.20));
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
        }

        .ssHero {
          position: relative;
          padding: 8px 4px 18px;
        }

        .ssOrbit {
          position: absolute;
          right: -82px;
          top: -100px;
          width: 220px;
          height: 220px;
          border: 1px solid rgba(39,231,255,.18);
          border-radius: 999px;
          box-shadow: inset 0 0 42px rgba(140,82,255,.14), 0 0 70px rgba(39,231,255,.10);
          pointer-events: none;
        }

        .ssKicker {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 1.6px;
          text-transform: uppercase;
          color: var(--ss-muted);
        }

        .ssKicker::before {
          content: "";
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--ss-pink), var(--ss-cyan));
          box-shadow: 0 0 20px rgba(39,231,255,.7);
          animation: ssPulse 3s ease-in-out infinite;
        }

        .ssHero h1 {
          margin: 10px 0 8px;
          font-size: clamp(34px, 9vw, 52px);
          line-height: .92;
          letter-spacing: -.06em;
          font-weight: 1000;
        }

        .ssHero p {
          margin: 0;
          color: var(--ss-muted);
          font-size: 15px;
        }

        .ssNotice,
        .ssPanel,
        .ssStats,
        .ssNavButton {
          border: 1px solid var(--ss-line);
          background: var(--ss-panel);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.055);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }

        .ssNotice {
          display: block;
          margin-bottom: 14px;
          padding: 12px;
          border-radius: 16px;
          font-size: 13px;
          text-decoration: none;
          color: var(--ss-text);
        }

        .ssNotice span { text-decoration: underline; }

        .ssPanel {
          border-radius: 20px;
          padding: 16px;
          margin-bottom: 14px;
        }

        .ssWalletPanel :global(.wallet-adapter-button) {
          width: 100%;
          justify-content: center;
          border-radius: 14px !important;
          background: linear-gradient(135deg, rgba(140,82,255,.95), rgba(39,231,255,.90)) !important;
          color: #050713 !important;
          font-weight: 900 !important;
          box-shadow: 0 16px 42px rgba(39,231,255,.13) !important;
        }

        .ssConnected {
          margin-top: 12px;
          font-size: 14px;
          color: rgba(243,247,255,.82);
        }

        .ssConnected strong { color: white; }

        .ssHint {
          margin-top: 8px;
          font-size: 12px;
          color: var(--ss-muted);
          line-height: 1.4;
        }

        .ssVerified {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-top: 12px;
          font-weight: 900;
          color: var(--ss-cyan);
        }

        .ssVerifiedDot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: var(--ss-green);
          box-shadow: 0 0 16px rgba(0,255,163,.68);
        }

        .ssStats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          border-radius: 20px;
          padding: 10px;
          margin-bottom: 14px;
        }

        .ssStat {
          min-width: 0;
          padding: 12px 8px;
          border-radius: 15px;
          background:
            radial-gradient(180px 70px at 50% 0%, rgba(39,231,255,.10), transparent 70%),
            rgba(0,0,0,.20);
          text-align: center;
        }

        .ssStat span {
          display: block;
          color: var(--ss-muted);
          font-size: 11px;
          line-height: 1.2;
        }

        .ssStat strong {
          display: block;
          margin-top: 6px;
          font-size: 20px;
          line-height: 1;
          font-weight: 1000;
        }

        .ssPanelTitle {
          font-size: 17px;
          font-weight: 1000;
          margin-bottom: 6px;
        }

        .ssProtection p {
          margin: 0 0 12px;
          color: rgba(243,247,255,.82);
          line-height: 1.45;
        }

        .ssButton {
          width: 100%;
          min-height: 46px;
          border: 0;
          border-radius: 15px;
          padding: 12px 14px;
          font-weight: 950;
          cursor: pointer;
          transition: transform .14s ease, opacity .14s ease, box-shadow .14s ease;
        }

        .ssButton:hover:not(:disabled) { transform: translateY(-1px); }
        .ssButton:active:not(:disabled) { transform: translateY(0) scale(.99); }

        .ssButtonPrimary {
          margin-top: 12px;
          background: linear-gradient(135deg, var(--ss-pink), var(--ss-violet) 48%, var(--ss-cyan));
          color: #050713;
          box-shadow: 0 18px 44px rgba(39,231,255,.14);
        }

        .ssButtonGhost {
          margin-top: 10px;
          color: var(--ss-text);
          border: 1px solid rgba(255,255,255,.16);
          background: rgba(255,255,255,.045);
        }

        .ssCheckIn {
          margin-bottom: 12px;
          background: linear-gradient(135deg, var(--ss-cyan), var(--ss-violet));
          color: #050713;
          box-shadow: 0 18px 44px rgba(39,231,255,.14);
        }

        .ssCheckIn.disabled {
          background: rgba(255,255,255,.08);
          color: rgba(243,247,255,.38);
          cursor: not-allowed;
          box-shadow: none;
        }

        .ssSmallText {
          margin-top: 10px;
          color: var(--ss-muted);
          font-size: 12px;
          line-height: 1.45;
        }

        .ssMessage {
          text-align: center;
          color: rgba(243,247,255,.86);
          margin: 0 0 12px;
          font-size: 14px;
        }

        .ssNavButtons {
          display: grid;
          gap: 10px;
        }

        .ssNavButton {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px;
          border-radius: 18px;
          text-decoration: none;
          color: var(--ss-text);
          transition: transform .14s ease, border-color .14s ease, background .14s ease, box-shadow .14s ease;
        }

        .ssNavButton:hover {
          transform: translateY(-1px);
          background: rgba(255,255,255,.075);
        }

        .ssNavButton strong,
        .ssNavButton small {
          display: block;
        }

        .ssNavButton strong {
          font-size: 15px;
          font-weight: 1000;
        }

        .ssNavButton small {
          margin-top: 3px;
          font-size: 12px;
          color: var(--ss-muted);
        }

        .ssNavButton b {
          font-size: 20px;
          color: var(--ss-cyan);
        }

        .ssNavPrimary {
          border-color: rgba(39,231,255,.22);
          background:
            radial-gradient(320px 90px at 0% 50%, rgba(39,231,255,.14), transparent 70%),
            rgba(255,255,255,.052);
        }

        .ssNavFounder {
          border-color: rgba(255,214,107,.28);
          background:
            radial-gradient(320px 90px at 0% 50%, rgba(255,214,107,.14), transparent 70%),
            radial-gradient(260px 80px at 100% 50%, rgba(255,59,212,.09), transparent 70%),
            rgba(255,255,255,.052);
        }

        .ssNavFounder b { color: var(--ss-gold); }

        @media (max-width: 430px) {
          .ssShell { padding: 14px; }
          .ssCard { border-radius: 24px; padding: 15px; }
          .ssStats { grid-template-columns: 1fr; }
          .ssHero h1 { font-size: 38px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .ssShell::before,
          .ssKicker::before {
            animation: none !important;
          }
          .ssButton,
          .ssNavButton {
            transition: none !important;
          }
        }
      `}</style>
    </main>
  );
}
