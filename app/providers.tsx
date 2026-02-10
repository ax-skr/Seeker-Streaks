"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import "@solana/wallet-adapter-react-ui/styles.css";

// ✅ Solana Mobile adapter ONLY (Seeker / Seed Vault)
import * as solanaMobile from "@solana-mobile/wallet-adapter-mobile";

export default function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = "https://api.mainnet-beta.solana.com";

  // ✅ IMPORTANT: compute origin synchronously (no "blank origin" first render)
  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);

  // ✅ Keep ONE stable adapter instance for the whole app lifecycle
  const adapterRef = useRef<any>(null);

  // Debug state (optional but helpful)
  const [adapterName, setAdapterName] = useState<string>("none");
  const [adapterReady, setAdapterReady] = useState<string>("unknown");

  const wallets = useMemo(() => {
    const MobileAdapterCtor =
      (solanaMobile as any).SolanaMobileWalletAdapter || (solanaMobile as any).default;

    const createDefaultAddressSelector = (solanaMobile as any).createDefaultAddressSelector;
    const createDefaultAuthorizationResultCache =
      (solanaMobile as any).createDefaultAuthorizationResultCache;

    if (!MobileAdapterCtor) {
      console.error(
        "[Providers] SolanaMobileWalletAdapter not found in @solana-mobile/wallet-adapter-mobile"
      );
      return [];
    }

    const addressSelector =
      typeof createDefaultAddressSelector === "function"
        ? createDefaultAddressSelector()
        : { select: async (addresses: string[]) => addresses?.[0] };

    const authorizationResultCache =
      typeof createDefaultAuthorizationResultCache === "function"
        ? createDefaultAuthorizationResultCache()
        : { clear: async () => {}, get: async () => null, set: async () => {} };

    // ✅ Create once
    if (!adapterRef.current) {
      adapterRef.current = new MobileAdapterCtor({
        addressSelector,
        authorizationResultCache,
        appIdentity: {
          name: "Seeker Streaks",
          // ✅ IMPORTANT: always provide a real URI
          uri: origin || "https://seeker-streaks.vercel.app",
          icon: origin ? `${origin}/icon-192.png` : "https://seeker-streaks.vercel.app/icon-192.png",
        },
      });

      try {
        setAdapterName(String(adapterRef.current?.name ?? "Mobile Wallet Adapter"));
        setAdapterReady(String(adapterRef.current?.readyState ?? "unknown"));
      } catch {}
    }

    return [adapterRef.current];
  }, [origin]);

  // Keep debug labels updated (not required, but useful)
  useEffect(() => {
    const a = adapterRef.current;
    if (!a) return;

    const tick = () => {
      try {
        setAdapterName(String(a?.name ?? "Mobile Wallet Adapter"));
        setAdapterReady(String(a?.readyState ?? "unknown"));
      } catch {}
    };

    tick();
    const id = setInterval(tick, 800);
    return () => clearInterval(id);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      {/* ✅ CRITICAL: autoConnect OFF (prevents stuck “dark overlay” loops) */}
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
