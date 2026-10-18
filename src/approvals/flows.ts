// ─── Approvals — the approve / decline flows, with their effects injected ───
// The decisions a user makes on a pending approval (passkey in the app, yes/no in
// Telegram), separated from the bridge so the ordering that matters is tested without
// network: the status is checked and claimed *before* anything executes, so a
// request the user already declined (or that someone else already settled) never runs.

import { requirePending, claim, reject, getApproval, ApprovalError, type PendingApproval } from "./index";

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
  claim(a.id, wallet);
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
    if (!a || a.channel !== "telegram") return "I can't find that approval. It may have expired.";
    if (a.wallet !== wallet) return "This approval belongs to another wallet.";
    if (a.status !== "pending") {
      await deps.refresh(a);
      return `Already ${a.status}.`;
    }
    if (!approve) {
      reject(a.id, wallet);
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
    claim(a.id, wallet);
    await deps.refresh(a); // "⏳ doing it…"
    deps.execute(a).catch(() => {}).finally(() => deps.refresh(a));
    return "Approved. Doing it now…";
  };
}
