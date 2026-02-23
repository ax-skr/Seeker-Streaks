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

  // ✅ VISUAL ONLY: hide Phantom + Solflare options in the modal (even after disconnect/re-render)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const HIDE = new Set(["phantom", "solflare"]);

    const applyHide = () => {
      // Buttons
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".wallet-adapter-modal-list .wallet-adapter-button"
        )
      );

      for (const btn of buttons) {
        const label = (btn.textContent || "").trim().toLowerCase();
        if (!label) continue;

        // If the button text contains Phantom/Solflare, hide the whole row
        for (const name of HIDE) {
          if (label.includes(name)) {
            const li = btn.closest("li");
            if (li) li.style.display = "none";
            btn.style.display = "none";
          }
        }
      }

      // Some versions render list items differently; also scan li text
      const items = Array.from(
        document.querySelectorAll<HTMLLIElement>(".wallet-adapter-modal-list li")
      );

      for (const li of items) {
        const t = (li.textContent || "").trim().toLowerCase();
        for (const name of HIDE) {
          if (t.includes(name)) {
            li.style.display = "none";
          }
        }
      }
    };

    // Run once immediately
    applyHide();

    // Observe modal changes (disconnect/refresh causes rerenders)
    const obs = new MutationObserver(() => applyHide());
    obs.observe(document.body, { childList: true, subtree: true });

    return () => obs.disconnect();
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}