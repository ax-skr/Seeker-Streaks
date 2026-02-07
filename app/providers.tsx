"use client";

import React, { useEffect, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import * as solanaMobile from "@solana-mobile/wallet-adapter-mobile";

import "@solana/wallet-adapter-react-ui/styles.css";

function isSolanaMobileDevice() {
  if (typeof window === "undefined") return false;
  return /SolanaMobile|SeedVault|Seeker/i.test(navigator.userAgent);
}

export default function Providers({ children }: { children: React.ReactNode }) {
  /**
   * IMPORTANT:
   * Hard-force a public RPC that does not 403.
   * Do NOT read NEXT_PUBLIC_SOLANA_RPC_URL until everything works.
   */
  const endpoint = "https://api.mainnet-beta.solana.com";

  useEffect(() => {
    // This will show in your devtools/console (desktop + mobile remote debugging)
    console.log("[ConnectionProvider] endpoint =", endpoint);
  }, [endpoint]);

  const wallets = useMemo(() => {
    // Desktop
    if (!isSolanaMobileDevice()) {
      return [
        new PhantomWalletAdapter(),
        new SolflareWalletAdapter({ network: WalletAdapterNetwork.Mainnet }),
      ];
    }

    // Solana Mobile / Seed Vault / Seeker
    const MobileAdapter = (solanaMobile as any).SolanaMobileWalletAdapter;
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

    return [
      new MobileAdapter({
        addressSelector,
        authorizationResultCache,
        appIdentity: {
          name: "Seeker Streaks",
          uri: typeof window !== "undefined" ? window.location.origin : "",
          icon:
            typeof window !== "undefined"
              ? `${window.location.origin}/favicon.ico`
              : undefined,
        },
      }),
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
