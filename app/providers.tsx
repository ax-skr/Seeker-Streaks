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
  const endpoint = "https://api.mainnet-beta.solana.com";

  useEffect(() => {
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

  // ⭐ VISUAL-ONLY PATCHES FOR WALLET MODAL
  useEffect(() => {
    if (typeof window === "undefined") return;

    const HIDE = new Set(["phantom", "solflare"]);

    const applyPatches = () => {
      /* ---------------------------
         1) CHANGE TITLE TEXT
      ----------------------------*/
      const title = document.querySelector(
        ".wallet-adapter-modal-title"
      ) as HTMLElement | null;

      if (title) {
        title.textContent = "Connect your Solana Mobile wallet";
      }

      /* ---------------------------
         2) HIDE MORE OPTIONS BUTTON
      ----------------------------*/
      const moreBtn = document.querySelector(
        ".wallet-adapter-modal-list-more"
      ) as HTMLElement | null;

      if (moreBtn) {
        moreBtn.style.display = "none";
      }

      /* ---------------------------
         3) HIDE PHANTOM + SOLFLARE
      ----------------------------*/
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".wallet-adapter-modal-list .wallet-adapter-button"
        )
      );

      for (const btn of buttons) {
        const label = (btn.textContent || "").toLowerCase();

        for (const name of HIDE) {
          if (label.includes(name)) {
            const li = btn.closest("li");
            if (li) li.style.display = "none";
            btn.style.display = "none";
          }
        }
      }

      /* ---------------------------
         4) HIDE EXTRA WALLET SECTION
      ----------------------------*/
      const lists = document.querySelectorAll(
        ".wallet-adapter-modal-list"
      );

      if (lists.length > 1) {
        (lists[1] as HTMLElement).style.display = "none";
      }
    };

    applyPatches();

    const obs = new MutationObserver(applyPatches);
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