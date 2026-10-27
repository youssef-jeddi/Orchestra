// ─── Approvals — the approve / decline flows, with their effects injected ───
// The decisions a user makes on a pending approval (passkey in the app, yes/no in
// Telegram), separated from the bridge so the ordering that matters is tested without
// network: the status is checked and claimed *before* anything executes, so a
// request the user already declined (or that someone else already settled) never runs.

import { requirePending, claim, reject, getApproval, settle, ApprovalError, type PendingApproval } from "./index";
import { sentRecipient } from "./describe";
import { recordKnownRecipient, recordActivity, spendActivity } from "../policy/store";
import { safeErr } from "../utils/redact";
import { UserFacingError, OverCapError } from "../utils/userFacing";
import { isUserFacing, executionErrorMessage } from "../integrations/ledger/errors";
import type { PlanRunResult, StepOutcome } from "../executor/plan";

/**
 * After a send through the account actually went through, remember who it paid: the next send to
 * them no longer asks. Only called on success (never for a decline, failure, expiry or a send from
 * the user's own wallet), and it never turns a completed send into an error.
 */
export async function rememberSentRecipient(wallet: string, intentType: string, execution: Record<string, unknown> | undefined): Promise<void> {
  if (intentType !== "send") return;
  const to = sentRecipient(execution);
  if (!to) return;
  try {
    await recordKnownRecipient(wallet, to);
  } catch (err: any) {
    console.warn(`[approval] sent, but couldn't remember the recipient: ${safeErr(err)}`);
  }
}

/** Token symbol/address for an activity row, matching what /intent auto-exec records when it can. */
function activityToken(intentType: string, execution: Record<string, unknown> | undefined): string | undefined {
  if (intentType === "swap") {
    const t = (execution as any)?.quoteData?.tokenIn;
    return typeof t === "string" ? t : undefined;
  }
  if (intentType === "send") {
    const tx = (execution as any)?.sendData?.unsignedTx;
    if (!tx) return undefined;
    return String(tx.data || "0x") === "0x" ? "ETH" : (typeof tx.to === "string" ? tx.to : undefined);
  }
  return undefined;
}

/**
 * After a claimed approval actually ran, record it like an auto-exec (once). Used by passkey and
 * Telegram; the owner-signed path records in submitOwnerSignature the same way.
 */
async function recordApprovalActivity(a: PendingApproval, result: { txHash: string; explorerUrl: string }): Promise<void> {
  try {
    await recordActivity(a.wallet, spendActivity({
      valueUsd: a.valueUsd,
      to: sentRecipient(a.execution),
      token: activityToken(a.intentType, a.execution),
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      source: "approved",
    }));
  } catch (err: any) {
    console.warn(`[approval] ran, but couldn't record activity: ${safeErr(err)}`);
  }
}

export const OVER_CAP_TELEGRAM_TEXT =
  "Your account's daily ceiling wouldn't let me send this one. You can open Orchestra and sign it yourself with your wallet, or try again after the daily reset.";
export const OVER_CAP_TELEGRAM_NO_LINK_TEXT =
  "Your account's daily ceiling wouldn't let me send this one. Open Orchestra and ask again to sign it yourself with your wallet, or try again after the daily reset.";

/** The Orchestra page that shows the owner-sign request again, or null without a PUBLIC_APP_URL. */
export function ownerSignLink(id: string, publicAppUrl = process.env.PUBLIC_APP_URL): string | null {
  if (!publicAppUrl) return null;
  try {
    return `${new URL(publicAppUrl).origin}/simple?ownerSign=${encodeURIComponent(id)}`;
  } catch {
    return null;
  }
}

export interface OverCapNotifier {
  link: (chatId: number, text: string, button: string, url: string) => Promise<void>;
  text: (chatId: number, text: string) => Promise<void>;
}

const telegramNotifier: OverCapNotifier = {
  link: async (...args) => (await import("../integrations/telegram")).sendLinkMessage(...args),
  text: async (...args) => (await import("../integrations/telegram")).sendText(...args),
};

/**
 * A Telegram approval stopped by the daily ceiling: send the link that opens the owner-sign
 * request in the app. A follow-up only — the approval is already settled as failed.
 */
export async function notifyOverCap(a: PendingApproval, err: unknown, notifier: OverCapNotifier = telegramNotifier): Promise<void> {
  if (!(err instanceof OverCapError) || a.channel !== "telegram" || !a.telegram?.chatId) return;
  const id = typeof err.ownerSign?.id === "string" ? err.ownerSign.id : null;
  if (!id) return;
  try {
    const url = ownerSignLink(id);
    if (url) await notifier.link(a.telegram.chatId, OVER_CAP_TELEGRAM_TEXT, "Open Orchestra to sign as owner", url);
    else await notifier.text(a.telegram.chatId, OVER_CAP_TELEGRAM_NO_LINK_TEXT);
  } catch (e: any) {
    console.warn(`[approval] ${a.id} couldn't send the over-ceiling follow-up: ${safeErr(e)}`);
  }
}

/** Run a claimed approval's stored payload (`run`) and record the outcome; a successful send is remembered. */
export async function executeApprovalFlow(
  a: PendingApproval,
  run: (a: PendingApproval) => Promise<{ txHash: string; explorerUrl: string } | null>,
  notifier?: OverCapNotifier,
): Promise<{ txHash: string; explorerUrl: string }> {
  try {
    const exec = await run(a);
    if (!exec) throw new UserFacingError("It ran but gave no result, so I can't confirm it went through");
    const result = { txHash: exec.txHash, explorerUrl: exec.explorerUrl };
    await settle(a, { result });
    await recordApprovalActivity(a, result);
    await rememberSentRecipient(a.wallet, a.intentType, a.execution);
    return result;
  } catch (err: any) {
    // The record is shown to the user (approval card, phone page, Telegram): only a message written
    // for them goes in; anything else (an RPC URL, a library error) stays in the log.
    if (!isUserFacing(err)) console.error(`[approval] ${a.id} failed unexpectedly: ${safeErr(err)}`);
    await settle(a, { error: executionErrorMessage(err) });
    await notifyOverCap(a, err, notifier);
    throw err;
  }
}

/**
 * Run a claimed plan approval (ORC-21) and record it: each step that went through is recorded toward
 * activity and the daily limit as it finishes (and a paid recipient remembered), a step that didn't
 * run never counts. All steps done settles it as executed with the last receipt; otherwise it is
 * failed with the plain list of what went through and what didn't, and that is thrown to the caller.
 */
export async function executePlanApprovalFlow(
  a: PendingApproval,
  run: (a: PendingApproval, onStepDone: (step: { intentType: string; execution: Record<string, unknown> }, outcome: StepOutcome) => Promise<void>) => Promise<PlanRunResult>,
  notifier?: OverCapNotifier,
): Promise<{ txHash: string; explorerUrl: string; steps: StepOutcome[]; text: string }> {
  const onStepDone = async (step: { intentType: string; execution: Record<string, unknown> }, outcome: StepOutcome) => {
    try {
      await recordActivity(a.wallet, spendActivity({
        valueUsd: outcome.valueUsd,
        to: sentRecipient(step.execution),
        token: activityToken(step.intentType, step.execution),
        txHash: outcome.txHash,
        explorerUrl: outcome.explorerUrl,
        source: "approved",
      }));
    } catch (err: any) {
      console.warn(`[approval] ${a.id} step ran, but couldn't record activity: ${safeErr(err)}`);
    }
    await rememberSentRecipient(a.wallet, step.intentType, step.execution);
  };
  let result: PlanRunResult;
  try {
    result = await run(a, onStepDone);
  } catch (err: any) {
    if (!isUserFacing(err)) console.error(`[approval] ${a.id} failed unexpectedly: ${safeErr(err)}`);
    await settle(a, { error: executionErrorMessage(err) });
    // A sends-only plan over the daily ceiling, approved in Telegram: send the link to sign it as owner.
    await notifyOverCap(a, err, notifier);
    throw err;
  }
  a.steps = result.steps.map(({ index, summary, status, txHash, explorerUrl, error }) => ({ index, summary, status, txHash, explorerUrl, error }));
  const last = [...result.steps].reverse().find((s) => s.status === "done");
  if (result.complete && last?.txHash && last.explorerUrl) {
    await settle(a, { result: { txHash: last.txHash, explorerUrl: last.explorerUrl } });
    return { txHash: last.txHash, explorerUrl: last.explorerUrl, steps: result.steps, text: result.text };
  }
  await settle(a, { error: result.text });
  throw new UserFacingError(result.text, result.refused ? 409 : 502);
}

export interface PasskeyApproveDeps {
  /** Check the WebAuthn response against the stored challenge. */
  verify: (challenge: string) => Promise<boolean>;
  /** Run the stored payload through the account. */
  execute: (a: PendingApproval) => Promise<{ txHash: string; explorerUrl: string }>;
}

/** Approve with a passkey assertion: pending + own wallet + passkey channel, then claim, then execute. */
export async function approveWithPasskeyFlow(wallet: string, approvalId: unknown, deps: PasskeyApproveDeps) {
  const a = requirePending(approvalId, wallet);
  if (a.channel === "telegram") throw new ApprovalError(409, "This approval was sent to your Telegram. Approve it there.");
  const challenge = a.challenge;
  a.challenge = undefined; // single-use, pass or fail
  if (!challenge) throw new ApprovalError(400, "Request passkey options for this approval first.");
  if (!(await deps.verify(challenge))) throw new ApprovalError(401, "That passkey check didn't work. Please try again.");
  await claim(a.id, wallet); // saved as "executing" before anything runs
  return { a, result: await deps.execute(a) };
}

export interface TelegramDecisionDeps {
  /** Funds can only move once the wallet holds a passkey (throws otherwise). */
  requirePasskey: (wallet: string) => Promise<void>;
  /** Whether a thrown error from requirePasskey means "no passkey yet". */
  isPasskeyError: (e: unknown) => boolean;
  /** Edit the Telegram message to the approval's current state. */
  refresh: (a: PendingApproval) => Promise<void>;
  /** Run the stored payload through the account (the result is shown by `refresh`). */
  execute: (a: PendingApproval) => Promise<unknown>;
}

/** Yes / no pressed in Telegram. Answers fast; execution continues in the background. */
export function telegramDecisionFlow(deps: TelegramDecisionDeps) {
  return async ({ wallet, approvalId, approve }: { wallet: string; approvalId: string; approve: boolean }): Promise<string> => {
    const a = getApproval(approvalId);
    if (!a || a.channel !== "telegram") return "This request expired. Ask me again.";
    if (a.wallet !== wallet) return "This approval belongs to another wallet.";
    if (a.status !== "pending") {
      await deps.refresh(a);
      return `Already ${a.status}.`;
    }
    if (!approve) {
      try {
        await reject(a.id, wallet);
      } catch (e) {
        if (e instanceof ApprovalError) return e.message; // couldn't save: still waiting
        throw e;
      }
      await deps.refresh(a);
      return "You said no. Nothing was done.";
    }
    // Phone-passkey approvals can't be approved with a chat button (there is none,
    // but a crafted callback must not skip the passkey either).
    if (a.factor === "phone-passkey") return "Open “Review & approve” and confirm with your phone's passkey.";
    try {
      await deps.requirePasskey(wallet);
    } catch (e) {
      if (deps.isPasskeyError(e)) return "Add a passkey in Orchestra first. Nothing was done.";
      throw e;
    }
    try {
      await claim(a.id, wallet); // saved as "executing" before anything runs
    } catch (e) {
      if (e instanceof ApprovalError) return e.message; // couldn't save: nothing was done
      throw e;
    }
    await deps.refresh(a); // "⏳ doing it…"
    deps.execute(a).catch(() => {}).finally(() => deps.refresh(a));
    return "Approved. Doing it now…";
  };
}
