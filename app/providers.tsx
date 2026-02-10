"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import "@solana/wallet-adapter-react-ui/styles.css";

// Solana Mobile adapter ONLY (Seeker / Seed Vault)
import * as solanaMobile from "@solana-mobile/wallet-adapter-mobile";

export default function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = "https://api.mainnet-beta.solana.com";
  const [origin, setOrigin] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const wallets = useMemo(() => {
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

    const authorizationResultCache =
      typeof createDefaultAuthorizationResultCache === "function"
        ? createDefaultAuthorizationResultCache()
        : { clear: async () => {}, get: async () => null, set: async () => {} };

    // IMPORTANT:
    // - Only create the adapter after we know origin (so appIdentity.uri/icon are correct)
    // - MWA hates being auto-connected during hydration, so we will NOT autoConnect
    if (!origin) return [];

    return [
      new MobileAdapterCtor({
        addressSelector,
        authorizationResultCache,
        appIdentity: {
          name: "Seeker Streaks",
          uri: origin,
          icon: `${origin}/icon-192.png`,
        },
      }),
    ];
  }, [origin]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      {/* ✅ DO NOT autoConnect for MWA/SeedVault */}
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
