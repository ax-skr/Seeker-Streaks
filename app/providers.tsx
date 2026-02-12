"use client";

import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";

// IMPORTANT: this is the correct package you installed
import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
} from "@solana-mobile/wallet-adapter-mobile";

// If you use the wallet-adapter UI styles anywhere
import "@solana/wallet-adapter-react-ui/styles.css";

export default function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);

  // MUST be client-safe: Seed Vault uses the app identity origin
  const uri = useMemo(() => {
    if (typeof window === "undefined") return "https://seeker-streaks.vercel.app";
    return window.location.origin;
  }, []);

  const wallets = useMemo(() => {
    const addressSelector = createDefaultAddressSelector();
    const authorizationResultCache = createDefaultAuthorizationResultCache();
    const walletNotFoundHandler = createDefaultWalletNotFoundHandler();

    // Force ONLY Seed Vault / Solana Mobile Wallet Adapter.
    // Cast to any to avoid TS being picky across package versions.
    const mwa = new SolanaMobileWalletAdapter({
      addressSelector,
      authorizationResultCache,
      onWalletNotFound: walletNotFoundHandler,
      appIdentity: {
        name: "Seeker Streaks",
        uri,
        icon: `${uri}/icon-192.png`,
      },
      cluster: "mainnet-beta",
    } as any);

    return [mwa];
  }, [uri]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
