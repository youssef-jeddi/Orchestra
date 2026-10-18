// ── Email sign-in users and passkeys: what the UI shows and allows ──
// A user who signed in with an email has no passkey yet. The server refuses to move their funds
// until they add one (and asks for a fresh email code first); this file only decides what the
// chat shows. Pure, so it's tested without a browser (src/integrations/passkey/emailGate.test.ts).

/** Shown in the chat (and by the server as the reason): plain words, "your account", no jargon. */
export const PASSKEY_PROMPT =
  "To keep your money safe, confirm transactions with a passkey (Face ID, fingerprint or your device PIN). First we'll check it's really you.";

export const SIGN_REFUSED = 'Confirm this with your passkey instead.';

/** The server's answer to a value-moving request from an email user who has no passkey yet. */
export const isPasskeyRequired = (data) => data?.status === 'passkey_required';

/** What the session knows about the wallet: from GET /auth/session, or the sign-in answer if that failed. */
export function accountFrom(info, signIn) {
  return { emailWallet: !!(info ? info.emailWallet : signIn?.emailWallet), hasPasskey: !!info?.hasPasskey };
}

/** Offer the passkey on its own once the account is ready, before the user has to ask for anything. */
export const shouldOfferPasskey = ({ emailWallet, hasPasskey, accountReady }) => !!emailWallet && !hasPasskey && !!accountReady;

/**
 * May the user's own wallet sign this? Email users approve with a passkey only: no "Approve & Send"
 * or "Approve & Swap" for them. Their one self-signed action is funding their own account, and only
 * once a passkey exists. Wallet users and passkey sign-in users are unchanged.
 */
export function userMaySign({ emailWallet, hasPasskey } = {}, kind) {
  if (!emailWallet) return true;
  return kind === 'deposit' && !!hasPasskey;
}

/** Keeps the request that was held back, so adding the passkey can send it again (a fresh request). */
export function pendingRequest() {
  let held = null;
  return {
    hold(text, history) { held = { text, history }; },
    take() { const r = held; held = null; return r; },
  };
}

/** A plain sentence for a failed email-code or passkey step. */
export function emailStepError(err, step) {
  if (err?.code === 'email_verification_failed' && err.message) return err.message;
  if (err?.code === 'email_verification_required') return "We couldn't confirm the code in time. Ask for a new one.";
  if (step === 'passkey') return "We couldn't add your passkey. Try again.";
  return "That code didn't work. Check it and try again, or ask for a new one.";
}
