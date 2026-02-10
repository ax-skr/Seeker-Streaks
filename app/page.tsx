"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
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

function isSolanaMobileUA() {
  if (typeof navigator === "undefined") return false;
  return /SolanaMobile|SeedVault|Seeker/i.test(navigator.userAgent);
}

function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// ---------- types ----------
type RescueQuote = {
  ok: boolean;
  verified: boolean;
  missedDays: number;
  canRescue: boolean;
  costSKR: number;
  streak: number;
  remainingRescue: number;
  treasury: string;
  mint: string;
  decimals?: number;
};

export default function Home() {
  const {
    publicKey,
    connected,
    connecting,
    disconnecting,
    signMessage,
    wallet,
    wallets,
    select,
    connect,
    disconnect,
  } = useWallet();

  const { connection } = useConnection(); // kept if you use it elsewhere

  const [mounted, setMounted] = useState(false);
  const [sessionVerified, setSessionVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [msg, setMsg] = useState<string>("");

  const [skrName, setSkrName] = useState<string | null>(null);
  const lastResolvedWallet = useRef<string | null>(null);

  const [rescueQuote, setRescueQuote] = useState<RescueQuote | null>(null);
  const [paying, setPaying] = useState(false);
  const [resetting, setResetting] = useState(false);

  // ✅ local UI lock so we can recover even if wallet-adapter stays stuck
  const [uiConnecting, setUiConnecting] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setSessionVerified(false);
    setStatus(null);
    setSkrName(null);
    setRescueQuote(null);
    lastResolvedWallet.current = null;
    setMsg("");
  }, [publicKey]);

  const walletStr = useMemo(() => publicKey?.toBase58() ?? null, [publicKey]);

  // ✅ auto-select the only wallet
  useEffect(() => {
    if (!mounted) return;
    if (wallet) return;
    if (!wallets || wallets.length === 0) return;

    const first = wallets[0];
    if (first?.adapter?.name) {
      select(first.adapter.name);
    }
  }, [mounted, wallet, wallets, select]);

  // ✅ FIX: connect with timeout + recover
  const handleConnect = useCallback(async () => {
    try {
      setMsg("");

      if (!wallets || wallets.length === 0) {
        setMsg("Wallets not loaded yet (wait 1–2 seconds then try again).");
        return;
      }

      // ensure selection exists
      if (!wallet?.adapter?.name) {
        const first = wallets[0];
        if (first?.adapter?.name) {
          select(first.adapter.name);
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (connected) {
        await disconnect();
        return;
      }

      setUiConnecting(true);

      // If the wallet app/Seed Vault doesn't appear and return within ~10s, stop hanging.
      await withTimeout(connect(), 10000, "Seed Vault did not return");

      setUiConnecting(false);
    } catch (e: any) {
      console.error(e);

      // Always clear the UI lock even if adapter-react stays in a weird state
      setUiConnecting(false);

      const m = e?.message ? String(e.message) : String(e);

      if (m === "Seed Vault did not return") {
        setMsg(
          "Seed Vault didn’t open/return. Tap Connect again. If it keeps happening, fully close the wallet/Seed Vault app and reopen this page."
        );
        return;
      }

      const hint = isSolanaMobileUA()
        ? ""
        : " (You’re not in a SolanaMobile/SeedVault browser context.)";

      setMsg(`Connect failed: ${m}${hint}`);
    }
  }, [wallets, wallet, select, connected, connect, disconnect]);

  const cancelConnect = useCallback(async () => {
    try {
      setMsg("Cancelled. Try Connect again.");
      setUiConnecting(false);
      // best-effort reset
      if (connected) {
        await disconnect();
      }
    } catch {
      setUiConnecting(false);
    }
  }, [connected, disconnect]);

  // ---------- rescue quote ----------
  const loadRescueQuote = useCallback(async () => {
    if (!walletStr) return;

    const res = await fetch("/api/checkin/rescue-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: walletStr }),
      cache: "no-store",
    });

    if (!res.ok) {
      const t = await res.text();
      setMsg(`Rescue quote failed (${res.status}).`);
      console.error("rescue-quote error:", t);
      return;
    }

    const q = (await res.json()) as RescueQuote;
    setRescueQuote(q);
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
      await loadRescueQuote();
    } else {
      setRescueQuote(null);
    }
  }, [walletStr, loadRescueQuote]);

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
      await loadRescueQuote();
    } catch {
      setMsg("Verification error.");
    } finally {
      setVerifying(false);
    }
  }, [connected, walletStr, signMessage, loadStatus, loadRescueQuote]);

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
      setMsg("");
      await loadRescueQuote();
      return;
    }

    if (!res.ok) {
      setMsg(json.error || "Check-in failed.");
      return;
    }

    setMsg(`Checked in • Streak ${json.streak}`);
    setRescueQuote(null);
    await loadStatus();
  }, [walletStr, loadStatus, loadRescueQuote]);

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

      if (!res.ok) {
        throw new Error(json?.error || "Failed to reset streak");
      }

      setMsg("Streak reset — rescues refreshed. Keep checking in daily.");
      setRescueQuote(null);
      await loadStatus();
      await loadRescueQuote();
    } catch (e: any) {
      console.error(e);
      setMsg(e?.message || "Failed to reset streak");
    } finally {
      setResetting(false);
    }
  }, [walletStr, loadStatus, loadRescueQuote]);

  // ---------- pay rescue ----------
  const payRescue = useCallback(async () => {
    if (!publicKey || !walletStr) {
      setMsg("Wallet not ready.");
      return;
    }

    if (!rescueQuote?.canRescue) {
      setMsg("Rescue not available.");
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

      const mint = new PublicKey(rescueQuote.mint);
      const treasuryOwner = new PublicKey(rescueQuote.treasury);
      const decimals = rescueQuote.decimals ?? 6;

      const fromAta = getAssociatedTokenAddressSync(mint, publicKey);
      const toAta = getAssociatedTokenAddressSync(mint, treasuryOwner);

      const rawAmount =
        BigInt(rescueQuote.costSKR) * BigInt(10) ** BigInt(decimals);

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

      console.info(`[payRescue] using rpc=${rpc} (v0 tx)`);

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
          rescueDays: rescueQuote.missedDays,
          txSig: sig,
        }),
      });

      const commitJson = await commitRes.json().catch(() => ({}));

      if (!commitRes.ok) {
        throw new Error(commitJson.error || "Commit failed");
      }

      setMsg(`Rescued ${commitJson.rescuedDays} day(s) ✓`);
      await loadStatus();
      await loadRescueQuote();
    } catch (e: any) {
      console.error(e);
      setMsg(e?.message || "Payment failed");
    } finally {
      setPaying(false);
    }
  }, [publicKey, walletStr, rescueQuote, wallet, loadStatus, loadRescueQuote]);

  if (!mounted) return null;

  const connectedLabel = (skrName && skrName.trim()) || shortWallet(walletStr);

  const showRescueCard =
    !!rescueQuote &&
    rescueQuote.ok &&
    rescueQuote.canRescue &&
    rescueQuote.missedDays > 0;

  const uaIsSolanaMobile = isSolanaMobileUA();
  const selectedWalletName = wallet?.adapter?.name ?? "None";
  const readyState = (wallet?.adapter as any)?.readyState ?? "Unknown";

  const showBlockingOverlay = uiConnecting || connecting;

  return (
    <main
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(1200px 600px at 10% -10%, #6d28d9 0%, transparent 40%), radial-gradient(800px 400px at 90% 10%, #22d3ee 0%, transparent 40%), #020617",
        color: "#e5e7eb",
        padding: 24,
        fontFamily: "system-ui",
        position: "relative",
      }}
    >
      {/* ✅ RECOVERY OVERLAY */}
      {showBlockingOverlay && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              background: "#020617",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 14,
              padding: 16,
              textAlign: "center",
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 6 }}>
              Waiting for Seed Vault…
            </div>
            <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 12 }}>
              If the wallet app didn’t open, it may have opened behind, or didn’t
              return to the browser.
            </div>
            <button
              onClick={cancelConnect}
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: 10,
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "#e5e7eb",
                fontWeight: 900,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>Seeker Streaks</h1>
        <p style={{ opacity: 0.75, marginBottom: 20 }}>
          Daily streaks for Solana Seeker users
        </p>

        {/* DEBUG */}
        <div
          style={{
            background: "rgba(2,6,23,0.9)",
            border: "1px solid rgba(255,255,255,0.10)",
            borderRadius: 14,
            padding: 14,
            marginBottom: 12,
            fontSize: 12,
            lineHeight: 1.35,
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Debug (MWA)</div>
          <div>UA SolanaMobile/SeedVault: {String(uaIsSolanaMobile)}</div>
          <div>wallets (adapter-react): {wallets?.length ?? 0}</div>
          <div>selected wallet: {selectedWalletName}</div>
          <div>readyState: {String(readyState)}</div>
          <div>
            connected: {String(connected)} • connecting: {String(connecting)} •
            uiConnecting: {String(uiConnecting)} • pubkey:{" "}
            {publicKey ? "yes" : "none"}
          </div>
        </div>

        <div
          style={{
            background: "#020617",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 14,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <button
            onClick={handleConnect}
            disabled={connecting || disconnecting || uiConnecting}
            style={{
              width: "100%",
              padding: "12px",
              borderRadius: 10,
              background: "linear-gradient(90deg,#7c3aed,#22d3ee)",
              border: "none",
              color: "#020617",
              fontWeight: 700,
              cursor:
                connecting || disconnecting || uiConnecting
                  ? "not-allowed"
                  : "pointer",
              opacity: connecting || disconnecting || uiConnecting ? 0.7 : 1,
            }}
          >
            {connected
              ? "Disconnect wallet"
              : connecting || uiConnecting
              ? "Connecting…"
              : "Connect wallet"}
          </button>

          {connected && (
            <div style={{ marginTop: 12, fontSize: 14, opacity: 0.85 }}>
              Connected:{" "}
              <span style={{ fontWeight: 800 }}>{connectedLabel}</span>
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
            <div>🛡️ Rescues left: {status.remainingRescue}</div>
          </div>
        )}

        {showRescueCard && (
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
              🛟 Rescue your streak
            </div>

            <div style={{ opacity: 0.85, marginBottom: 12 }}>
              You missed <strong>{rescueQuote!.missedDays}</strong> day(s). Pay{" "}
              <strong>{rescueQuote!.costSKR} SKR</strong> to keep your streak.
            </div>

            <button
              onClick={payRescue}
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
              }}
            >
              {paying ? "Paying…" : `Pay ${rescueQuote!.costSKR} SKR`}
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
              }}
            >
              {resetting ? "Resetting…" : "Reset streak (free)"}
            </button>
          </div>
        )}

        <button
          onClick={checkIn}
          disabled={!sessionVerified || showRescueCard}
          style={{
            width: "100%",
            padding: "14px",
            borderRadius: 12,
            background:
              !sessionVerified || showRescueCard
                ? "#1f2933"
                : "linear-gradient(90deg,#22d3ee,#7c3aed)",
            border: "none",
            color: !sessionVerified || showRescueCard ? "#6b7280" : "#020617",
            fontWeight: 800,
            cursor:
              !sessionVerified || showRescueCard ? "not-allowed" : "pointer",
            marginBottom: 12,
          }}
        >
          {showRescueCard ? "Rescue required" : "Check in"}
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
