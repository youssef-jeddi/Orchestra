// ── What a held action's card in the /simple chat says and offers ──
// Display decisions only, in everyday words ("your account", not the Safe). The server holds the
// request and decides who may approve it; this file decides which buttons the card shows and
// never offers the personal wallet as a way to pay for something the account holds. Pure, so it's
// tested without a browser (src/approvals/approvalCard.test.ts).

import { PASSKEY_MEANS } from './plainLanguage';

/** One short sentence per rule slug, shown as a tooltip on the rule chip. */
export const RULE_HINTS = {
  'daily-limit': 'This would go over the amount you let me send on my own in a day.',
  'daily-count-velocity': "I've already done as many automatic payments today as you allow.",
  'unverified-token': "This token isn't on your list of checked tokens.",
  'unknown-recipient': "You haven't sent to this address before.",
  'habit-anomaly': 'This is much bigger than the amounts you usually send.',
  'unknown-intent': "I don't recognise this kind of request.",
  malformed: "I couldn't make sense of this request.",
  denylist: 'This token is never allowed.',
  'pressure-wording': 'Your message asked me to hurry or skip my checks.',
  'unplanned-address': "Your message mentions an address that isn't part of this action.",
  'pressure-refused': 'I refused this one because the message pushed me to skip my checks.',
};

/** A slug we have no sentence for still gets a calm one, never the raw slug. */
export const ruleHint = (slug) => RULE_HINTS[slug] ?? 'An extra safety check asked for your OK.';

const DECLINE_LABELS = {
  send: "Don't send",
  swap: "Don't swap",
  add_liquidity: "Don't add",
  remove_liquidity: "Don't take out",
};

/** The decline button's text, by the kind of action. */
export const declineLabel = (intentType) => DECLINE_LABELS[intentType] ?? "Don't do it";

const NOTHING_DONE = {
  send: 'Nothing was sent.',
  swap: 'Nothing was swapped.',
  add_liquidity: 'Nothing was added.',
  remove_liquidity: 'Nothing was taken out.',
};
const nothingDone = (intentType) => NOTHING_DONE[intentType] ?? 'Nothing was done.';

/** Shown on the card after the user said no. */
export const declinedText = (intentType) => `You said no. ${nothingDone(intentType)}`;

/** Shown when the server no longer has the request (it lapsed, or the server restarted). */
export const expiredText = (intentType) => `This request expired. ${nothingDone(intentType)}`;

/** Shown when the request was settled some other way before the decline arrived. */
export const ALREADY_SETTLED = 'This request was already handled, so it can no longer be declined.';

export const NEEDS_PASSKEY_TEXT =
  `To approve this, set up a passkey: a quick way to confirm with ${PASSKEY_MEANS}. Tap “🔑 Add passkey” at the top, then ask again. Or connect Telegram and approve from your phone.`;

/**
 * The dollar value after a summary — only when the summary doesn't already show one, so a card
 * never says "(~$0.24) — $0.24". Any kind of action.
 */
export function valueSuffix(summary, valueUsd) {
  const usd = Number(valueUsd);
  if (!(usd > 0) || /\$\s?\d/.test(String(summary ?? ''))) return '';
  return ` — $${usd.toFixed(2)}`;
}
export const NOT_READY_TEXT = 'Your account is still being set up. Try again in a moment.';

/**
 * How a card that needs an OK is approved, and whether it can be declined.
 *   passkey      the server-held request, approved with a passkey
 *   telegram     the server-held request is out on Telegram (or the phone)
 *   need-passkey no passkey and not on Telegram: ask them to add one; never the personal wallet
 *   not-ready    no server-held request (the account isn't set up yet): nothing to approve or decline
 *   wallet       a deposit only: the user's own wallet funds their own account
 */
export function approvalControls({ intentType, approval, passkeyReg }) {
  if (intentType === 'deposit') return { mode: 'wallet', canDecline: false };
  if (!approval?.id) return { mode: 'not-ready', canDecline: false, text: NOT_READY_TEXT };
  if (approval.channel === 'telegram') return { mode: 'telegram', canDecline: true };
  if (passkeyReg) return { mode: 'passkey', canDecline: true };
  return { mode: 'need-passkey', canDecline: true, text: NEEDS_PASSKEY_TEXT };
}

// ── The card's life after the user acts ──
// A held card moves from open to approving to done / failed (or ends because the user said no or
// it lapsed). A settled card has no buttons and says what happened; while the passkey approval is
// running the decline button is disabled so the two can't race (the server refuses either way).

export const DONE_TEXT = 'Done.';
const failedText = (message) => `It didn't go through: ${message || 'something went wrong'}`;

/** The outcome stored on a card after a passkey approval went through. */
export const doneOutcome = (result) => ({ status: 'done', txHash: result?.txHash, explorerUrl: result?.explorerUrl });

/**
 * The outcome to settle the card with after the approval call failed, from the approval's state on
 * the server (null if it is still waiting, e.g. the passkey prompt was cancelled or didn't verify:
 * the card stays open so they can try again).
 */
export function outcomeAfterError(err, approval, intentType) {
  switch (approval?.status) {
    case 'executed': return doneOutcome(approval);
    case 'failed': return { status: 'failed', text: failedText(approval.error || err?.message) };
    case 'rejected': return { status: 'ended', kind: 'declined', text: declinedText(intentType) };
    case 'expired': return { status: 'ended', kind: 'expired', text: expiredText(intentType) };
    default: return null;
  }
}

const NOT_DONE_PILL = {
  send: 'Not sent',
  swap: 'Not swapped',
  add_liquidity: 'Not added',
  remove_liquidity: 'Not taken out',
};

/**
 * The single calm pill a settled card shows instead of the "Needs your OK" verdict and its rule
 * chips (which no longer apply): Done, Not sent / Not swapped…, Expired, Didn't go through.
 * Null while the card is still open.
 */
export function settledPill({ outcome, ended, intentType }) {
  if (outcome?.status === 'done') return { label: 'Done', tone: 'good' };
  if (outcome?.status === 'failed') return { label: "Didn't go through", tone: 'bad' };
  const end = outcome?.status === 'ended' ? outcome : ended && !ended.retry ? ended : null;
  if (!end) return null;
  if (end.kind === 'expired') return { label: 'Expired', tone: 'calm' };
  if (end.kind === 'declined') return { label: NOT_DONE_PILL[intentType] ?? 'Not done', tone: 'calm' };
  return { label: 'Already handled', tone: 'calm' };
}

/**
 * What a held card shows now.
 *   line / receiptUrl   the sentence that replaces the buttons once it is settled
 *   pill / showChips    the settled pill (replacing the verdict) and whether the rule chips stay
 *   showApprove / showDecline   which buttons are there
 *   approveDisabled / declineDisabled   greyed out while something is in flight
 */
export function cardView({ outcome, ended, signing, declining, settledElsewhere, intentType }) {
  const pill = settledPill({ outcome, ended, intentType });
  if (outcome?.status === 'done') return { settled: true, pill, showChips: false, line: DONE_TEXT, receiptUrl: outcome.explorerUrl, showApprove: false, showDecline: false };
  if (outcome?.status === 'failed' || outcome?.status === 'ended') return { settled: true, pill, showChips: false, line: outcome.text, showApprove: false, showDecline: false };
  if (ended && !ended.retry) return { settled: true, pill, showChips: false, line: ended.text, showApprove: false, showDecline: false };
  return {
    settled: false,
    pill: null,
    showChips: true,
    showApprove: true,
    showDecline: !settledElsewhere,
    approveDisabled: !!signing || !!declining,
    declineDisabled: !!signing || !!declining,
  };
}
