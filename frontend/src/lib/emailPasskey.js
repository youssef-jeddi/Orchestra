// ── Email sign-in users and passkeys: what the UI shows and allows ──
// A user who signed in with an email has no passkey yet. The server refuses to move their funds
// until they add one (and asks for a fresh email code first); this file only decides what the
// chat shows. Pure, so it's tested without a browser (src/integrations/passkey/emailGate.test.ts).

import { PASSKEY_MEANS } from './plainLanguage';

/** Shown in the chat (and by the server as the reason): plain words, "your account", no jargon. */
export const PASSKEY_PROMPT =
  "To keep your money safe, confirm transactions with a passkey (Face ID, fingerprint or your device PIN). First we'll check it's really you.";

export const SIGN_REFUSED = `Approve this with a passkey or on Telegram instead. A passkey confirms with ${PASSKEY_MEANS}.`;

/** The server's answer to a value-moving request from an email user who has no passkey yet. */
export const isPasskeyRequired = (data) => data?.status === 'passkey_required';

/** What the session knows about the wallet: from GET /auth/session, or the sign-in answer if that failed. */
export function accountFrom(info, signIn) {
  return {
    emailWallet: !!(info ? info.emailWallet : signIn?.emailWallet),
    hasPasskey: !!info?.hasPasskey,
    verifyWith: Array.isArray(info?.verifyWith) ? info.verifyWith : [], // account types that can confirm the first passkey
  };
}

// ── Social sign-ins: confirm it's you by signing in again with the same provider ──
// The names are what people call them; `id` is Privy's name for the provider.
const SOCIAL_PROVIDERS = {
  google_oauth: { id: 'google', name: 'Google' },
  apple_oauth: { id: 'apple', name: 'Apple' },
  twitter_oauth: { id: 'twitter', name: 'X' },
  discord_oauth: { id: 'discord', name: 'Discord' },
  github_oauth: { id: 'github', name: 'GitHub' },
  linkedin_oauth: { id: 'linkedin', name: 'LinkedIn' },
  spotify_oauth: { id: 'spotify', name: 'Spotify' },
  instagram_oauth: { id: 'instagram', name: 'Instagram' },
  tiktok_oauth: { id: 'tiktok', name: 'TikTok' },
  line_oauth: { id: 'line', name: 'LINE' },
  twitch_oauth: { id: 'twitch', name: 'Twitch' },
};

/**
 * How this user confirms it's them before their first passkey, from the account types the server
 * lists: an emailed code (email users, unchanged), signing in again with their social account, or
 * nothing we can offer yet.
 */
export function verifyStepFor(verifyWith = []) {
  if (verifyWith.includes('email')) return { kind: 'email' };
  const type = verifyWith.find((t) => SOCIAL_PROVIDERS[t]);
  if (type) return { kind: 'social', type, ...SOCIAL_PROVIDERS[type] };
  return verifyWith.length ? { kind: 'none' } : { kind: 'email' }; // older accounts: the email code, as before
}

export const socialConfirmLabel = (name) => `Confirm it's you with ${name}`;
export const socialConfirmHelp = (name) => `You'll go to ${name} for a moment, then come straight back to finish.`;
export const SOCIAL_NONE = "We can't confirm this sign-in yet. Please contact support so we can help you add a passkey.";
export const SOCIAL_WRONG_ACCOUNT = "That wasn't the account you signed up with, so we stopped. Confirm it with the same one.";

const DRAFT_KEY = 'orchestra:passkey-draft';
export const DRAFT_TTL_MS = 15 * 60_000;

/**
 * The request held back for a passkey, kept across the trip to the provider's sign-in page (the
 * page reloads). Only the user's own words and the wallet address are stored, in this tab's
 * session storage: no tokens, no secrets. `storage` is injected so it's tested without a browser.
 */
export function passkeyDraft(storage) {
  return {
    save({ wallet, text, history }, now = Date.now()) {
      try { storage.setItem(DRAFT_KEY, JSON.stringify({ wallet: String(wallet).toLowerCase(), text: text ?? null, history: history ?? [], savedAt: now })); } catch { /* private mode: the trip still works, the request is just not kept */ }
    },
    /** The draft if it is recent; `mine` says whether it belongs to `wallet`. Null when none or too old. */
    peek(wallet, now = Date.now()) {
      try {
        const d = JSON.parse(storage.getItem(DRAFT_KEY));
        if (!d || typeof d.savedAt !== 'number' || now - d.savedAt > DRAFT_TTL_MS || d.savedAt > now + 60_000) return null;
        return { ...d, mine: !!wallet && d.wallet === String(wallet).toLowerCase() };
      } catch { return null; }
    },
    clear() { try { storage.removeItem(DRAFT_KEY); } catch { /* ignore */ } },
  };
}

/** Offer the passkey on its own once the account is ready, before the user has to ask for anything. */
export const shouldOfferPasskey = ({ emailWallet, hasPasskey, accountReady }) => !!emailWallet && !hasPasskey && !!accountReady;

/**
 * May the user's own wallet sign this? Only funding their own account (a deposit): everything the
 * account holds, a send, a swap or liquidity, is approved by a passkey or on Telegram against the
 * server's stored copy, for every kind of user. Paying it from the personal wallet would skip that
 * check. An email user also needs a passkey before they can fund their account.
 *
 * The one other thing: 'safe-owner', signing a request the server holds that went past the
 * account's on-chain daily ceiling. That signature is over the hash of the transaction the server
 * stored (the wallet is the account's owner; the server checks it), not over anything this page
 * builds, and it needs the same passkey for an email user.
 */
export function userMaySign({ emailWallet, hasPasskey } = {}, kind) {
  if (kind !== 'deposit' && kind !== 'safe-owner') return false;
  return !emailWallet || !!hasPasskey;
}

/** Keeps the request that was held back, so adding the passkey can send it again (a fresh request). */
export function pendingRequest() {
  let held = null;
  return {
    hold(text, history) { held = { text, history }; },
    take() { const r = held; held = null; return r; },
    peek() { return held; },
  };
}

/** A plain sentence for a failed email-code or passkey step. */
export function emailStepError(err, step) {
  if (err?.code === 'email_verification_failed' && err.message) return err.message;
  if (err?.code === 'email_verification_required') return "We couldn't confirm the code in time. Ask for a new one.";
  if (step === 'passkey') return "We couldn't add your passkey. Try again.";
  return "That code didn't work. Check it and try again, or ask for a new one.";
}
