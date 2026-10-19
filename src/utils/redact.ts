// ─── Utils — keeping user data out of the server log ───
// The server never logs what a user typed or who they are: no message text, no plan summaries,
// no recipients, no full wallet addresses. Logs carry a short request id, the kind of request, the
// outcome, the risk score and timings. Everything printed that could hold an address goes
// through these helpers. Transaction hashes are public and stay whole.

import * as crypto from "crypto";

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/** 0x5879…5723 — enough to tell two wallets apart in a log, not enough to identify one. */
export function shortAddr(address: string | null | undefined): string {
  if (!address) return "none";
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : "?";
}

/** The text with every full address (20 bytes) shortened; 32-byte transaction hashes are left alone. */
export function redactAddrs(text: unknown): string {
  return String(text ?? "")
    .replace(ADDRESS, (a) => shortAddr(a))
    .replace(/bot\d+:[\w-]+/g, "bot<token>"); // Telegram puts the bot token in its request URLs
}

/** An error's message for the log: addresses shortened, one line, bounded. */
export function safeErr(err: unknown): string {
  const raw = (err as { shortMessage?: string; message?: string } | null)?.shortMessage ?? (err as { message?: string } | null)?.message ?? err;
  return redactAddrs(raw).replace(/\s+/g, " ").slice(0, 200);
}

/** A storage key such as `passkey:0xabc…` with the address inside shortened. */
export const shortKey = redactAddrs;

/** A short id to tie together the log lines of one request. */
export function requestId(): string {
  return crypto.randomBytes(3).toString("hex");
}

/** Message text may be logged only on a developer's machine that asked for it, never in production. */
export function userMessageLoggingOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOG_USER_MESSAGES === "1" && env.NODE_ENV !== "production";
}

/** Logs the user's message for local debugging when LOG_USER_MESSAGES=1 (and NODE_ENV isn't production). */
export function logUserMessage(rid: string, message: string, log: (line: string) => void = console.log): void {
  if (userMessageLoggingOn()) log(`[intent ${rid}] message: ${JSON.stringify(message)}`);
}

export interface IntentLogFields {
  rid: string;
  kind: string;
  intentType?: string;
  outcome: string;
  riskScore?: number;
  plannerMs?: number;
  totalMs: number;
  model?: string;
}

/** The one summary line per /intent request: ids, kinds and numbers only. */
export function intentSummaryLine(f: IntentLogFields): string {
  const parts = [`[intent ${f.rid}]`, `kind=${f.kind}`];
  if (f.intentType) parts.push(`type=${f.intentType}`);
  parts.push(`outcome=${f.outcome}`);
  if (f.riskScore != null) parts.push(`risk=${f.riskScore}`);
  if (f.plannerMs != null) parts.push(`planner=${f.plannerMs}ms`);
  parts.push(`total=${f.totalMs}ms`);
  if (f.model) parts.push(`model=${f.model}`);
  return parts.join(" ");
}

/** What happened to a request, from its response: the policy verdict, "answered", "clarify", "failed(status)"… */
export function intentOutcome(statusCode: number, body: any): string {
  if (statusCode >= 400) return `failed(${statusCode})`;
  if (body?.autoExecuted) return "AUTO_EXECUTE";
  switch (body?.status) {
    case "reply": return "answered";
    case "needs_clarification": return "clarify";
    case "passkey_required": return "passkey_required";
    case "unsupported": return body?.assessment?.verdict ?? "unsupported";
    default: {
      const verdict = body?.assessment?.verdict;
      return verdict && verdict !== "INFO" ? verdict : "answered";
    }
  }
}
