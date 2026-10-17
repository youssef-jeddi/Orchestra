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
// A wallet's first passkey only needs its session. Adding or removing one
// after that needs a check with an existing passkey first (ownerCheckOptions /
// verifyOwner), or a session alone could add its own passkey and approve anything.
//
// WebAuthn crypto is handled by @simplewebauthn/server — never hand-rolled.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import crypto from "crypto";
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
interface HeldChallenge {
  challenge: string;
  expires: number;
  /** A registration challenge issued after a check with an existing passkey. */
  ownerChecked?: boolean;
}
const challenges = new Map<string, HeldChallenge>();

function setChallenge(key: string, challenge: string, ownerChecked = false): void {
  challenges.set(key.toLowerCase(), { challenge, expires: Date.now() + CHALLENGE_TTL_MS, ownerChecked });
}
function takeChallenge(key: string): HeldChallenge | null {
  const k = key.toLowerCase();
  const e = challenges.get(k);
  challenges.delete(k); // single-use
  if (!e || e.expires < Date.now()) return null;
  return e;
}

export class PasskeyError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
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

/** Any passkey at all, on any domain: then adding another needs an owner check. */
export async function hasAnyPasskey(wallet: string): Promise<boolean> {
  return (await getCreds(wallet)).length > 0;
}

/** The domains (RP IDs) the wallet's passkeys work on. */
export async function passkeyDomains(wallet: string): Promise<string[]> {
  return [...new Set((await getCreds(wallet)).map((c) => c.rpID))];
}

/** A passkey registered on the phone for the current PUBLIC_APP_URL domain. */
export async function hasPhonePasskey(wallet: string): Promise<boolean> {
  const rp = phoneRp();
  if (!rp) return false;
  return (await getCreds(wallet)).some((c) => c.label === "phone" && c.rpID === rp.rpID);
}

// ── Registration ──

/**
 * Options to create a passkey on `rp`. Without `holdChallenge`, the challenge is
 * kept per wallet, marked with `ownerChecked` (an existing passkey was checked
 * first, see verifyOwner).
 */
export async function registrationOptions(wallet: string, rp: RelyingParty = browserRp(), holdChallenge = false, ownerChecked = false) {
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
  if (!holdChallenge) setChallenge(`reg:${wallet}:${rp.rpID}`, opts.challenge, ownerChecked);
  return opts;
}

/**
 * Verify a new passkey and add it to the wallet. Refused when the wallet already
 * has a passkey and the ceremony didn't start with an owner check — checked here,
 * at the moment of adding, so a challenge handed out while the wallet had none
 * can't add a second one later. A held challenge passes its own `ownerChecked`.
 */
export async function verifyRegistration(
  wallet: string,
  response: any,
  opts: { rp?: RelyingParty; challenge?: string; ownerChecked?: boolean; label?: PasskeyLabel } = {}
): Promise<boolean> {
  const rp = opts.rp ?? browserRp();
  const held = opts.challenge ? { challenge: opts.challenge, ownerChecked: !!opts.ownerChecked } : takeChallenge(`reg:${wallet}:${rp.rpID}`);
  if (!held) throw new Error("No or expired registration challenge");
  const expectedChallenge = held.challenge;

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
  const existing = await getCreds(wallet);
  if (existing.length && !held.ownerChecked) throw ownerCheckNeeded();
  const creds = existing.filter((c) => c.id !== cred.id);
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

export interface ExternalCredential {
  id: string;
  publicKey: string;
  rpID: string;
  source: "privy";
}

/**
 * Add passkeys that were created outside our registration flow: the Privy
 * sign-in passkeys, which Privy creates in our page, so on our own domain. Each
 * public key must be a COSE key (base64 or base64url) and each id a credential
 * id; anything else is skipped, so a bad record fails closed.
 *
 * Only a wallet with no passkey yet takes new ones: the session is all that
 * stands behind them, like any first passkey. Ones it already holds are kept
 * (with their counter). Returns how many of `list` the wallet holds and how many
 * were newly added.
 */
export async function addExternalCredentials(wallet: string, list: ExternalCredential[]): Promise<{ held: number; added: number }> {
  const creds = await getCreds(wallet);
  const firstPasskeys = creds.length === 0;
  let held = 0;
  let added = 0;
  for (const cred of list) {
    let id: string;
    let publicKey: Uint8Array<ArrayBuffer>;
    try {
      id = Buffer.from(cred.id, "base64").toString("base64url"); // assertions report base64url ids
      publicKey = new Uint8Array(Buffer.from(cred.publicKey, "base64"));
      const cose = decodeCredentialPublicKey(publicKey);
      if (!id || !(cose instanceof Map) || cose.get(1) === undefined || cose.get(3) === undefined) continue; // kty, alg
    } catch {
      continue;
    }
    if (creds.some((c) => c.id === id && c.rpID === cred.rpID)) { held++; continue; } // keep its counter
    if (!firstPasskeys) continue;
    creds.push({
      id,
      publicKey: Buffer.from(publicKey).toString("base64"),
      counter: 0,
      rpID: cred.rpID,
      label: "browser",
      createdAt: new Date().toISOString(),
      source: cred.source,
    });
    held++;
    added++;
  }
  if (added) await saveCreds(wallet, creds);
  return { held, added };
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

// ── Listing and removing ──

export interface PasskeyView {
  id: string;
  rpID: string;
  label: PasskeyLabel;
  source?: "privy";
  createdAt?: string;
}

/** The wallet's passkeys, without their keys. */
export async function listPasskeys(wallet: string): Promise<PasskeyView[]> {
  return (await getCreds(wallet)).map(({ id, rpID, label, source, createdAt }) => ({ id, rpID, label, source, createdAt }));
}

/**
 * Remove one of the wallet's passkeys; the caller has checked the owner first
 * (verifyOwner). The last one stays: without any, a session alone could add one
 * again, so losing every passkey goes through recovery instead.
 */
export async function removePasskey(wallet: string, id: string): Promise<PasskeyView> {
  const creds = await getCreds(wallet);
  const cred = creds.find((c) => c.id === id);
  if (!cred) throw new PasskeyError(404, "This passkey isn't on this account.");
  if (creds.length === 1) throw new PasskeyError(409, "This is the account's only passkey. Add another before removing it.", "last_passkey");
  await saveCreds(wallet, creds.filter((c) => c !== cred));
  const { rpID, label, source, createdAt } = cred;
  return { id, rpID, label, source, createdAt };
}

// ── Owner check: an existing passkey before adding another ──

function ownerCheckNeeded(): PasskeyError {
  return new PasskeyError(403, "This account already has a passkey. Confirm with it first.", "passkey_required");
}

/**
 * Options to check an existing passkey of the wallet on `rp`, over a fresh
 * random challenge kept for verifyOwner. When the wallet's passkeys all live on
 * other domains, says where to go: the browser would refuse them here.
 */
export async function ownerCheckOptions(wallet: string, rp: RelyingParty = browserRp()) {
  const domains = await passkeyDomains(wallet);
  if (!domains.includes(rp.rpID)) {
    throw new PasskeyError(403, `This account's passkey works on ${domains.join(", ")}. Open Orchestra there to change the account's passkeys.`, "passkey_elsewhere");
  }
  const opts = await authenticationOptions(wallet, new Uint8Array(crypto.randomBytes(32)), rp);
  setChallenge(`owner:${wallet}:${rp.rpID}`, opts.challenge);
  return opts;
}

/**
 * Check `assertion` against the challenge from ownerCheckOptions (single-use).
 * Throws unless an existing passkey signed it.
 */
export async function verifyOwner(wallet: string, assertion: any, rp: RelyingParty = browserRp()): Promise<void> {
  if (!assertion) throw ownerCheckNeeded();
  const held = takeChallenge(`owner:${wallet}:${rp.rpID}`);
  if (!held) throw new PasskeyError(400, "The passkey check expired. Try again.");
  let ok = false;
  try {
    ok = await verifyAuthentication(wallet, assertion, held.challenge, rp);
  } catch (e: any) {
    throw new PasskeyError(401, `Passkey verification failed: ${e.message}`);
  }
  if (!ok) throw new PasskeyError(401, "Passkey verification failed");
}

/** Verify an assertion. Returns true only if the passkey signature checks out. */
export async function verifyAuthentication(wallet: string, response: any, challenge?: string, rp: RelyingParty = browserRp()): Promise<boolean> {
  const expectedChallenge = challenge ?? takeChallenge(`auth:${wallet}:${rp.rpID}`)?.challenge;
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
