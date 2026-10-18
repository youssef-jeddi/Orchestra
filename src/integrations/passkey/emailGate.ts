// ─── Passkey — email sign-in wallets: no passkey, no funds; a fresh email code for the first one ───
// A user who signs in with an email has nothing but the email to prove who they are, and a
// session token alone must never be enough to set up the factor that approves transactions.
// So for these wallets (flagged when they sign in through Privy, and never un-flagged):
//   • nothing moves funds while the wallet holds no passkey (passkeyGate), and
//   • its FIRST passkey needs a fresh, single-use email re-verification bound to the wallet.
// The proof is Privy's own: the `latest_verified_at` of the email account in a signature-checked
// identity token, which moves forward whenever the user passes an email one-time code.
// Pure decisions are exported and tested; storage holds only the flag and a replay marker.

import type { User } from "@privy-io/node";
import { read, write } from "../zero-g/storage";

/** How recent the user's email code must be for a first passkey. */
export const EMAIL_VERIFICATION_WINDOW_MS = 5 * 60_000;
// Privy's clock and ours may differ a little; a "verified in the future" beyond this is refused.
const CLOCK_SKEW_MS = 60_000;

/** Plain-language reason shown in the chat and returned with code `passkey_required`. */
export const PASSKEY_REQUIRED_MESSAGE =
  "To keep your money safe, confirm transactions with a passkey (Face ID, fingerprint or your device PIN). We'll email you a code first to make sure it's you.";

// ── Pure decisions ──

const isEmbeddedEthereum = (a: any) =>
  a.type === "wallet" && a.chain_type === "ethereum" && a.wallet_client_type === "privy";

/**
 * True when this Privy sign-in is an email one: an email account is linked, `wallet` is the
 * user's Privy-created wallet, and no Privy passkey is linked (a passkey user already has the
 * factor, which sign-in imports). Wallet users (MetaMask, Ledger, …) never match.
 */
export function isEmailSignIn(user: Pick<User, "linked_accounts">, wallet: string): boolean {
  const accounts = user.linked_accounts as any[];
  if (accounts.some((a) => a.type === "passkey")) return false;
  if (!accounts.some((a) => a.type === "email")) return false;
  return accounts.some((a) => isEmbeddedEthereum(a) && typeof a.address === "string" && a.address.toLowerCase() === wallet.toLowerCase());
}

/** When the user last passed an email one-time code, in ms, or null if the token doesn't say. */
export function emailVerifiedAtMs(user: Pick<User, "linked_accounts">): number | null {
  let latest: number | null = null;
  for (const a of user.linked_accounts as any[]) {
    const lv = a.type === "email" ? a.latest_verified_at : null;
    if (typeof lv !== "number" || !Number.isFinite(lv) || lv <= 0) continue;
    const ms = lv > 1e11 ? lv : lv * 1000; // Privy reports seconds
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

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

/** Errors propagate: callers fail closed when the flag can't be read. */
export async function isEmailWallet(wallet: string): Promise<boolean> {
  return (await readRecord(wallet)) !== null;
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
  const verifiedAtMs = emailVerifiedAtMs(user);
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
}
