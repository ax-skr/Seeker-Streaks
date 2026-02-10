"use client";

import { ReactNode, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { clusterApiUrl } from "@solana/web3.js";

import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
} from "@solana-mobile/wallet-adapter-mobile";

export default function Providers({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);

  const wallets = useMemo(() => {
    const addressSelector = createDefaultAddressSelector();
    const authorizationResultCache = createDefaultAuthorizationResultCache();

    const uri: string =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://seeker-streaks.vercel.app";

    // 👇 Force the object to match the adapter's constructor type (fixes red underline)
    const config = {
      addressSelector,
      authorizationResultCache,
      appIdentity: {
        name: "Seeker Streaks",
        uri,
        icon: "https://seeker-streaks.vercel.app/icon-192.png",
      },
    };

    return [new SolanaMobileWalletAdapter(config as any)];
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
