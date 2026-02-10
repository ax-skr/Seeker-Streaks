"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import "@solana/wallet-adapter-react-ui/styles.css";

// ✅ Solana Mobile adapter ONLY (Seeker / Seed Vault)
import * as solanaMobile from "@solana-mobile/wallet-adapter-mobile";

export default function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = "https://api.mainnet-beta.solana.com";
  const [origin, setOrigin] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const wallets = useMemo(() => {
    if (!origin) return [];

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
      {/* ✅ FIX: autoConnect OFF for MWA */}
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
