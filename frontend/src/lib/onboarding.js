// ── Account setup: what the UI shows for the server's onboarding status ──
// Pure, so it can be tested without a browser (src/integrations/safe/safe.test.ts).

export const ONBOARDING_POLL_MS = 3000;

/** Server status ('ready' | 'deploying' | 'failed' | 'not_started') → the hook's safeStatus. */
export function safeStatusFor(serverStatus) {
  if (serverStatus === 'ready') return 'deployed';
  if (serverStatus === 'failed') return 'error';
  return 'deploying'; // 'deploying' and 'not_started' (about to start): setting up
}

/** True while the client should keep asking the server how the setup is going. */
export const shouldPoll = (serverStatus) => serverStatus !== 'ready' && serverStatus !== 'failed';

/**
 * What to do with a status seen while polling: keep waiting, stop, or ask the server to start
 * again (`not_started` after the setup began means it was lost, e.g. the bridge restarted).
 */
export function pollAction(serverStatus) {
  if (serverStatus === 'not_started') return 'restart';
  return shouldPoll(serverStatus) ? 'wait' : 'done';
}

/** What to say while the server works: finishing an account that already exists, or setting up a new one. */
export function setupProgressText(finishing) {
  return finishing ? 'Finishing setting up your account…' : 'Setting up your account…';
}

/** A plain sentence for a failed start or poll; never raw technical text. */
export function onboardingErrorMessage(err) {
  // The server's own sentences for these codes are already plain ("try again in 5 minutes", "still finishing").
  if ((err?.code === 'onboarding_rate_limited' || err?.code === 'setup_pending') && err.message) return err.message;
  if (err?.code === 'session_required') return 'Sign in to finish setting up your account.';
  return "We couldn't finish setting up your account. Please try again.";
}

/** Short address for display, e.g. 0x1234…abcd. */
export const shortAddress = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/**
 * Where the account check starts. Signed in: ask the server to start or join the setup (it answers
 * "ready" at once for a finished account). Not signed in: wait. The account and its balances are
 * only looked up for a signed-in user, so nothing about an address is asked of the server before.
 */
export const firstCheck = (signedIn) => (signedIn ? 'setup' : 'wait');
