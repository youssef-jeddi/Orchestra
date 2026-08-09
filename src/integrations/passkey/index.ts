// ─── Passkey (WebAuthn) — medium-tier approval factor ───
// Registers a device passkey per wallet and verifies assertions. A verified
// assertion proves user presence (phishing-resistant biometric) — it authorizes
// the agent wallet to execute a tx via the Safe. It does NOT sign the tx bytes,
// which is why this is the MEDIUM tier; high-value txs still require a Ledger.
//
// WebAuthn crypto is handled by @simplewebauthn/server — never hand-rolled.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { read, write } from "../zero-g/storage";

const RP_ID = process.env.PASSKEY_RP_ID || "localhost";
const RP_NAME = "Orchestra";
const ORIGIN = process.env.PASSKEY_ORIGIN || "http://localhost:3000";

// Short-lived challenge store (in-memory), keyed by wallet. A challenge is
// single-use and expires quickly, binding an assertion to a specific request.
const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map<string, { challenge: string; expires: number }>();

function setChallenge(wallet: string, challenge: string): void {
  challenges.set(wallet.toLowerCase(), { challenge, expires: Date.now() + CHALLENGE_TTL_MS });
}
function takeChallenge(wallet: string): string | null {
  const key = wallet.toLowerCase();
  const e = challenges.get(key);
  challenges.delete(key); // single-use
  if (!e || e.expires < Date.now()) return null;
  return e.challenge;
}

interface StoredCred {
  id: string;
  publicKey: string; // base64
  counter: number;
  transports?: string[];
}

async function getCred(wallet: string): Promise<StoredCred | null> {
  try {
    return (await read(`passkey:${wallet.toLowerCase()}`)) as StoredCred | null;
  } catch {
    return null;
  }
}

export async function hasPasskey(wallet: string): Promise<boolean> {
  return !!(await getCred(wallet));
}

// ── Registration ──
export async function registrationOptions(wallet: string) {
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: wallet,
    userID: new TextEncoder().encode(wallet.toLowerCase()),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  setChallenge(wallet, opts.challenge);
  return opts;
}

export async function verifyRegistration(wallet: string, response: any): Promise<boolean> {
  const expectedChallenge = takeChallenge(wallet);
  if (!expectedChallenge) throw new Error("No or expired registration challenge");

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration could not be verified");
  }

  const cred = verification.registrationInfo.credential;
  const stored: StoredCred = {
    id: cred.id,
    publicKey: Buffer.from(cred.publicKey).toString("base64"),
    counter: cred.counter,
    transports: response?.response?.transports,
  };
  await write(`passkey:${wallet.toLowerCase()}`, stored);
  return true;
}

// ── Authentication ──
export async function authenticationOptions(wallet: string) {
  const cred = await getCred(wallet);
  if (!cred) throw new Error("No passkey registered for this wallet");

  const opts = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: [{ id: cred.id, transports: cred.transports as any }],
    userVerification: "preferred",
  });
  setChallenge(wallet, opts.challenge);
  return opts;
}

/** Verify an assertion. Returns true only if the passkey signature checks out. */
export async function verifyAuthentication(wallet: string, response: any): Promise<boolean> {
  const expectedChallenge = takeChallenge(wallet);
  if (!expectedChallenge) throw new Error("No or expired authentication challenge");

  const cred = await getCred(wallet);
  if (!cred) throw new Error("No passkey registered for this wallet");

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: cred.id,
      publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64")),
      counter: cred.counter,
      transports: cred.transports as any,
    },
  });

  if (verification.verified) {
    // Persist the incremented signature counter (replay defense).
    await write(`passkey:${wallet.toLowerCase()}`, {
      ...cred,
      counter: verification.authenticationInfo.newCounter,
    });
  }
  return verification.verified;
}
