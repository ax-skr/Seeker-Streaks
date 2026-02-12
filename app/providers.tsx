"use client";

import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { clusterApiUrl } from "@solana/web3.js";

import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
} from "@solana-mobile/wallet-adapter-mobile";

export default function Providers({ children }: { children: React.ReactNode }) {
  // web3 cluster string (keeps TS happy)
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);

  const wallets = useMemo(() => {
    const uri =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://seeker-streaks.vercel.app";

    const mwa = new SolanaMobileWalletAdapter({
      addressSelector: createDefaultAddressSelector(),
      authorizationResultCache: createDefaultAuthorizationResultCache(),
      appIdentity: {
        name: "Seeker Streaks",
        uri,
        icon: "https://seeker-streaks.vercel.app/icon-192.png",
      },
      // MWA expects a cluster-ish value; "mainnet-beta" works and removes your TS "network" underline
      cluster: "mainnet-beta",
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    } as any);

    // MWA ONLY — no Phantom, no Solflare
    return [mwa];
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
