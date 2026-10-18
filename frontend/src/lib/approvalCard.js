// ── What a held action's card in the /simple chat says and offers ──
// Display decisions only, in everyday words ("your account", not the Safe). The server holds the
// request and decides who may approve it; this file decides which buttons the card shows and
// never offers the personal wallet as a way to pay for something the account holds. Pure, so it's
// tested without a browser (src/approvals/approvalCard.test.ts).

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
  'To approve this, add a passkey (button at the top) or link Telegram, then ask again.';
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
