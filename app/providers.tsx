"use client";

import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";

import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
} from "@solana-mobile/wallet-adapter-mobile";

import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";

export default function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = "https://api.mainnet-beta.solana.com";

  // client-only origin is safest for MWA
  const uri = useMemo(() => {
    if (typeof window !== "undefined") return window.location.origin;
    return "https://seeker-streaks.vercel.app";
  }, []);

  const wallets = useMemo(() => {
    const addressSelector = createDefaultAddressSelector();
    const authorizationResultCache = createDefaultAuthorizationResultCache();

    // Some versions of the MWA adapter have slightly different TS typings.
    // Runtime is correct; cast keeps TS happy.
    const mwa = new SolanaMobileWalletAdapter(
      {
        addressSelector,
        authorizationResultCache,
        appIdentity: {
          name: "Seeker Streaks",
          uri,
          icon: "https://seeker-streaks.vercel.app/icon-192.png",
        },
      } as any
    );

    const phantom = new PhantomWalletAdapter();

    // Solflare expects WalletAdapterNetwork (not a raw string) in many versions
    const solflare = new SolflareWalletAdapter({
      network: WalletAdapterNetwork.Mainnet,
    });

    // Order matters: MWA first, then fallbacks (still hidden because no modal)
    return [mwa, phantom, solflare];
  }, [uri]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
