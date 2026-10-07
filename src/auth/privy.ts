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
// bound to our domain, and its public key is in the user's Privy record.

import { ethers } from "ethers";
import { createRemoteJWKSet, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { PrivyClient, verifyIdentityToken, type User } from "@privy-io/node";
import { issueToken, AuthError } from "./index";
import { addExternalCredential } from "../integrations/passkey";

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
 * (the domain they signed in on). Returns how many the wallet now holds.
 * Without PRIVY_APP_SECRET, or for users without a passkey, it does nothing and
 * they register one with "Add passkey" as before.
 */
export async function importPrivyPasskeys(user: User, wallet: string, rpID: string): Promise<number> {
  if (!user.linked_accounts.some((a) => a.type === "passkey")) return 0;
  const fetcher = getUserFetcher();
  if (!fetcher) return 0;
  const full = await fetcher(user.id);
  let added = 0;
  for (const a of full.linked_accounts) {
    if (a.type !== "passkey" || !a.credential_id || !a.public_key) continue;
    if (await addExternalCredential(wallet, { id: a.credential_id, publicKey: a.public_key, rpID, source: "privy" })) added++;
  }
  return added;
}

/** Test hook: verify against a fixed key instead of Privy's JWKS. */
export function _setVerificationKey(key: VerificationKey | null): void {
  verificationKey = key;
}

/** Test hook: return users from here instead of Privy's API. */
export function _setUserFetcher(fetcher: UserFetcher | null): void {
  fetchUser = fetcher;
}
