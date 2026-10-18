// ─── Passkey — Privy embedded wallets: no passkey, no funds; a fresh sign-in check for the first one ───
// A user who signs in with an email, a phone or a social account (Google, Apple, X, Discord, …)
// has nothing but that account to prove who they are, and a session token alone must never be
// enough to set up the factor that approves transactions. (Code and tests still say "email
// wallet": that was the first such sign-in; the rules are the same for all of them.)
// So for these wallets (flagged when they sign in through Privy, or recognised as a Privy
// embedded wallet when they sign in by wallet signature; never un-flagged):
//   • nothing moves funds while the wallet holds no passkey (passkeyGate), and
//   • its FIRST passkey needs a fresh, single-use re-verification bound to the wallet.
// The proof is Privy's own: the `latest_verified_at` of a login account (email, phone, social)
// in a signature-checked identity token, which moves forward whenever the user passes an email
// code or signs in again through that provider.
// Pure decisions are exported and tested; storage holds only the flag and a replay marker.

import { PrivyClient, type User } from "@privy-io/node";
import { read, write } from "../zero-g/storage";

/** How recent the user's email code must be for a first passkey. */
export const EMAIL_VERIFICATION_WINDOW_MS = 5 * 60_000;
// Privy's clock and ours may differ a little; a "verified in the future" beyond this is refused.
const CLOCK_SKEW_MS = 60_000;

/** Plain-language reason shown in the chat and returned with code `passkey_required`. */
export const PASSKEY_REQUIRED_MESSAGE =
  "To keep your money safe, confirm transactions with a passkey (Face ID, fingerprint or your device PIN). First we'll check it's really you.";

// ── Pure decisions ──

const isEmbeddedEthereum = (a: any) =>
  a.type === "wallet" && a.chain_type === "ethereum" && a.wallet_client_type === "privy";

/**
 * True when this Privy sign-in lands on the user's Privy-created wallet and the user has no Privy
 * passkey (a passkey user already has the factor, which sign-in imports). Email, phone and social
 * sign-ins all match; wallet users (MetaMask, Ledger, …) never do.
 */
export function isEmbeddedSignIn(user: Pick<User, "linked_accounts">, wallet: string): boolean {
  const accounts = user.linked_accounts as any[];
  if (accounts.some((a) => a.type === "passkey")) return false;
  if (!accounts.some(isLoginAccount)) return false;
  return accounts.some((a) => isEmbeddedEthereum(a) && typeof a.address === "string" && a.address.toLowerCase() === wallet.toLowerCase());
}
export const isEmailSignIn = isEmbeddedSignIn;

// An account the user proves with a code or an OAuth sign-in: their only credential when they have no passkey.
const isLoginAccount = (a: any) =>
  a.type === "email" || a.type === "phone" || a.type === "farcaster" || a.type === "telegram" ||
  (typeof a.type === "string" && a.type.endsWith("_oauth"));

/**
 * When the user last passed a code or signed in again through a login provider, in ms, or null if
 * the token doesn't say. Privy moves `latest_verified_at` forward on each such sign-in.
 */
export function loginVerifiedAtMs(user: Pick<User, "linked_accounts">): number | null {
  let latest: number | null = null;
  for (const a of user.linked_accounts as any[]) {
    const lv = isLoginAccount(a) ? a.latest_verified_at : null;
    if (typeof lv !== "number" || !Number.isFinite(lv) || lv <= 0) continue;
    const ms = lv > 1e11 ? lv : lv * 1000; // Privy reports seconds
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}
export const emailVerifiedAtMs = loginVerifiedAtMs;

/** Fresh = within the window and not in the future. */
export function isFreshVerification(verifiedAtMs: number | null, now = Date.now()): boolean {
  if (verifiedAtMs === null) return false;
  return verifiedAtMs <= now + CLOCK_SKEW_MS && now - verifiedAtMs <= EMAIL_VERIFICATION_WINDOW_MS;
}

export type PasskeyGate = { ok: true } | { ok: false; code: "passkey_required"; message: string };

/** May this wallet move funds at all? An email wallet needs a passkey first. */
export function passkeyGate(input: { emailWallet: boolean; passkeyCount: number }): PasskeyGate {
  if (input.emailWallet && input.passkeyCount === 0) return { ok: false, code: "passkey_required", message: PASSKEY_REQUIRED_MESSAGE };
  return { ok: true };
}

// ── Email wallets (persisted, sticky) ──

interface EmailWalletRecord {
  userId: string;
  since: string;
  /** Newest verification already spent on a first passkey: the same one can't be spent twice, even after a restart. */
  usedVerifiedAt?: number;
}

const key = (wallet: string) => `emailwallet:${wallet.toLowerCase()}`;

async function readRecord(wallet: string): Promise<EmailWalletRecord | null> {
  const r = (await read(key(wallet))) as EmailWalletRecord | null;
  return r && typeof r.userId === "string" ? r : null;
}

/**
 * Flag the wallet as an email one. There is deliberately no way to clear it: a later EIP-712
 * login with the same wallet, or a changed Privy account, must not lift the rules.
 */
export async function markEmailWallet(wallet: string, userId: string): Promise<void> {
  if (await readRecord(wallet)) return;
  await write(key(wallet), { userId, since: new Date().toISOString() } satisfies EmailWalletRecord);
}

// ── Recognising an embedded wallet that never came through POST /auth/privy ──
// A Privy user who signs in with the wallet's EIP-712 signature skips the identity token, so
// nothing flagged them. The check lives in isEmailWallet (every gate goes through it): ask Privy
// whether the address is a user's embedded wallet. Needs PRIVY_APP_SECRET; without it the flag
// from /auth/privy is all there is.

/** The Privy user that owns `address` as a linked wallet, or null if Privy doesn't know it. */
export type WalletLookup = (address: string) => Promise<Pick<User, "id" | "linked_accounts"> | null>;
let lookup: WalletLookup | null = null;

function getLookup(): WalletLookup | null {
  if (lookup) return lookup;
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return null;
  const client = new PrivyClient({ appId, appSecret });
  return (lookup = async (address) => {
    try {
      return await client.users().getByWalletAddress({ address });
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw e;
    }
  });
}

/** True when `user` holds `wallet` as a Privy-created (embedded) Ethereum wallet. */
export function ownsEmbeddedWallet(user: Pick<User, "linked_accounts">, wallet: string): boolean {
  return (user.linked_accounts as any[]).some((a) => isEmbeddedEthereum(a) && typeof a.address === "string" && a.address.toLowerCase() === wallet.toLowerCase());
}

// External wallets stay external, so "not embedded" is remembered for a while: MetaMask users
// don't cost a Privy call per request. Only successful answers are cached; an API error is not.
const NOT_EMBEDDED_TTL_MS = 60 * 60_000;
const NOT_EMBEDDED_MAX = 5_000;
const notEmbedded = new Map<string, number>();

async function recogniseEmbedded(wallet: string, now = Date.now()): Promise<boolean> {
  const find = getLookup();
  if (!find) return false;
  const k = wallet.toLowerCase();
  const until = notEmbedded.get(k);
  if (until !== undefined && until > now) return false;
  const user = await find(wallet);
  if (user && ownsEmbeddedWallet(user, wallet)) {
    await markEmailWallet(wallet, user.id);
    return true;
  }
  if (notEmbedded.size >= NOT_EMBEDDED_MAX) notEmbedded.delete(notEmbedded.keys().next().value!);
  notEmbedded.set(k, now + NOT_EMBEDDED_TTL_MS);
  return false;
}

/**
 * Is this a Privy embedded wallet (flagged at sign-in, or recognised through Privy's API)?
 * Errors propagate, including a failed Privy lookup: callers fail closed when this can't be answered.
 */
export async function isEmailWallet(wallet: string): Promise<boolean> {
  if ((await readRecord(wallet)) !== null) return true;
  return recogniseEmbedded(wallet);
}

// ── Fresh email verification (in memory, single-use) ──

interface Grant { verifiedAtMs: number; userId: string }
const grants = new Map<string, Grant>();

export type GrantResult =
  | { granted: true; expiresAt: string }
  | { granted: false; reason: "not_email_wallet" | "other_user" | "stale" | "already_used" };

/**
 * Record a fresh email verification for the wallet, from a signature-checked Privy `user`
 * (identity token). It must belong to the Privy user the wallet was flagged for, be within the
 * window, and be newer than the last one spent. Held per wallet, so it can't be used for another.
 */
export async function grantEmailVerification(wallet: string, user: Pick<User, "id" | "linked_accounts">, now = Date.now()): Promise<GrantResult> {
  const record = await readRecord(wallet);
  if (!record) return { granted: false, reason: "not_email_wallet" };
  if (record.userId !== user.id) return { granted: false, reason: "other_user" };
  const verifiedAtMs = loginVerifiedAtMs(user);
  if (!isFreshVerification(verifiedAtMs, now)) return { granted: false, reason: "stale" };
  if (record.usedVerifiedAt !== undefined && verifiedAtMs! <= record.usedVerifiedAt) return { granted: false, reason: "already_used" };
  grants.set(wallet.toLowerCase(), { verifiedAtMs: verifiedAtMs!, userId: user.id });
  return { granted: true, expiresAt: new Date(verifiedAtMs! + EMAIL_VERIFICATION_WINDOW_MS).toISOString() };
}

/** True while the wallet holds an unspent, unexpired verification (does not spend it). */
export function hasEmailVerification(wallet: string, now = Date.now()): boolean {
  const g = grants.get(wallet.toLowerCase());
  return !!g && isFreshVerification(g.verifiedAtMs, now);
}

/**
 * Spend the wallet's verification on its first passkey. True once, and only while it is
 * still fresh; the grant is removed before anything async, so two requests can't both spend it.
 */
export async function consumeEmailVerification(wallet: string, now = Date.now()): Promise<boolean> {
  const k = wallet.toLowerCase();
  const g = grants.get(k);
  grants.delete(k);
  if (!g || !isFreshVerification(g.verifiedAtMs, now)) return false;
  const record = await readRecord(wallet);
  if (!record || record.userId !== g.userId) return false;
  await write(key(wallet), { ...record, usedVerifiedAt: g.verifiedAtMs } satisfies EmailWalletRecord);
  return true;
}

/** Test hook: forget held verifications. */
export function _resetEmailGate(): void {
  grants.clear();
  notEmbedded.clear();
}

/** Test hook: look wallets up here instead of Privy's API. */
export function _setWalletLookup(fn: WalletLookup | null): void {
  lookup = fn;
  notEmbedded.clear();
}
