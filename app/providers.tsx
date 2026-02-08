"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

// Keep Phantom/Solflare ONLY for desktop (not for Seeker TWA)
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";

// Import the Solana Mobile adapter package as a module (version-safe)
import * as solanaMobile from "@solana-mobile/wallet-adapter-mobile";

function isSolanaMobileDevice() {
  if (typeof window === "undefined") return false;
  return /SolanaMobile|SeedVault|Seeker/i.test(navigator.userAgent);
}

export default function Providers({ children }: { children: React.ReactNode }) {
  // Use a stable public RPC for now
  const endpoint = "https://api.mainnet-beta.solana.com";

  // We must wait for window.location.origin on client
  const [origin, setOrigin] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const wallets = useMemo(() => {
    // ✅ Desktop wallets (browser)
    if (!isSolanaMobileDevice()) {
      return [
        new PhantomWalletAdapter(),
        new SolflareWalletAdapter({ network: WalletAdapterNetwork.Mainnet }),
      ];
    }

    // ✅ Seeker / Seed Vault / Solana Mobile wallet adapter ONLY
    // Version-safe access:
    const MobileAdapterCtor =
      (solanaMobile as any).SolanaMobileWalletAdapter ||
      (solanaMobile as any).default;

    const createDefaultAddressSelector =
      (solanaMobile as any).createDefaultAddressSelector;
    const createDefaultAuthorizationResultCache =
      (solanaMobile as any).createDefaultAuthorizationResultCache;

    if (!MobileAdapterCtor) {
      console.error(
        "[Providers] SolanaMobileWalletAdapter not found in @solana-mobile/wallet-adapter-mobile"
      );
      return [];
    }

    const addressSelector =
      typeof createDefaultAddressSelector === "function"
        ? createDefaultAddressSelector()
        : { select: async (addresses: string[]) => addresses?.[0] };

    const authorizationResultCache =
      typeof createDefaultAuthorizationResultCache === "function"
        ? createDefaultAuthorizationResultCache()
        : { clear: async () => {}, get: async () => null, set: async () => {} };

    return [
      new MobileAdapterCtor({
        addressSelector,
        authorizationResultCache,
        appIdentity: {
          name: "Seeker Streaks",
          uri: origin || undefined,
          // IMPORTANT: use a real PNG that exists (not favicon.ico)
          icon: origin ? `${origin}/icon-192.png` : undefined,
        },
      }),
    ];
  }, [origin]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
