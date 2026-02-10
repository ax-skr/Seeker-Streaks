"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { clusterApiUrl } from "@solana/web3.js";

import {
  SolanaMobileWalletAdapter,
  createDefaultAuthorizationResultCache,
} from "@solana-mobile/wallet-adapter-mobile";

// Small helper type so TS stops screaming across package versions
type AppIdentity = {
  name: string;
  uri?: string;
  icon?: string;
};

export default function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);
  const [origin, setOrigin] = useState<string>("https://seeker-streaks.vercel.app");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);

  const wallets = useMemo(() => {
    const authorizationResultCache = createDefaultAuthorizationResultCache();

    const appIdentity: AppIdentity = {
      name: "Seeker Streaks",
      uri: origin,
      icon: `${origin}/icon-192.png`,
    };

    // Cast options to avoid version-to-version TS mismatch
    return [
      new SolanaMobileWalletAdapter({
        appIdentity,
        authorizationResultCache,
      } as any),
    ];
  }, [origin]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
