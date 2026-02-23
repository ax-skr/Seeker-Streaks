"use client";

import React, { useEffect, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import * as solanaMobile from "@solana-mobile/wallet-adapter-mobile";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * We want Phantom/Solflare to exist for desktop dev/testing,
 * BUT on mobile we want to hide them completely so users don't get
 * kicked to external wallet browsers / download pages.
 */

function isAnyMobileDevice() {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

export default function Providers({ children }: { children: React.ReactNode }) {
  /**
   * IMPORTANT:
   * Use a public RPC while stabilizing. You can swap to your own later.
   */
  const endpoint =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com";

  useEffect(() => {
    console.log("[ConnectionProvider] endpoint =", endpoint);
    if (typeof window !== "undefined") {
      console.log("[UA]", navigator.userAgent);
      console.log("[isAnyMobileDevice]", isAnyMobileDevice());
    }
  }, [endpoint]);

  const wallets = useMemo(() => {
    const MobileAdapter = (solanaMobile as any).SolanaMobileWalletAdapter;

    // ✅ MOBILE: show ONLY Solana Mobile Wallet Adapter (hides Phantom/Solflare in modal)
    if (isAnyMobileDevice()) {
      if (!MobileAdapter) return [];

      const createDefaultAddressSelector =
        (solanaMobile as any).createDefaultAddressSelector;
      const createDefaultAuthorizationResultCache =
        (solanaMobile as any).createDefaultAuthorizationResultCache;

      const addressSelector =
        typeof createDefaultAddressSelector === "function"
          ? createDefaultAddressSelector()
          : { select: async (addresses: string[]) => addresses?.[0] };

      const authorizationResultCache =
        typeof createDefaultAuthorizationResultCache === "function"
          ? createDefaultAuthorizationResultCache()
          : { clear: async () => {}, get: async () => null, set: async () => {} };

      const origin =
        typeof window !== "undefined" ? window.location.origin : "";

      return [
        new MobileAdapter({
          addressSelector,
          authorizationResultCache,
          appIdentity: {
            name: "Seeker Streaks",
            uri: origin,
            icon: origin ? `${origin}/favicon.ico` : undefined,
          },
        }),
      ];
    }

    // ✅ DESKTOP: allow Phantom/Solflare for normal browser usage/testing
    return [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter({ network: WalletAdapterNetwork.Mainnet }),
    ];
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}