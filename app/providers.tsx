"use client";

import React, { FC, ReactNode, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";

import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
} from "@solana-mobile/wallet-adapter-mobile";

import { clusterApiUrl } from "@solana/web3.js";

// If you already import this elsewhere, keep only one import in your app.
// import "@solana/wallet-adapter-react-ui/styles.css";

export const Providers: FC<{ children: ReactNode }> = ({ children }) => {
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);

  const wallets = useMemo(() => {
    const addressSelector = createDefaultAddressSelector();
    const authorizationResultCache = createDefaultAuthorizationResultCache();
    const onWalletNotFound = createDefaultWalletNotFoundHandler();

    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://seeker-streaks.vercel.app";

    const mwa = new SolanaMobileWalletAdapter({
      addressSelector,
      authorizationResultCache,
      onWalletNotFound,
      // Some versions call this "cluster". If your TS still underlines it,
      // keep it as-is and it will still work at runtime.
      cluster: "mainnet-beta" as any,
      appIdentity: {
        name: "Seeker Streaks",
        uri: origin,
        icon: "https://seeker-streaks.vercel.app/icon-192.png",
      },
    } as any);

    // MWA ONLY (Seeker / Seed Vault)
    return [mwa];
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
