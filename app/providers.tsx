"use client";

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import "@solana/wallet-adapter-react-ui/styles.css";

// ✅ Solana Mobile adapter ONLY (Seeker / Seed Vault)
import * as solanaMobile from "@solana-mobile/wallet-adapter-mobile";

export default function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = "https://api.mainnet-beta.solana.com";

  const [origin, setOrigin] = useState<string>("");
  const [originReady, setOriginReady] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
      setOriginReady(true);
    }
  }, []);

  const wallets = useMemo(() => {
    if (!originReady) return [];

    const MobileAdapterCtor =
      (solanaMobile as any).SolanaMobileWalletAdapter ||
      (solanaMobile as any).default;

    const createDefaultAddressSelector =
      (solanaMobile as any).createDefaultAddressSelector;
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

    // IMPORTANT: keep the cache stable + recoverable
    const authorizationResultCache =
      typeof createDefaultAuthorizationResultCache === "function"
        ? createDefaultAuthorizationResultCache()
        : { clear: async () => {}, get: async () => null, set: async () => {} };

    try {
      return [
        new MobileAdapterCtor({
          addressSelector,
          authorizationResultCache,
          // ✅ This matters: explicitly set cluster
          cluster: "mainnet-beta",
          appIdentity: {
            name: "Seeker Streaks",
            uri: origin || undefined,
            icon: origin ? `${origin}/icon-192.png` : undefined,
          },
        }),
      ];
    } catch (e) {
      console.error("[Providers] Failed to construct MWA adapter:", e);
      return [];
    }
  }, [origin, originReady]);

  const onError = useCallback((e: any) => {
    console.error("[WalletProvider onError]", e);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      {/* ✅ FIX: turn OFF autoConnect for MWA stability */}
      <WalletProvider wallets={wallets} autoConnect={false} onError={onError}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
