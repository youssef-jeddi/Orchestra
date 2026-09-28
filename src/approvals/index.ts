// ─── Approvals — server-held pending actions ───
// When the policy says NEEDS_APPROVAL for an action the agent executes through
// the Safe, the exact execution payload is stored here under an id, with a hash
// of it. Every approval factor (passkey, Telegram, …) approves *this record*:
// the approve endpoints execute only what was stored, never a payload sent by
// the client, so a compromised frontend can't swap the transaction after the
// user approved what they were shown.
//
// In-memory on purpose: approvals live ~10 minutes, and a restart simply
// cancels the pending ones (fail-closed).

import crypto from "crypto";

export const APPROVAL_TTL_MS = 10 * 60_000;

export type ApprovalStatus = "pending" | "executing" | "executed" | "rejected" | "expired" | "failed";

export interface PendingApproval {
  id: string;
  /** Lowercased wallet that owns the Safe. */
  wallet: string;
  safeAddress: string;
  intentType: "swap" | "send" | "add_liquidity";
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
  /** Secret in the review-page link, sent only to Telegram (the page is useless without it). */
  reviewToken?: string;
  result?: { txHash: string; explorerUrl: string };
  error?: string;
}

export interface NewApproval {
  wallet: string;
  safeAddress: string;
  intentType: "swap" | "send" | "add_liquidity";
  summary: string;
  valueUsd: number;
  reason: string;
  triggered: string[];
  execution: Record<string, unknown>;
}

const approvals = new Map<string, PendingApproval>();

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

export function createApproval(input: NewApproval, now = Date.now()): PendingApproval {
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
  approvals.set(approval.id, approval);
  return approval;
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
  if (!a) throw new ApprovalError(404, "Unknown approval — it may have expired or the server restarted. Ask again.");
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
  a.reviewToken = crypto.randomBytes(24).toString("base64url");
  return a.reviewToken;
}

/** The approval behind a review-page link, if the link's secret matches (any status). */
export function approvalForReview(id: unknown, token: unknown, now = Date.now()): PendingApproval {
  const a = typeof id === "string" ? getApproval(id, now) : null;
  const given = Buffer.from(typeof token === "string" ? token : "");
  const expected = Buffer.from(a?.reviewToken ?? "");
  if (!a || !a.reviewToken || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new ApprovalError(404, "This approval link is invalid or has expired.");
  }
  return a;
}

/** Atomically move pending → executing. Only one approver can ever win. */
export function claim(id: string, wallet: string, now = Date.now()): PendingApproval {
  const a = requirePending(id, wallet, now);
  a.status = "executing";
  a.challenge = undefined;
  return a;
}

export function reject(id: string, wallet: string, now = Date.now()): PendingApproval {
  const a = requirePending(id, wallet, now);
  a.status = "rejected";
  a.challenge = undefined;
  return a;
}

export function settle(a: PendingApproval, outcome: { result: { txHash: string; explorerUrl: string } } | { error: string }): void {
  if ("result" in outcome) {
    a.status = "executed";
    a.result = outcome.result;
  } else {
    a.status = "failed";
    a.error = outcome.error;
  }
}

/** What the API exposes about an approval (no execution payload). */
export function approvalView(a: PendingApproval) {
  return {
    id: a.id, status: a.status, intentType: a.intentType, summary: a.summary,
    hash: a.hash, expiresAt: new Date(a.expiresAt).toISOString(), channel: a.channel ?? "passkey",
    ...(a.factor ? { factor: a.factor } : {}),
    ...(a.result ? a.result : {}), ...(a.error ? { error: a.error } : {}),
  };
}

export class ApprovalError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Drop records well past their expiry so the map doesn't grow unbounded. */
function sweep(now: number): void {
  for (const [id, a] of approvals) if (a.expiresAt + APPROVAL_TTL_MS < now) approvals.delete(id);
}

/** Test hook. */
export function _resetApprovals(): void {
  approvals.clear();
}
