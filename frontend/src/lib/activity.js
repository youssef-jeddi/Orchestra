// ── The "Recent activity" list on /simple ──
// What the bridge's GET /activity returns (this wallet's recent spends), turned into plain-language
// rows. Pure, so the wording is tested without a browser (src/policy/simpleUi.test.ts).
// Deposits aren't listed: they're sent from the user's own wallet and no server path records them.

import { formatUsd } from './money.js';

export const ACTIVITY_EMPTY = 'No activity yet.';
export const EXPIRED_OWNER_SIGN = 'That request expired. Ask me again, or try again after the daily reset.';

/** Who or what allowed this to go through, in words for a newcomer. */
export function sourceLabel(source) {
  if (source === 'auto') return 'Sent automatically';
  if (source === 'approved') return 'You approved';
  if (source === 'owner') return 'You signed';
  return 'Sent';
}

const shortAddr = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** One row of the list: everything already formatted, nothing left to decide in the component. */
export function activityRow(rec) {
  const when = new Date(rec.at);
  // Tokens come as a symbol or, for some sends, a contract address: only a symbol reads well.
  const token = typeof rec.token === 'string' && !rec.token.startsWith('0x') ? rec.token : null;
  const usd = Number.isFinite(rec.valueUsd) ? `~${formatUsd(rec.valueUsd)}` : '';
  return {
    key: rec.txHash || `${rec.at}-${rec.to || ''}-${rec.valueUsd}`,
    when: Number.isNaN(when.getTime()) ? '' : when.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    amount: [token, usd].filter(Boolean).join(' '),
    to: rec.to ? shortAddr(rec.to) : '',
    source: sourceLabel(rec.source),
    receiptUrl: rec.explorerUrl || (rec.txHash ? `https://sepolia.etherscan.io/tx/${rec.txHash}` : null),
  };
}

/** The `?ownerSign=<id>` value from a page's query string, or null. */
export function ownerSignIdFromSearch(search) {
  const id = new URLSearchParams(search || '').get('ownerSign');
  return id && /^[0-9a-fA-F-]{8,64}$/.test(id) ? id : null;
}
