// ─── Auth — Privy sign-in ───
// Users who sign in through Privy already proved who they are to Privy: a
// passkey or email (with an embedded wallet Privy creates for them), or an
// external wallet through Privy's SIWE. The frontend sends Privy's identity
// token; we verify it against Privy's public keys (no app secret needed) and,
// when the requested wallet is one of the user's linked Ethereum wallets, issue
// the same session token as the EIP-712 login. One sign-in, no second signature.
//
// Needs PRIVY_APP_ID, and identity tokens turned on in the Privy dashboard.
// PRIVY_VERIFICATION_KEY (the PEM key from the dashboard) skips fetching the JWKS.
//
// With PRIVY_APP_SECRET too, a user's Privy sign-in passkey also becomes their
// approval passkey (importPrivyPasskeys): Privy creates it in our page, so it's
// bound to our domain, and its public key is in the user's Privy record. Only
// for a wallet with no passkey yet: a passkey added to the Privy account later
// doesn't get in this way (adding one needs an existing passkey, see passkey/).
//
// A user who signed in with an email, phone or social account (Google, Apple, …) is flagged
// (noteEmailSignIn): they have no passkey to import, so their first one needs a fresh
// verification, which Privy records as the account's `latest_verified_at` in the identity token
// (verifyEmailForPasskey): an emailed code, or signing in again through the same provider.
// An embedded wallet that only ever signs in by wallet signature is recognised through Privy's
// API instead (emailGate.isEmailWallet).

import { ethers } from "ethers";
import { createRemoteJWKSet, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { PrivyClient, verifyIdentityToken, type User } from "@privy-io/node";
import { issueToken, AuthError } from "./index";
import { addExternalCredentials } from "../integrations/passkey";
import { isEmbeddedSignIn, isEmailWallet, markEmailWallet, grantEmailVerification } from "../integrations/passkey/emailGate";

const PRIVY_API_URL = "https://api.privy.io";

type VerificationKey = string | CryptoKey | JWTVerifyGetKey;
let verificationKey: VerificationKey | null = null;

function getVerificationKey(appId: string): VerificationKey {
  if (verificationKey) return verificationKey;
  const pem = process.env.PRIVY_VERIFICATION_KEY?.trim();
  verificationKey = pem
    ? pem.replace(/\\n/g, "\n") // .env files often hold the PEM on one line
    : createRemoteJWKSet(new URL(`${PRIVY_API_URL}/v1/apps/${appId}/jwks.json`), {
        headers: { "privy-app-id": appId },
        cacheMaxAge: 60 * 60_000,
        cooldownDuration: 10 * 60_000,
      });
  return verificationKey;
}

/** Lowercased Ethereum addresses linked to the Privy user: embedded and external wallets. */
export function linkedEthereumWallets(user: User): string[] {
  return user.linked_accounts
    .filter((a: any) => a.type === "wallet" && a.chain_type === "ethereum" && typeof a.address === "string")
    .map((a: any) => a.address.toLowerCase());
}

/** Verify a Privy identity token and issue a session for `wallet` if the user owns it. */
export async function privyLogin(identityToken: unknown, wallet: unknown): Promise<{ token: string; wallet: string; expiresAt: string }> {
  await verifyPrivyUser(identityToken, wallet);
  return issueToken(wallet as string);
}

/** The Privy user behind an identity token, if `wallet` is one of their linked wallets. */
export async function verifyPrivyUser(identityToken: unknown, wallet: unknown): Promise<User> {
  const appId = process.env.PRIVY_APP_ID;
  if (!appId) throw new AuthError(501, "Privy sign-in isn't set up on this server (PRIVY_APP_ID).");
  if (typeof identityToken !== "string" || !identityToken) throw new AuthError(400, "identityToken required");
  if (typeof wallet !== "string" || !ethers.isAddress(wallet)) throw new AuthError(400, "walletAddress must be a valid address");

  let user: User;
  try {
    user = await verifyIdentityToken({
      identity_token: identityToken,
      app_id: appId,
      verification_key: getVerificationKey(appId),
    });
  } catch {
    throw new AuthError(401, "Your sign-in expired. Sign in again.");
  }
  if (!linkedEthereumWallets(user).includes(wallet.toLowerCase())) {
    throw new AuthError(403, "This wallet isn't linked to your account.");
  }
  return user;
}

// ── Sign-in passkey → approval passkey ──
// Identity tokens list a passkey's id but not its public key; the full user
// record (app secret needed) has both.

type UserFetcher = (userId: string) => Promise<User>;
let fetchUser: UserFetcher | null = null;

function getUserFetcher(): UserFetcher | null {
  if (fetchUser) return fetchUser;
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return null;
  const client = new PrivyClient({ appId, appSecret });
  return (fetchUser = (userId) => client.users()._get(userId));
}

/**
 * Save the user's Privy passkeys as approval passkeys for `wallet` on `rpID`
 * (the domain they signed in on), if the wallet has no passkey yet. Returns how
 * many the wallet holds and how many were added now.
 * Without PRIVY_APP_SECRET, or for users without a passkey, it does nothing and
 * they register one with "Add passkey" as before.
 */
export async function importPrivyPasskeys(user: User, wallet: string, rpID: string): Promise<{ held: number; added: number }> {
  const none = { held: 0, added: 0 };
  if (!user.linked_accounts.some((a) => a.type === "passkey")) return none;
  const fetcher = getUserFetcher();
  if (!fetcher) return none;
  const full = await fetcher(user.id);
  const passkeys = full.linked_accounts.flatMap((a) =>
    a.type === "passkey" && a.credential_id && a.public_key
      ? [{ id: a.credential_id, publicKey: a.public_key, rpID, source: "privy" as const }]
      : []);
  // An embedded wallet's first passkey needs a fresh verification, even one from Privy: a token from a
  // sign-in just made carries one, a stale token grants nothing. addExternalCredentials spends it.
  if (passkeys.length && (await isEmailWallet(wallet))) await grantEmailVerification(wallet, user);
  return addExternalCredentials(wallet, passkeys);
}

/**
 * Flag the wallet when this sign-in is an email, phone or social one; the flag is never cleared. Returns whether
 * the wallet is an email wallet (now or from an earlier sign-in).
 */
export async function noteEmailSignIn(user: User, wallet: string): Promise<boolean> {
  if (isEmbeddedSignIn(user, wallet)) await markEmailWallet(wallet, user.id);
  return isEmailWallet(wallet);
}

/**
 * The user passed an email one-time code and sends the new identity token: hold that as the
 * wallet's one verification for its first passkey. Throws a plain-language AuthError otherwise.
 */
export async function verifyEmailForPasskey(identityToken: unknown, wallet: string): Promise<{ expiresAt: string }> {
  const user = await verifyPrivyUser(identityToken, wallet);
  const result = await grantEmailVerification(wallet, user);
  if (result.granted) return { expiresAt: result.expiresAt };
  if (result.reason === "not_email_wallet") throw new AuthError(400, "This account signed in with a wallet, so there's nothing to check.");
  if (result.reason === "other_user") throw new AuthError(403, "This email doesn't belong to this account.");
  if (result.reason === "already_used") throw new AuthError(409, "That code was already used. Ask for a new one.");
  throw new AuthError(403, "That code is too old. Ask for a new one and enter it right away.");
}

/** Test hook: verify against a fixed key instead of Privy's JWKS. */
export function _setVerificationKey(key: VerificationKey | null): void {
  verificationKey = key;
}

/** Test hook: return users from here instead of Privy's API. */
export function _setUserFetcher(fetcher: UserFetcher | null): void {
  fetchUser = fetcher;
}
