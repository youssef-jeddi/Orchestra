// ── The Limits sheet on /simple: wording and form logic ──
// What a beginner sees when they look at or change how much the agent may do on its own, in
// everyday words. The server validates every value and decides whether a change needs proof
// (src/policy/limits.ts); this file only turns the form into the changes to send, and the answers
// into sentences. Pure, so it's tested without a browser (src/policy/limitsSheet.test.ts).

import { formatUsd } from './money';

export const MAX_DAILY = 1000;
export const MAX_COUNT = 100;
export const DEFAULT_DAILY = 100;

export const LIMITS_TEXT = {
  title: 'Your limits',
  intro: "Small payments I can make on my own. Anything above these limits waits for your OK.",
  daily: 'Send up to $ a day without asking me',
  dailyHint: 'Type 0 and I will always ask you first.',
  count: 'Ask me after this many automatic payments a day',
  countHint: 'Leave empty for no limit on how many.',
  addresses: "Addresses you've sent to",
  noAddresses: "None yet. I'll ask you the first time you send to a new address.",
  removeHint: "Remove an address and I'll ask you again before the next send to it.",
  save: 'Save',
  saved: 'Saved.',
  cancelled: 'Nothing was changed.',
  noChange: 'Nothing to save.',
};

/** The sheet's button in the header. */
export const LIMITS_BUTTON_HINT = 'See and change how much I can do without asking you';

/** One plain line on what the agent has learned about usual amounts (from /habit), no jargon. */
export function habitLine(habit) {
  if (!habit || !habit.typicalMaxUsd) return "I'm still learning what you usually send.";
  return `You usually send around ${formatUsd(habit.typicalMaxUsd)}, so I'll ask before anything much bigger.`;
}

/** What to say while the proof for raising a limit is being collected. */
export function confirmingText(method) {
  return method === 'wallet'
    ? 'Raising a limit needs your OK. Check your wallet to sign.'
    : 'Raising a limit needs your OK. Confirm with your passkey.';
}

/** Cancelling the passkey or wallet prompt changes nothing. */
export function isCancel(err) {
  return err?.name === 'NotAllowedError' || err?.name === 'AbortError' || err?.code === 4001 || err?.code === 'ACTION_REJECTED'
    || /user (rejected|denied|cancel)/i.test(String(err?.message || ''));
}

const asText = (v) => (v == null ? '' : String(v));

/** The form's starting values from the server's policy. */
export function formFrom(policy) {
  return { daily: asText(policy?.dailyLimitUsd ?? DEFAULT_DAILY), count: asText(policy?.maxAutoTxPerDay) };
}

/**
 * Turn the form into the changes to send: only fields that differ from what's stored, so an
 * untouched limit is never re-sent. Returns { error } for a bad entry, or { policy } (maybe empty).
 */
export function changesFrom(form, policy) {
  const out = {};
  const daily = String(form.daily ?? '').trim();
  if (daily === '' || !/^\d+(\.\d{1,2})?$/.test(daily) || Number(daily) > MAX_DAILY) {
    return { error: `Enter an amount from $0 to ${formatUsd(MAX_DAILY)}.` };
  }
  if (Number(daily) !== (policy?.dailyLimitUsd ?? DEFAULT_DAILY)) out.dailyLimitUsd = Number(daily);

  const count = String(form.count ?? '').trim();
  if (count === '') {
    if (policy?.maxAutoTxPerDay != null) out.maxAutoTxPerDay = null;
  } else {
    if (!/^\d+$/.test(count) || Number(count) > MAX_COUNT) return { error: `Enter a whole number from 0 to ${MAX_COUNT}, or leave it empty.` };
    if (Number(count) !== policy?.maxAutoTxPerDay) out.maxAutoTxPerDay = Number(count);
  }
  return { policy: out };
}
