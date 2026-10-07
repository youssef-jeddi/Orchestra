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

import { ethers } from "ethers";
import { createRemoteJWKSet, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { verifyIdentityToken, type User } from "@privy-io/node";
import { issueToken, AuthError } from "./index";

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
  return issueToken(wallet);
}

/** Test hook: verify against a fixed key instead of Privy's JWKS. */
export function _setVerificationKey(key: VerificationKey | null): void {
  verificationKey = key;
}
