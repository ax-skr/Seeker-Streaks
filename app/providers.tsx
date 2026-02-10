"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { clusterApiUrl } from "@solana/web3.js";

import {
  SolanaMobileWalletAdapter,
  createDefaultAuthorizationResultCache,
} from "@solana-mobile/wallet-adapter-mobile";

type AppIdentity = {
  name: string;
  uri?: string;
  icon?: string;
};

export default function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);
  const [origin, setOrigin] = useState("https://seeker-streaks.vercel.app");

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const mwaAdapter = useMemo(() => {
    const authorizationResultCache = createDefaultAuthorizationResultCache();

    const appIdentity: AppIdentity = {
      name: "Seeker Streaks",
      uri: origin,
      icon: `${origin}/icon-192.png`,
    };

    return new SolanaMobileWalletAdapter({
      appIdentity,
      authorizationResultCache,
    } as any);
  }, [origin]);

  // ✅ IMPORTANT: wallet-adapter-react requires a selected wallet.
  // If we only have MWA, set it as default selection.
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      const key = "walletName";
      const existing = window.localStorage.getItem(key);
      if (!existing) {
        window.localStorage.setItem(key, mwaAdapter.name);
      }
    } catch {}
  }, [mwaAdapter]);

  const wallets = useMemo(() => [mwaAdapter], [mwaAdapter]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
