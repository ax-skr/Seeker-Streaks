type DisplayOptions = {
  showWallet: boolean;
  rank?: number;
};

/**
 * Storage keys:
 *  - skr:<wallet>  -> "ax.skr"
 *  - sol:<wallet>  -> "ax.sol"
 */

// Save a preferred name for a wallet (opt-in)
export function setPreferredName(wallet: string, name: string) {
  const clean = name.trim();

  // Allow only .skr or .sol (basic safety)
  const isValid =
    clean.endsWith(".skr") ||
    clean.endsWith(".sol") ||
    clean.endsWith(".saga"); // optional

  if (!isValid) {
    throw new Error("Name must end with .skr or .sol (or .saga)");
  }

  // Prefer .skr over .sol if user types it
  if (clean.endsWith(".skr")) {
    localStorage.setItem(`skr:${wallet}`, clean);
    // If they set .skr, you can optionally clear .sol to avoid confusion
    // localStorage.removeItem(`sol:${wallet}`);
    return;
  }

  if (clean.endsWith(".sol")) {
    localStorage.setItem(`sol:${wallet}`, clean);
    return;
  }

  // fallback optional
  localStorage.setItem(`name:${wallet}`, clean);
}

// Remove name (user can go back to wallet/anonymous)
export function clearPreferredName(wallet: string) {
  localStorage.removeItem(`skr:${wallet}`);
  localStorage.removeItem(`sol:${wallet}`);
  localStorage.removeItem(`name:${wallet}`);
}

// Get preferred name (skr > sol > name)
export function getPreferredName(wallet: string): string | null {
  const skr = localStorage.getItem(`skr:${wallet}`);
  if (skr) return skr;

  const sol = localStorage.getItem(`sol:${wallet}`);
  if (sol) return sol;

  const other = localStorage.getItem(`name:${wallet}`);
  if (other) return other;

  return null;
}

/**
 * Decide how a user is shown on the leaderboard
 */
export function resolveDisplayName(wallet: string, options: DisplayOptions) {
  const { showWallet, rank } = options;

  // Privacy OFF → anonymous ALWAYS
  if (!showWallet) {
    return `Anonymous #${rank ?? "?"}`;
  }

  // Demo / fake wallets → show full name
  if (wallet.startsWith("FAKE_") || wallet.startsWith("DEMO_")) {
    return wallet;
  }

  // If the user has a chosen name saved, show it (opt-in only)
  const preferred = getPreferredName(wallet);
  if (preferred) return preferred;

  // Fallback: shorten real wallet
  if (wallet.length > 10) {
    return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  }

  return wallet;
}
