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

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setSessionVerified(false);
    setStatus(null);
    setSkrName(null);
    setQuote(null);
    lastResolvedWallet.current = null;
    setMsg("");
  }, [publicKey]);

  const walletStr = useMemo(() => publicKey?.toBase58() ?? null, [publicKey]);

  // ---------- load protection quote (same route) ----------
  const loadQuote = useCallback(async () => {
    if (!walletStr) return;

    const res = await fetch("/api/checkin/rescue-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: walletStr }),
      cache: "no-store",
    });

    if (!res.ok) {
      const t = await res.text();
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
    });

    const json = await res.json();
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

      const nonceRes = await fetch("/api/auth/nonce");
      const nonceJson = await nonceRes.json();

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
      });

      const verifyJson = await verifyRes.json();
      if (!verifyJson.ok) {
        setMsg("Verification failed.");
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

  // ---------- check in ----------
  const checkIn = useCallback(async () => {
    if (!walletStr) return;

    setMsg("");

    const res = await fetch("/api/checkin/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: walletStr,
        action: "checkin",
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (res.status === 409 && json?.error === "rescue_required") {
      // protection required
      await loadQuote();
      return;
    }

    if (!res.ok) {
      setMsg(json.error || "Check-in failed.");
      return;
    }

    setMsg(`Checked in • Streak ${json.streak}`);
    setQuote(null);
    await loadStatus();
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

      await rpcConn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
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
      });

      const commitJson = await commitRes.json().catch(() => ({}));
      if (!commitRes.ok) throw new Error(commitJson.error || "Commit failed");

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
    <main
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(1200px 600px at 10% -10%, #6d28d9 0%, transparent 40%), radial-gradient(800px 400px at 90% 10%, #22d3ee 0%, transparent 40%), #020617",
        color: "#e5e7eb",
        padding: 24,
        fontFamily: "system-ui",
      }}
    >
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>Seeker Streaks</h1>
        <p style={{ opacity: 0.75, marginBottom: 20 }}>
          Daily streaks for Solana Seeker users
        </p>

        <div
          style={{
            background: "#020617",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 14,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <WalletMultiButton />

          {connected && (
            <div style={{ marginTop: 12, fontSize: 14, opacity: 0.85 }}>
              Connected:{" "}
              <span style={{ fontWeight: 800 }}>{connectedLabel}</span>

              {/* ✅ Friendly message when no main .skr is set */}
              {!skrName && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                  Set your .skr as Main Domain in AllDomains to display your name
                </div>
              )}
            </div>
          )}

          {connected && !sessionVerified && (
            <button
              onClick={verifyWallet}
              disabled={verifying}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "12px",
                borderRadius: 10,
                background: "linear-gradient(90deg,#7c3aed,#22d3ee)",
                border: "none",
                color: "#020617",
                fontWeight: 700,
                cursor: "pointer",
                opacity: verifying ? 0.7 : 1,
              }}
            >
              {verifying ? "Verifying…" : "Verify wallet"}
            </button>
          )}

          {sessionVerified && (
            <div style={{ marginTop: 12, fontWeight: 700, color: "#22d3ee" }}>
              Verified ✓
            </div>
          )}
        </div>

        {status && (
          <div
            style={{
              background: "#020617",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 14,
              padding: 16,
              marginBottom: 16,
            }}
          >
            <div>
              🔥 Streak: <strong>{status.streak}</strong>
            </div>
            <div>⏳ Missed days: {status.missedDays}</div>
            <div>🛡️ Protections left: {protectionsLeft}</div>
          </div>
        )}

        {showProtectionCard && (
          <div
            style={{
              background: "#020617",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 14,
              padding: 16,
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>
              🛡️ Protect your streak
            </div>

            <div style={{ opacity: 0.85, marginBottom: 12 }}>
              You missed <strong>{quote!.missedDays}</strong> day(s). Pay{" "}
              <strong>{quote!.protectionCostSKR ?? quote!.costSKR} SKR</strong>{" "}
              to protect your current streak.
            </div>

            <button
              onClick={payProtection}
              disabled={paying || resetting}
              style={{
                width: "100%",
                padding: "14px",
                borderRadius: 12,
                background: "linear-gradient(90deg,#22d3ee,#7c3aed)",
                border: "none",
                color: "#020617",
                fontWeight: 900,
                cursor: paying || resetting ? "not-allowed" : "pointer",
                opacity: paying || resetting ? 0.7 : 1,
              }}
            >
              {paying
                ? "Paying…"
                : `Pay ${quote!.protectionCostSKR ?? quote!.costSKR} SKR`}
            </button>

            <button
              onClick={resetStreak}
              disabled={resetting || paying}
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: 12,
                marginTop: 10,
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "#e5e7eb",
                fontWeight: 900,
                cursor: resetting || paying ? "not-allowed" : "pointer",
                opacity: resetting || paying ? 0.7 : 1,
              }}
            >
              {resetting ? "Resetting…" : "Reset streak (free)"}
            </button>

            <div
              style={{
                marginTop: 10,
                opacity: 0.75,
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              Resets your streak to <strong>1</strong> but{" "}
              <strong>refreshes protections</strong>. You still keep your points.
            </div>
          </div>
        )}

        <button
          onClick={checkIn}
          disabled={!sessionVerified || showProtectionCard}
          style={{
            width: "100%",
            padding: "14px",
            borderRadius: 12,
            background:
              !sessionVerified || showProtectionCard
                ? "#1f2933"
                : "linear-gradient(90deg,#22d3ee,#7c3aed)",
            border: "none",
            color:
              !sessionVerified || showProtectionCard ? "#6b7280" : "#020617",
            fontWeight: 800,
            cursor:
              !sessionVerified || showProtectionCard ? "not-allowed" : "pointer",
            marginBottom: 12,
          }}
        >
          {showProtectionCard ? "Protection required" : "Check in"}
        </button>

        {msg && (
          <div style={{ textAlign: "center", opacity: 0.9, marginBottom: 10 }}>
            {msg}
          </div>
        )}

        <Link
          href="/leaderboard"
          style={{
            display: "block",
            marginTop: 10,
            textAlign: "center",
            padding: "10px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#e5e7eb",
            textDecoration: "none",
          }}
        >
          View leaderboard →
        </Link>
      </div>
    </main>
  );
}
