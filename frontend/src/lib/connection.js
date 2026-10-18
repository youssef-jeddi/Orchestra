// ── The /simple header while the wallet connection is still being worked out ──
// On first load the sign-in service needs a moment to say whether the user is already signed in.
// Showing "Sign in" during that moment is wrong for a returning user, so the header stays quiet
// until the state is known. Pure, so it's tested without a browser (src/policy/simpleUi.test.ts).

/** After this long without an answer, show the sign-in buttons anyway rather than wait forever. */
export const CONNECTING_GIVE_UP_MS = 8000;

/**
 * 'connected' | 'connecting' | 'signed-out'.
 *   privyConfigured  the sign-in service is in use (otherwise MetaMask and Ledger are the only options, known at once)
 *   privyReady       it has finished starting
 *   privyAuthenticated  it says the user is signed in (their wallet is being attached)
 */
export function headerState({ connected, privyConfigured, privyReady, privyAuthenticated, gaveUp }) {
  if (connected) return 'connected';
  if (!privyConfigured || gaveUp) return 'signed-out';
  if (!privyReady || privyAuthenticated) return 'connecting';
  return 'signed-out';
}
