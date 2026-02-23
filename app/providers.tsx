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

  // ✅ VISUAL ONLY (freeze-proof): hide Phantom/Solflare + change title + hide "More options"
  useEffect(() => {
    if (typeof window === "undefined") return;

    const HIDE = ["phantom", "solflare"];
    const TITLE_TEXT = "Connect your Solana Mobile wallet";

    let rafScheduled = false;
    let observer: MutationObserver | null = null;

    const isModalOpen = () =>
      !!document.querySelector(".wallet-adapter-modal-wrapper");

    const applyPatches = () => {
      // Only run when the modal exists/open, otherwise do nothing.
      if (!isModalOpen()) return;

      // Disconnect while patching to avoid observer feedback loop.
      observer?.disconnect();

      try {
        // 1) Change title text (only if needed)
        const title = document.querySelector(
          ".wallet-adapter-modal-title"
        ) as HTMLElement | null;

        if (title && title.textContent !== TITLE_TEXT) {
          title.textContent = TITLE_TEXT;
        }

        // 2) Hide "More options / Less options" toggle
        const moreBtn = document.querySelector(
          ".wallet-adapter-modal-list-more"
        ) as HTMLElement | null;

        if (moreBtn && moreBtn.style.display !== "none") {
          moreBtn.style.display = "none";
        }

        // 3) Hide Phantom/Solflare buttons + rows (stable across rerenders)
        const buttons = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            ".wallet-adapter-modal-list .wallet-adapter-button"
          )
        );

        for (const btn of buttons) {
          const label = (btn.textContent || "").toLowerCase();
          if (!label) continue;

          if (HIDE.some((name) => label.includes(name))) {
            const li = btn.closest("li") as HTMLElement | null;
            if (li && li.style.display !== "none") li.style.display = "none";
            if (btn.style.display !== "none") btn.style.display = "none";
          }
        }

        // 4) Hide extra list sections if they appear
        const lists = Array.from(
          document.querySelectorAll<HTMLElement>(".wallet-adapter-modal-list")
        );
        if (lists.length > 1) {
          for (let i = 1; i < lists.length; i++) {
            if (lists[i].style.display !== "none") lists[i].style.display = "none";
          }
        }
      } finally {
        // Reconnect observer after patching
        observer?.observe(document.body, { childList: true, subtree: true });
      }
    };

    const schedule = () => {
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        applyPatches();
      });
    };

    // Initial run
    schedule();

    observer = new MutationObserver(() => {
      // Only schedule patches when modal is open/exists (prevents background work).
      if (isModalOpen()) schedule();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      observer = null;
    };
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}