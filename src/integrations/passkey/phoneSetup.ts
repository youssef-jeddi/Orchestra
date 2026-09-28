// ─── Passkey — one-time phone setup links ───
// Registering a passkey on the phone needs two proofs: the signed-in desktop
// session asks for the link (proves the wallet), and the link is delivered only
// to the wallet's linked Telegram chat (proves the phone). The link is
// single-use and short-lived.

import crypto from "crypto";

export const SETUP_TTL_MS = 10 * 60_000;

interface SetupEntry {
  wallet: string;
  expires: number;
  /** Registration challenge issued for this link, once the phone asked for options. */
  challenge?: string;
  /** The options carrying `challenge`, returned again if the page asks twice. */
  options?: { challenge: string } & Record<string, any>;
}

const setups = new Map<string, SetupEntry>();

export function createSetupToken(wallet: string, now = Date.now()): string {
  for (const [t, e] of setups) if (e.expires < now) setups.delete(t);
  const token = crypto.randomBytes(24).toString("base64url");
  setups.set(token, { wallet: wallet.toLowerCase(), expires: now + SETUP_TTL_MS });
  return token;
}

/** The live entry for a setup link, or null if unknown / expired / used. */
export function getSetup(token: unknown, now = Date.now()): SetupEntry | null {
  const e = typeof token === "string" ? setups.get(token) : undefined;
  if (!e || e.expires < now) return null;
  return e;
}

/** Use the link up (whether registration then succeeds or not). */
export function consumeSetup(token: string): void {
  setups.delete(token);
}
