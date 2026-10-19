// ─── Approvals — the approve / decline flows, with their effects injected ───
// The decisions a user makes on a pending approval (passkey in the app, yes/no in
// Telegram), separated from the bridge so the ordering that matters is tested without
// network: the status is checked and claimed *before* anything executes, so a
// request the user already declined (or that someone else already settled) never runs.

import { requirePending, claim, reject, getApproval, settle, ApprovalError, type PendingApproval } from "./index";
import { sentRecipient } from "./describe";
import { recordKnownRecipient } from "../policy/store";
import { safeErr } from "../utils/redact";
import { UserFacingError } from "../utils/userFacing";

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

/** Run a claimed approval's stored payload (`run`) and record the outcome; a successful send is remembered. */
export async function executeApprovalFlow(
  a: PendingApproval,
  run: (a: PendingApproval) => Promise<{ txHash: string; explorerUrl: string } | null>,
): Promise<{ txHash: string; explorerUrl: string }> {
  try {
    const exec = await run(a);
    if (!exec) throw new UserFacingError("It ran but gave no result, so I can't confirm it went through");
    const result = { txHash: exec.txHash, explorerUrl: exec.explorerUrl };
    await settle(a, { result });
    await rememberSentRecipient(a.wallet, a.intentType, a.execution);
    return result;
  } catch (err: any) {
    await settle(a, { error: err.message });
    throw err;
  }
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
