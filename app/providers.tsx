"use client";

import React, { ReactNode, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { clusterApiUrl } from "@solana/web3.js";

import * as Mobile from "@solana-mobile/wallet-adapter-mobile";

export default function Providers({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);

  const wallets = useMemo(() => {
    // These exist in the package, but TS versions/types sometimes mismatch.
    // We pull them safely.
    const createDefaultAuthorizationResultCache =
      (Mobile as any).createDefaultAuthorizationResultCache;
    const createDefaultAddressSelector =
      (Mobile as any).createDefaultAddressSelector;

    const authorizationResultCache = createDefaultAuthorizationResultCache
      ? createDefaultAuthorizationResultCache()
      : undefined;

    const addressSelector = createDefaultAddressSelector
      ? createDefaultAddressSelector()
      : undefined;

    // IMPORTANT: Some versions export a class, others export different shapes.
    // This resolves the constructor reliably.
    const MWAConstructor =
      (Mobile as any).SolanaMobileWalletAdapter ||
      (Mobile as any).default ||
      null;

    if (!MWAConstructor) {
      console.error(
        "Solana Mobile Wallet Adapter constructor not found. Check @solana-mobile/wallet-adapter-mobile version/exports."
      );
      return [];
    }

    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://seeker-streaks.vercel.app";

    return [
      new MWAConstructor({
        addressSelector,
        authorizationResultCache,
        appIdentity: {
          name: "Seeker Streaks",
          // Keep as strings for widest compatibility (some typings reject URL objects)
          uri: origin,
          icon: `${origin}/icon-192.png`,
        },
      }),
    ];
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets as any} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
