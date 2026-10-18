// ─── Policy — changing your limits safely ───
// Library behind POST /policy and the Limits sheet. A change is validated (known fields, sane
// ranges), then classified against the stored values: lowering a limit or removing a saved
// address (tightening) applies at once with the session alone; raising a limit or removing a cap
// (loosening) needs proof it's the owner: their passkey if they have one, a wallet signature only
// if they have none. A session alone (stolen token, someone at the keyboard) must not be able to
// widen what the agent may do by itself. Proofs are bound to the exact new values and single-use.

import crypto from "crypto";
import { ethers } from "ethers";
import { resolveDailyLimit, DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT } from "./index";
import { readUserProfile, updateUserProfile, recipientsOf } from "./store";
import { hasAnyPasskey, authenticationOptions, verifyAuthentication, type RelyingParty } from "../integrations/passkey";
import { isEmailWallet } from "../integrations/passkey/emailGate";
import { canonicalJson } from "../approvals";

export const LIMIT_FIELDS = ["dailyLimitUsd", "maxAutoTxPerDay", "typicalMaxUsd"] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];
export const MAX_AUTO_TX_PER_DAY = 100;
export const MAX_TYPICAL_USD = 1_000_000;
export const CONFIRMATION_TTL_MS = 5 * 60_000;

export class LimitsError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface LimitChange {
  /** New value per field; null clears it (back to the default / no cap). */
  set: Partial<Record<LimitField, number | null>>;
  /** A saved address to forget. */
  removeAddress?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const bad = (msg: string) => new LimitsError(400, msg);

/** Validate a request body into a change. Anything unknown or out of range is refused in plain words. */
export function parseChange(body: unknown): LimitChange {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const set: LimitChange["set"] = {};
  if (b.policy !== undefined) {
    if (!b.policy || typeof b.policy !== "object" || Array.isArray(b.policy)) throw bad("Send the settings you want to change.");
    for (const [k, v] of Object.entries(b.policy as Record<string, unknown>)) {
      if (!(LIMIT_FIELDS as readonly string[]).includes(k)) {
        throw bad("Only your daily limit, your automatic-payment count and your usual amount can be changed here.");
      }
      const field = k as LimitField;
      if (v === null) { set[field] = null; continue; }
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad("Limits must be numbers.");
      if (field === "dailyLimitUsd" && (v < 0 || v > MAX_DAILY_LIMIT)) throw bad(`The daily limit must be between $0 and $${MAX_DAILY_LIMIT}.`);
      if (field === "maxAutoTxPerDay" && (!Number.isInteger(v) || v < 0 || v > MAX_AUTO_TX_PER_DAY)) throw bad(`The number of automatic payments must be a whole number from 0 to ${MAX_AUTO_TX_PER_DAY}.`);
      if (field === "typicalMaxUsd" && (v <= 0 || v > MAX_TYPICAL_USD)) throw bad("Your usual amount must be more than $0.");
      set[field] = v;
    }
  }
  let removeAddress: string | undefined;
  if (b.removeAddress !== undefined) {
    if (typeof b.removeAddress !== "string" || !ADDRESS.test(b.removeAddress)) throw bad("That isn't a valid address.");
    removeAddress = b.removeAddress.toLowerCase();
  }
  if (Object.keys(set).length === 0 && !removeAddress) throw bad("There is nothing to change.");
  return { set, ...(removeAddress ? { removeAddress } : {}) };
}

const num = (v: unknown, ok: (n: number) => boolean, otherwise: number) =>
  typeof v === "number" && Number.isFinite(v) && ok(v) ? v : otherwise;

/** How much the agent may do on its own under a value; bigger = looser. Missing means the default / no cap. */
function looseness(field: LimitField, v: unknown): number {
  if (field === "dailyLimitUsd") return resolveDailyLimit(v ?? undefined);
  if (field === "maxAutoTxPerDay") return num(v, (n) => n >= 0, Infinity);
  return num(v, (n) => n > 0, Infinity);
}

/** Loosening if any field would allow more than it does now; everything else (including no change) is tightening. */
export function classifyChange(storedPolicy: Record<string, unknown>, change: LimitChange): "tightening" | "loosening" {
  for (const field of LIMIT_FIELDS) {
    if (!(field in change.set)) continue;
    if (looseness(field, change.set[field]) > looseness(field, storedPolicy[field])) return "loosening";
  }
  return "tightening";
}

const changeKey = (c: LimitChange) => canonicalJson({ set: c.set, removeAddress: c.removeAddress ?? null });

// ── Proofs ──
interface Pending {
  wallet: string;
  key: string;
  method: "passkey" | "wallet";
  /** passkey: the WebAuthn challenge; wallet: the typed data the signature must match. */
  challenge?: string;
  typedData?: ReturnType<typeof limitTypedData>;
  expires: number;
}
const pending = new Map<string, Pending>();

function sweep(now: number): void {
  for (const [n, p] of pending) if (p.expires < now) pending.delete(n);
}

const show = (field: LimitField, v: number | null | undefined) =>
  v === undefined ? "unchanged"
    : v === null ? (field === "dailyLimitUsd" ? `$${DEFAULT_DAILY_LIMIT} (standard)` : "no limit")
      : field === "maxAutoTxPerDay" ? String(v) : `$${v}`;

function limitTypedData(wallet: string, nonce: string, expiresAt: string, c: LimitChange) {
  return {
    domain: { name: "Orchestra", version: "1", chainId: 11155111 },
    types: {
      LimitChange: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "string" },
        { name: "expiresAt", type: "string" },
        { name: "dailyLimit", type: "string" },
        { name: "automaticPaymentsPerDay", type: "string" },
        { name: "usualAmount", type: "string" },
        { name: "forgetAddress", type: "string" },
        { name: "statement", type: "string" },
      ],
    },
    primaryType: "LimitChange" as const,
    message: {
      wallet: ethers.getAddress(wallet),
      nonce,
      expiresAt,
      dailyLimit: show("dailyLimitUsd", c.set.dailyLimitUsd),
      automaticPaymentsPerDay: show("maxAutoTxPerDay", c.set.maxAutoTxPerDay),
      usualAmount: show("typicalMaxUsd", c.set.typicalMaxUsd),
      forgetAddress: c.removeAddress ?? "none",
      statement: "Change your Orchestra limits as shown. This doesn't move funds or cost gas.",
    },
  };
}

export type Confirmation =
  | { required: false }
  | { required: true; method: "passkey"; nonce: string; options: unknown }
  | { required: true; method: "wallet"; nonce: string; typedData: unknown };

/** Whether this change needs proof, and if so the challenge to answer (passkey options or typed data to sign). */
export async function requestConfirmation(wallet: string, body: unknown, rp: RelyingParty, now = Date.now()): Promise<Confirmation> {
  const change = parseChange(body);
  const stored = (await readUserProfile(wallet)).policy ?? {};
  if (classifyChange(stored, change) === "tightening") return { required: false };
  sweep(now);
  const w = wallet.toLowerCase();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const expires = now + CONFIRMATION_TTL_MS;
  if (await hasAnyPasskey(w)) {
    // The challenge commits to the exact new values, so the assertion can't be reused for other ones.
    const digest = crypto.createHash("sha256").update(`orchestra-limits:${w}:${changeKey(change)}:${nonce}`).digest();
    const options = await authenticationOptions(w, new Uint8Array(digest), rp);
    pending.set(nonce, { wallet: w, key: changeKey(change), method: "passkey", challenge: options.challenge, expires });
    return { required: true, method: "passkey", nonce, options };
  }
  if (await isEmailWallet(w)) throw new LimitsError(403, "Add a passkey first to raise your limits.", "passkey_required");
  const typedData = limitTypedData(w, nonce, new Date(expires).toISOString(), change);
  pending.set(nonce, { wallet: w, key: changeKey(change), method: "wallet", typedData, expires });
  return {
    required: true, method: "wallet", nonce,
    typedData: { ...typedData, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }], ...typedData.types } },
  };
}

function needProof(method: "passkey" | "wallet"): LimitsError {
  return new LimitsError(403, method === "passkey"
    ? "Raising a limit needs your passkey. Confirm with it to continue."
    : "Raising a limit needs your wallet's signature. Sign to continue.", "confirmation_required", { method });
}

/** Check the proof for a loosening change. The nonce is spent either way. */
async function verifyConfirmation(wallet: string, change: LimitChange, proof: any, rp: RelyingParty, now: number): Promise<void> {
  const w = wallet.toLowerCase();
  const method: "passkey" | "wallet" = (await hasAnyPasskey(w)) ? "passkey" : "wallet";
  if (!proof || typeof proof !== "object" || typeof proof.nonce !== "string") throw needProof(method);
  const held = pending.get(proof.nonce);
  pending.delete(proof.nonce); // single-use, pass or fail
  if (!held || held.expires < now) throw new LimitsError(403, "That confirmation expired. Try again.", "confirmation_required", { method });
  if (held.wallet !== w || held.key !== changeKey(change)) throw new LimitsError(403, "That confirmation was for something else. Try again.", "confirmation_required", { method });
  // A wallet that has a passkey can only use it: a signature from the wallet isn't enough.
  if (held.method !== method) throw needProof(method);
  if (method === "passkey") {
    let ok = false;
    try { ok = await verifyAuthentication(w, proof.response, held.challenge, rp); } catch { /* falls through */ }
    if (!ok) throw new LimitsError(401, "That passkey check didn't work. Please try again.", "confirmation_required", { method });
    return;
  }
  const td = held.typedData!;
  let signer = "";
  try { signer = ethers.verifyTypedData(td.domain, td.types, td.message, String(proof.signature)); } catch { /* invalid signature */ }
  if (signer.toLowerCase() !== w) throw new LimitsError(401, "That signature doesn't match your wallet. Try again.", "confirmation_required", { method });
}

/** The plain-words list of what was raised, for the Telegram notice. */
export function describeLoosening(before: Record<string, unknown>, change: LimitChange): string[] {
  const lines: string[] = [];
  const word = (field: LimitField, v: unknown) => {
    const n = looseness(field, v);
    return field === "dailyLimitUsd" ? `$${n}` : Number.isFinite(n) ? (field === "maxAutoTxPerDay" ? String(n) : `$${n}`) : "no limit";
  };
  const label: Record<LimitField, string> = { dailyLimitUsd: "Daily limit without asking", maxAutoTxPerDay: "Automatic payments per day", typicalMaxUsd: "Usual amount" };
  for (const f of LIMIT_FIELDS) {
    if (!(f in change.set)) continue;
    if (looseness(f, change.set[f]) > looseness(f, before[f])) lines.push(`${label[f]}: ${word(f, before[f])} → ${word(f, change.set[f])}`);
  }
  return lines;
}

export interface LimitsView {
  policy: Partial<Record<LimitField, number>>;
  knownRecipients: string[];
}

/** What the sheet shows: the three limits and the saved addresses (never other stored keys). */
export async function readLimits(wallet: string): Promise<LimitsView> {
  const p = await readUserProfile(wallet);
  const policy: LimitsView["policy"] = {};
  for (const f of LIMIT_FIELDS) if (typeof p.policy?.[f] === "number") policy[f] = p.policy[f];
  return { policy, knownRecipients: recipientsOf(p) };
}

/**
 * Apply a change. Tightening needs only the session; loosening needs `body.confirmation`
 * (see requestConfirmation). `notify` tells the user on Telegram about a loosening and never
 * blocks or fails the change.
 */
export async function applyChange(
  wallet: string,
  body: any,
  rp: RelyingParty,
  notify?: (wallet: string, text: string) => Promise<void>,
  now = Date.now(),
): Promise<LimitsView & { loosened: boolean }> {
  const change = parseChange(body);
  const before = (await readUserProfile(wallet)).policy ?? {};
  const loosening = classifyChange(before, change) === "loosening";
  if (loosening) await verifyConfirmation(wallet, change, body?.confirmation, rp, now);

  await updateUserProfile(wallet, (p) => {
    const policy: Record<string, unknown> = { ...(p.policy ?? {}) };
    delete policy.knownAddresses; // ignored since ORC-68: the server's own list is `knownRecipients`
    for (const [k, v] of Object.entries(change.set)) {
      if (v === null) delete policy[k];
      else policy[k] = v;
    }
    const next: Record<string, any> = { ...p, policy, updatedAt: new Date(now).toISOString() };
    if (change.removeAddress) next.knownRecipients = recipientsOf(p).filter((a) => a !== change.removeAddress);
    return next;
  });

  if (loosening && notify) {
    const lines = describeLoosening(before, change);
    notify(wallet, `⚠️ Your Orchestra limits were raised:\n${lines.join("\n")}\nIf this wasn't you, lower it in Orchestra (Limits).`).catch(() => {});
  }
  return { ...(await readLimits(wallet)), loosened: loosening };
}

/** Test hook. */
export function _resetLimits(): void {
  pending.clear();
}
