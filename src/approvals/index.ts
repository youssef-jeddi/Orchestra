// ─── Approvals — server-held pending actions ───
// When the policy says NEEDS_APPROVAL for an action the agent executes through
// the Safe, the exact execution payload is stored here under an id, with a hash
// of it. Every approval factor (passkey, Telegram, …) approves *this record*:
// the approve endpoints execute only what was stored, never a payload sent by
// the client, so a compromised frontend can't swap the transaction after the
// user approved what they were shown.
//
// The in-memory Map is the source of truth inside the process (so the
// pending → executing claim is atomic), and every state change that matters is
// written through to storage (`approvals/<id>`) and awaited, so a pending
// approval survives a bridge restart. The order is what keeps it safe: a payload
// runs only after "executing" was saved, so a restart can never run it twice, and
// a record found "executing" after a restart is failed, never re-run. Passkey
// challenges and the plain review token are never written.

import crypto from "crypto";
import { write as storageWrite, readMany as storageReadMany, deleteKey as storageDelete } from "../integrations/zero-g/storage";
import { safeErr } from "../utils/redact";

export const APPROVAL_TTL_MS = 10 * 60_000;

export type ApprovalStatus = "pending" | "executing" | "executed" | "rejected" | "expired" | "failed";

export interface PendingApproval {
  id: string;
  /** Lowercased wallet that owns the Safe. */
  wallet: string;
  safeAddress: string;
  intentType: "swap" | "send" | "add_liquidity" | "remove_liquidity" | "plan";
  summary: string;
  valueUsd: number;
  /** Why approval is required (policy reason + rule slugs). */
  reason: string;
  triggered: string[];
  /** Exactly what the adapter's execute() receives as payload: { quoteData } or { sendData }. */
  execution: Record<string, unknown>;
  /** sha256 of the canonical execution payload. */
  hash: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  /** Current passkey challenge (base64url), bound to id + hash. Single-use. */
  challenge?: string;
  /**
   * The WebAuthn options that carry `challenge`. Asking for options again while
   * that challenge is unused returns these instead of replacing the challenge,
   * so a page that fetches twice can't end up signing a stale one.
   */
  passkeyOptions?: { challenge: string } & Record<string, unknown>;
  /** Set when the approval was sent to an out-of-band channel; it can then only be approved there. */
  channel?: "telegram";
  telegram?: { chatId: number; messageId: number };
  /**
   * How the Telegram approval is confirmed: the in-chat button, or the phone
   * review page + the phone's passkey (the Approve button is then refused).
   */
  factor?: "telegram-button" | "phone-passkey";
  /**
   * sha256 of the secret in the review-page link (the link goes only to Telegram; the page is
   * useless without it). Only the hash is kept, so the stored record can't be used to approve.
   */
  reviewTokenHash?: string;
  result?: { txHash: string; explorerUrl: string };
  error?: string;
  /** A plan's steps once it ran (ORC-21): which went through, with their receipts, and which didn't. */
  steps?: { index: number; summary: string; status: string; txHash?: string; explorerUrl?: string; error?: string }[];
}

export interface NewApproval {
  wallet: string;
  safeAddress: string;
  intentType: "swap" | "send" | "add_liquidity" | "remove_liquidity" | "plan";
  summary: string;
  valueUsd: number;
  reason: string;
  triggered: string[];
  execution: Record<string, unknown>;
}

const approvals = new Map<string, PendingApproval>();

/** Where approvals are persisted. Swappable in tests to simulate a failing disk. */
export interface ApprovalStore {
  write(key: string, data: unknown): Promise<void>;
  readMany(collection: string): Promise<unknown[]>;
  delete(key: string): Promise<void>;
}
const defaultStore: ApprovalStore = { write: storageWrite, readMany: storageReadMany, delete: storageDelete };
let store: ApprovalStore = defaultStore;

const SAVE_CLAIM_FAILED = "I couldn't save your OK, so nothing was done. Please try again in a moment.";
const SAVE_DECLINE_FAILED = "I couldn't save that, so the request is still waiting. Please try again.";
export const APPROVAL_GONE = "This request expired. Ask me again.";

/** The record as stored: a passkey challenge is single-use and a fresh one is issued after a restart. */
function persistable(a: PendingApproval): Omit<PendingApproval, "challenge" | "passkeyOptions"> {
  const { challenge: _c, passkeyOptions: _p, ...rest } = a;
  return rest;
}

function save(a: PendingApproval): Promise<void> {
  return store.write(`approvals/${a.id}`, persistable(a));
}

/**
 * Save the record, undoing the in-memory change if that fails: the caller has already moved
 * `a.status`, and a decision that wasn't saved must not count (a restart would forget it).
 */
async function saveOrRevert(a: PendingApproval, revertTo: ApprovalStatus, message: string): Promise<void> {
  try {
    await save(a);
  } catch (err) {
    console.error(`[approval] ${a.id} couldn't be saved: ${safeErr(err)}`);
    a.status = revertTo;
    throw new ApprovalError(503, message);
  }
}

/** JSON with sorted object keys, so the same payload always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashExecution(execution: Record<string, unknown>): string {
  return "0x" + crypto.createHash("sha256").update(canonicalJson(execution)).digest("hex");
}

/** Hold a new pending approval. Saved before it is returned: if that fails nothing is held and this throws. */
export async function createApproval(input: NewApproval, now = Date.now()): Promise<PendingApproval> {
  sweep(now);
  const approval: PendingApproval = {
    ...input,
    id: crypto.randomUUID(),
    wallet: input.wallet.toLowerCase(),
    hash: hashExecution(input.execution),
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    status: "pending",
  };
  await save(approval);
  approvals.set(approval.id, approval);
  return approval;
}

/**
 * Save the approval's current fields (Telegram channel, factor, message ids, review token hash).
 * Throws if it can't be saved; `required: false` logs instead (the message ids are best effort).
 */
export async function persistApproval(a: PendingApproval, { required = true } = {}): Promise<void> {
  try {
    await save(a);
  } catch (err) {
    if (required) throw err;
    console.warn(`[approval] ${a.id} couldn't be saved: ${safeErr(err)}`);
  }
}

/**
 * Load the saved approvals into memory; call once at startup, before serving. A read failure throws
 * (the bridge must not start as if nothing were pending). Records that can't be trusted are dropped
 * or failed, never run: a payload that no longer matches its hash, and anything that was mid-execution
 * (we can't know whether it went out).
 */
export async function loadApprovals(now = Date.now()): Promise<number> {
  const rows = await store.readMany("approvals");
  let loaded = 0;
  for (const row of rows) {
    const a = row as PendingApproval | null;
    if (!a || typeof a.id !== "string" || typeof a.wallet !== "string" || typeof a.hash !== "string"
      || !a.execution || typeof a.execution !== "object" || typeof a.expiresAt !== "number") {
      console.warn("[approval] ignored a saved approval that is incomplete");
      continue;
    }
    a.wallet = a.wallet.toLowerCase();
    let changed = false;
    // Only an open request is failed: an executed or declined one keeps its (final) outcome.
    if ((a.status === "pending" || a.status === "executing") && hashExecution(a.execution) !== a.hash) {
      a.status = "failed";
      a.error = "This request was changed after it was made, so it was cancelled. Nothing was done.";
      changed = true;
    } else if (a.status === "executing") {
      a.status = "failed";
      a.error = "The server restarted while this was running. Check your activity before asking again.";
      changed = true;
    } else if (a.status === "pending" && a.expiresAt <= now) {
      a.status = "expired";
    }
    approvals.set(a.id, a);
    loaded++;
    if (changed) await persistApproval(a, { required: false });
  }
  return loaded;
}

/** The approval, with a lapsed pending one marked expired. */
export function getApproval(id: string, now = Date.now()): PendingApproval | null {
  const a = approvals.get(id);
  if (!a) return null;
  if (a.status === "pending" && a.expiresAt <= now) {
    a.status = "expired";
    a.challenge = undefined;
  }
  return a;
}

/** A pending approval owned by `wallet`, or an Error explaining why not. */
export function requirePending(id: unknown, wallet: unknown, now = Date.now()): PendingApproval {
  const a = typeof id === "string" ? getApproval(id, now) : null;
  if (!a) throw new ApprovalError(404, APPROVAL_GONE);
  if (typeof wallet !== "string" || a.wallet !== wallet.toLowerCase()) throw new ApprovalError(403, "This approval belongs to another wallet.");
  if (a.status !== "pending") throw new ApprovalError(409, `This approval is already ${a.status}.`);
  return a;
}

/**
 * A fresh passkey challenge for this approval: sha256(id, payload hash, nonce).
 * The signed WebAuthn clientData then commits to the exact payload.
 */
export function challengeBytes(a: PendingApproval): Uint8Array {
  const nonce = crypto.randomBytes(16).toString("hex");
  return new Uint8Array(crypto.createHash("sha256").update(`orchestra-approval:${a.id}:${a.hash}:${nonce}`).digest());
}

/** Create the review-page secret for a phone-passkey approval. */
export function issueReviewToken(a: PendingApproval): string {
  const token = crypto.randomBytes(24).toString("base64url");
  a.reviewTokenHash = hashToken(token);
  return token;
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** The approval behind a review-page link, if the link's secret matches (any status). */
export function approvalForReview(id: unknown, token: unknown, now = Date.now()): PendingApproval {
  const a = typeof id === "string" ? getApproval(id, now) : null;
  const given = Buffer.from(hashToken(typeof token === "string" ? token : ""));
  const expected = Buffer.from(a?.reviewTokenHash ?? "");
  if (!a || !a.reviewTokenHash || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new ApprovalError(404, "This approval link is invalid or has expired.");
  }
  return a;
}

/**
 * Atomically move pending → executing. Only one approver can ever win: the status flips in memory
 * before the first await. "executing" is then saved, and if that fails the claim is undone and the
 * caller must not run the payload (otherwise a restart could run it a second time).
 */
export async function claim(id: string, wallet: string, now = Date.now()): Promise<PendingApproval> {
  const a = requirePending(id, wallet, now);
  a.status = "executing";
  a.challenge = undefined;
  await saveOrRevert(a, "pending", SAVE_CLAIM_FAILED);
  return a;
}

export async function reject(id: string, wallet: string, now = Date.now()): Promise<PendingApproval> {
  const a = requirePending(id, wallet, now);
  a.status = "rejected";
  a.challenge = undefined;
  await saveOrRevert(a, "pending", SAVE_DECLINE_FAILED);
  return a;
}

/**
 * The user's own "no" from the app: rejects the wallet's pending approval, whatever
 * channel it went out on (passkey or Telegram), and lets `afterReject` close the
 * matching Telegram request. Final: a rejected approval can't be claimed, so a later
 * passkey or Telegram "yes" for it is refused and nothing executes. A failure in
 * `afterReject` (Telegram down) never undoes the decline.
 */
export async function declineApproval(
  id: unknown,
  wallet: unknown,
  afterReject?: (a: PendingApproval) => Promise<void>,
  now = Date.now(),
): Promise<PendingApproval> {
  const a = typeof id === "string" ? getApproval(id, now) : null;
  if (!a || a.status === "expired") throw new ApprovalError(404, APPROVAL_GONE);
  if (typeof wallet !== "string" || a.wallet !== wallet.toLowerCase()) throw new ApprovalError(403, "This approval belongs to another wallet.");
  if (a.status !== "pending") throw new ApprovalError(409, `This request is already ${a.status}, so it can't be declined.`);
  a.status = "rejected";
  a.challenge = undefined;
  a.passkeyOptions = undefined;
  await saveOrRevert(a, "pending", SAVE_DECLINE_FAILED);
  try {
    await afterReject?.(a);
  } catch {
    /* the decline stands; the chat message just stays as it was */
  }
  return a;
}

/**
 * Record how a claimed approval ended. A failed save is logged and swallowed: the payload already
 * ran, and the record on disk stays "executing", which a restart turns into failed, never pending.
 */
export async function settle(a: PendingApproval, outcome: { result: { txHash: string; explorerUrl: string } } | { error: string }): Promise<void> {
  if ("result" in outcome) {
    a.status = "executed";
    a.result = outcome.result;
  } else {
    a.status = "failed";
    a.error = outcome.error;
  }
  await persistApproval(a, { required: false });
}

/** What the API exposes about an approval (no execution payload). */
export function approvalView(a: PendingApproval) {
  return {
    id: a.id, status: a.status, intentType: a.intentType, summary: a.summary,
    hash: a.hash, expiresAt: new Date(a.expiresAt).toISOString(), channel: a.channel ?? "passkey",
    ...(a.factor ? { factor: a.factor } : {}),
    ...(a.result ? a.result : {}), ...(a.error ? { error: a.error } : {}),
    ...(a.steps ? { steps: a.steps.map(({ index, summary, status, txHash, explorerUrl }) => ({ index, summary, status, txHash, explorerUrl })) } : {}),
  };
}

export class ApprovalError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Drop records well past their expiry so the map doesn't grow unbounded. */
function sweep(now: number): void {
  for (const [id, a] of approvals) {
    if (a.expiresAt + APPROVAL_TTL_MS >= now) continue;
    approvals.delete(id);
    store.delete(`approvals/${id}`).catch((err) => console.warn(`[approval] couldn't delete ${id}: ${safeErr(err)}`));
  }
}

/** Test hook: forget what's in memory, as a restart does (storage is untouched). */
export function _resetApprovals(): void {
  approvals.clear();
}

/** Test hook: use another store (e.g. one whose writes fail); no argument restores the real one. */
export function _setApprovalStore(s?: ApprovalStore): void {
  store = s ?? defaultStore;
}
