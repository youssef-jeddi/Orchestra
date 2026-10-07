// ─── Passkey (WebAuthn) — approval factor ───
// Registers device passkeys per wallet and verifies assertions. A wallet can
// hold several: one in the desktop browser, one on the phone. A passkey is
// bound to the domain (RP ID) it was created on, so each is stored with its RP
// ID and only offered on that domain:
//   browser  PASSKEY_RP_ID / PASSKEY_ORIGIN           (the desktop app)
//   phone    host / origin of PUBLIC_APP_URL          (the phone approval page)
//
// Approvals pass a challenge derived from the pending payload's hash, so a
// verified assertion commits to exactly that payload. It still doesn't sign the
// tx bytes themselves — the server builds and executes them.
//
// WebAuthn crypto is handled by @simplewebauthn/server — never hand-rolled.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { read, write } from "../zero-g/storage";

export interface RelyingParty {
  rpID: string;
  origin: string;
}

export type PasskeyLabel = "browser" | "phone";

const RP_NAME = "Orchestra";

export function browserRp(): RelyingParty {
  return {
    rpID: process.env.PASSKEY_RP_ID || "localhost",
    origin: process.env.PASSKEY_ORIGIN || "http://localhost:3000",
  };
}

/** The phone approval page's relying party, or null when PUBLIC_APP_URL isn't an https URL. */
export function phoneRp(): RelyingParty | null {
  const raw = process.env.PUBLIC_APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null; // WebAuthn needs a secure context off localhost
    return { rpID: url.hostname, origin: url.origin };
  } catch {
    return null;
  }
}

/**
 * The relying party for a desktop request, from its Origin header: the app can
 * be opened on localhost or on PUBLIC_APP_URL (e.g. through a tunnel), and a
 * passkey must be created/used for the domain the page is actually on. Unknown
 * origins get null: the browser would refuse anyway, so say it clearly instead.
 */
export function rpForOrigin(origin: string | undefined): RelyingParty | null {
  const browser = browserRp();
  if (!origin || origin === browser.origin) return browser;
  const phone = phoneRp();
  if (phone && origin === phone.origin) return phone;
  return null;
}

// Short-lived challenge store (in-memory) for flows that don't hold their own.
const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map<string, { challenge: string; expires: number }>();

function setChallenge(key: string, challenge: string): void {
  challenges.set(key.toLowerCase(), { challenge, expires: Date.now() + CHALLENGE_TTL_MS });
}
function takeChallenge(key: string): string | null {
  const k = key.toLowerCase();
  const e = challenges.get(k);
  challenges.delete(k); // single-use
  if (!e || e.expires < Date.now()) return null;
  return e.challenge;
}

interface StoredCred {
  id: string;
  publicKey: string; // base64
  counter: number;
  transports?: string[];
  rpID: string;
  label: PasskeyLabel;
  createdAt?: string;
  /** Where it was created when not registered here: the Privy sign-in passkey. */
  source?: "privy";
}

const storeKey = (wallet: string) => `passkey:${wallet.toLowerCase()}`;

async function getCreds(wallet: string): Promise<StoredCred[]> {
  try {
    const stored = (await read(storeKey(wallet))) as any;
    if (!stored) return [];
    if (Array.isArray(stored.creds)) return stored.creds;
    // Before multi-passkey support a single browser credential was stored bare.
    if (stored.id && stored.publicKey) return [{ ...stored, rpID: stored.rpID || browserRp().rpID, label: "browser" }];
    return [];
  } catch {
    return [];
  }
}

async function saveCreds(wallet: string, creds: StoredCred[]): Promise<void> {
  await write(storeKey(wallet), { creds });
}

/** A passkey usable on `rp` (the desktop app's domain by default). */
export async function hasPasskey(wallet: string, rp: RelyingParty = browserRp()): Promise<boolean> {
  return (await getCreds(wallet)).some((c) => c.rpID === rp.rpID);
}

/** A passkey registered on the phone for the current PUBLIC_APP_URL domain. */
export async function hasPhonePasskey(wallet: string): Promise<boolean> {
  const rp = phoneRp();
  if (!rp) return false;
  return (await getCreds(wallet)).some((c) => c.label === "phone" && c.rpID === rp.rpID);
}

// ── Registration ──

/** Options to create a passkey on `rp`. Without `holdChallenge`, the challenge is kept per wallet. */
export async function registrationOptions(wallet: string, rp: RelyingParty = browserRp(), holdChallenge = false) {
  const existing = (await getCreds(wallet)).filter((c) => c.rpID === rp.rpID);
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: wallet,
    userID: new TextEncoder().encode(wallet.toLowerCase()),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as any })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  if (!holdChallenge) setChallenge(`reg:${wallet}:${rp.rpID}`, opts.challenge);
  return opts;
}

export async function verifyRegistration(
  wallet: string,
  response: any,
  opts: { rp?: RelyingParty; challenge?: string; label?: PasskeyLabel } = {}
): Promise<boolean> {
  const rp = opts.rp ?? browserRp();
  const expectedChallenge = opts.challenge ?? takeChallenge(`reg:${wallet}:${rp.rpID}`);
  if (!expectedChallenge) throw new Error("No or expired registration challenge");

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration could not be verified");
  }

  const cred = verification.registrationInfo.credential;
  const creds = (await getCreds(wallet)).filter((c) => c.id !== cred.id);
  creds.push({
    id: cred.id,
    publicKey: Buffer.from(cred.publicKey).toString("base64"),
    counter: cred.counter,
    transports: response?.response?.transports,
    rpID: rp.rpID,
    label: opts.label ?? "browser",
    createdAt: new Date().toISOString(),
  });
  await saveCreds(wallet, creds);
  return true;
}

/**
 * Add a passkey that was created outside our registration flow: the Privy
 * sign-in passkey, which Privy creates in our page, so on our own domain. The
 * public key must be a COSE key (base64 or base64url) and the id a credential
 * id; anything else is refused, so a bad record fails closed. Returns whether
 * the wallet now holds the credential.
 */
export async function addExternalCredential(
  wallet: string,
  cred: { id: string; publicKey: string; rpID: string; source: "privy" }
): Promise<boolean> {
  let id: string;
  let publicKey: Uint8Array<ArrayBuffer>;
  try {
    id = Buffer.from(cred.id, "base64").toString("base64url"); // assertions report base64url ids
    publicKey = new Uint8Array(Buffer.from(cred.publicKey, "base64"));
    const cose = decodeCredentialPublicKey(publicKey);
    if (!id || !(cose instanceof Map) || cose.get(1) === undefined || cose.get(3) === undefined) return false; // kty, alg
  } catch {
    return false;
  }
  const creds = await getCreds(wallet);
  if (creds.some((c) => c.id === id && c.rpID === cred.rpID)) return true; // keep its counter
  creds.push({
    id,
    publicKey: Buffer.from(publicKey).toString("base64"),
    counter: 0,
    rpID: cred.rpID,
    label: "browser",
    createdAt: new Date().toISOString(),
    source: cred.source,
  });
  await saveCreds(wallet, creds);
  return true;
}

// ── Authentication ──
// Approvals pass their own challenge (derived from the pending payload's hash)
// and hold it themselves; without one, a random challenge is kept per wallet.
export async function authenticationOptions(wallet: string, challenge?: Uint8Array, rp: RelyingParty = browserRp()) {
  const creds = (await getCreds(wallet)).filter((c) => c.rpID === rp.rpID);
  if (creds.length === 0) throw new Error("No passkey registered for this wallet on this device");

  const opts = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as any })),
    userVerification: "preferred",
    ...(challenge ? { challenge: challenge as Uint8Array<ArrayBuffer> } : {}),
  });
  if (!challenge) setChallenge(`auth:${wallet}:${rp.rpID}`, opts.challenge);
  return opts;
}

/** Verify an assertion. Returns true only if the passkey signature checks out. */
export async function verifyAuthentication(wallet: string, response: any, challenge?: string, rp: RelyingParty = browserRp()): Promise<boolean> {
  const expectedChallenge = challenge ?? takeChallenge(`auth:${wallet}:${rp.rpID}`);
  if (!expectedChallenge) throw new Error("No or expired authentication challenge");

  const creds = await getCreds(wallet);
  const cred = creds.find((c) => c.id === response?.id && c.rpID === rp.rpID);
  if (!cred) throw new Error("This passkey isn't registered for this wallet");

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: cred.id,
      publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64")),
      counter: cred.counter,
      transports: cred.transports as any,
    },
  });

  if (verification.verified) {
    // Persist the incremented signature counter (replay defense).
    cred.counter = verification.authenticationInfo.newCounter;
    await saveCreds(wallet, creds);
  }
  return verification.verified;
}
