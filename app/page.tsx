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

function isProbablySolanaMobileEnv(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /SolanaMobile|SeedVault/i.test(ua);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeString(v: any) {
  try {
    return String(v);
  } catch {
    return "Unknown";
  }
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

  // debug / connect state
  const [connectErr, setConnectErr] = useState<string>("");
  const [uaMobile, setUaMobile] = useState(false);
  const [uiBusy, setUiBusy] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => setUaMobile(isProbablySolanaMobileEnv()), []);

  useEffect(() => {
    setSessionVerified(false);
    setStatus(null);
    setSkrName(null);
    setRescueQuote(null);
    lastResolvedWallet.current = null;
    setMsg("");
    setConnectErr("");
  }, [publicKey]);

  const walletStr = useMemo(() => publicKey?.toBase58() ?? null, [publicKey]);

  // IMPORTANT: force-select the only wallet if none selected
  useEffect(() => {
    if (!mounted) return;
    if (wallet) return;
    if (!wallets?.length) return;

    const only = wallets[0]?.adapter?.name;
    if (only) {
      try {
        select(only);
      } catch {}
    }
  }, [mounted, wallet, wallets, select]);

  const activeAdapter: any = useMemo(() => {
    return wallet?.adapter ?? wallets?.[0]?.adapter ?? null;
  }, [wallet, wallets]);

  const activeAdapterName = useMemo(
    () => safeString(activeAdapter?.name ?? "None"),
    [activeAdapter]
  );

  const activeReadyState = useMemo(
    () => safeString(activeAdapter?.readyState ?? "Unknown"),
    [activeAdapter]
  );

  // ---------- HARD RESET (kills stuck sessions) ----------
  const resetWalletSession = useCallback(async () => {
    try {
      setUiBusy(true);
      setMsg("");
      setConnectErr("");

      const adapter: any = activeAdapter;

      // try a clean disconnect
      if (adapter?.disconnect) {
        try {
          await adapter.disconnect();
        } catch {}
      }

      // clear wallet-adapter persisted selection (these are common keys)
      try {
        localStorage.removeItem("walletName");
        localStorage.removeItem("selectedWallet");
        localStorage.removeItem("walletAdapter");
        localStorage.removeItem("wallet-adapter");
      } catch {}

      // force re-select of the only wallet after reload
      await sleep(150);

      // reload clears any stale MWA iframe/intent state
      window.location.reload();
    } finally {
      setUiBusy(false);
    }
  }, [activeAdapter]);

  // ---------- CONNECT (with timeout + better errors) ----------
  const handleConnect = useCallback(async () => {
    if (uiBusy) return;

    try {
      setUiBusy(true);
      setMsg("");
      setConnectErr("");

      // ensure selection exists
      if (!wallet && wallets?.[0]?.adapter?.name) {
        try {
          select(wallets[0].adapter.name);
        } catch {}
      }

      const adapter: any = activeAdapter;

      if (!adapter) {
        setMsg("Wallet adapter not ready (no adapter instance).");
        return;
      }

      // if already connected -> disconnect
      if (connected) {
        if (typeof adapter.disconnect === "function") {
          await adapter.disconnect();
        }
        return;
      }

      if (typeof adapter.connect !== "function") {
        setMsg("Wallet cannot connect (connect missing).");
        return;
      }

      // kick off connect
      await adapter.connect();

      // wait a moment for pubkey to actually populate
      // (MWA sometimes resolves connect before publicKey updates)
      const start = Date.now();
      while (!publicKey && Date.now() - start < 6000) {
        await sleep(150);
      }

      if (!publicKey) {
        const hint =
          "Connect returned but no public key. This usually means the wallet authorization UI didn't complete. " +
          "Try Reset wallet session, then connect again. If you're in a normal browser, try inside the wallet browser / your TWA.";
        setMsg(hint);
        return;
      }
    } catch (e: any) {
      console.error(e);
      const m = e?.message ? String(e.message) : String(e);
      setConnectErr(m);
      setMsg(`Connect failed: ${m}`);
    } finally {
      setUiBusy(false);
    }
  }, [uiBusy, wallet, wallets, select, activeAdapter, connected, publicKey]);

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

  // ---------- pay rescue (VersionedTransaction v0 for Seeker) ----------
  const payRescue = useCallback(async () => {
    if (!publicKey || !walletStr) {
      setMsg("Wallet not ready.");
      return;
    }

    if (!rescueQuote?.canRescue) {
      setMsg("Rescue not available.");
      return;
    }

    const adapter: any = activeAdapter;
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
  }, [publicKey, walletStr, rescueQuote, activeAdapter, loadStatus, loadRescueQuote]);

  if (!mounted) return null;

  const connectedLabel = (skrName && skrName.trim()) || shortWallet(walletStr);

  const showRescueCard =
    !!rescueQuote &&
    rescueQuote.ok &&
    rescueQuote.canRescue &&
    rescueQuote.missedDays > 0;

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

        {/* Debug banner */}
        <div
          style={{
            background: "rgba(2,6,23,0.7)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 14,
            padding: 12,
            marginBottom: 12,
            fontSize: 12,
            lineHeight: 1.35,
            whiteSpace: "pre-wrap",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Debug (MWA)</div>
          <div>UA SolanaMobile/SeedVault: {String(uaMobile)}</div>
          <div>wallets (adapter-react): {wallets?.length ?? 0}</div>
          <div>selected wallet: {wallet?.adapter?.name ?? "None"}</div>
          <div>
            active adapter: {activeAdapterName} • readyState: {activeReadyState}
          </div>
          <div>
            connected: {String(connected)} • connecting: {String(connecting)} •
            disconnecting: {String(disconnecting)} • pubkey:{" "}
            {walletStr ?? "none"}
          </div>
          <div>uiBusy: {String(uiBusy)}</div>
          {connectErr ? (
            <div style={{ marginTop: 6 }}>last error: {connectErr}</div>
          ) : null}
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
            disabled={uiBusy}
            style={{
              width: "100%",
              padding: "12px",
              borderRadius: 10,
              background: "linear-gradient(90deg,#7c3aed,#22d3ee)",
              border: "none",
              color: "#020617",
              fontWeight: 700,
              cursor: uiBusy ? "not-allowed" : "pointer",
              opacity: uiBusy ? 0.7 : 1,
            }}
          >
            {connected ? "Disconnect wallet" : "Connect wallet"}
          </button>

          <button
            onClick={resetWalletSession}
            disabled={uiBusy}
            style={{
              marginTop: 10,
              width: "100%",
              padding: "12px",
              borderRadius: 10,
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.18)",
              color: "#e5e7eb",
              fontWeight: 800,
              cursor: uiBusy ? "not-allowed" : "pointer",
              opacity: uiBusy ? 0.7 : 1,
            }}
          >
            Reset wallet session
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
