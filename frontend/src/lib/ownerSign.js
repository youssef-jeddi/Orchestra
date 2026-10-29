// ── Requests past the account's on-chain daily ceiling ──
// The bridge answers such a request with code 'over_daily_cap' and, when the owner can sign it
// themselves, `ownerSign`: the server-held transaction to sign (see signing.js). Pure, so the chat
// message for a failed request is tested without a browser.

import { checkOwnerSign, NOT_A_PAYMENT } from './ownerSignCheck';

/** The chat message for a failed request: its sentence, plus the owner-sign offer if the server made one. */
export function errorMessage(err) {
  const offer = err?.code === 'over_daily_cap' ? err.data?.ownerSign : null;
  // Only an offer of the kind we know how to sign is shown as a button.
  return { role: 'agent', error: err.message, ...(offer?.kind === 'safe-owner' && offer.id && offer.typedData ? { ownerSign: offer } : {}) };
}

/**
 * What the chat shows for an owner-sign offer, decoded here rather than taken from the bridge
 * (ORC-113): the real amount and recipient with a Sign button, or, for anything that isn't a plain
 * payment, the refusal and no button. `safeAddress` is the account this page shows; until it is
 * known there is nothing to decide yet, so no button either.
 */
export function ownerSignCard(offer, safeAddress) {
  if (!offer) return null;
  if (!safeAddress) return { canSign: false, refused: false, text: null };
  const check = checkOwnerSign(offer, { safeAddress });
  return check.ok
    ? { canSign: true, refused: false, text: `${seriesLabel(offer)}${check.text}` }
    : { canSign: false, refused: true, text: NOT_A_PAYMENT };
}

/** "Send 2 of 3: " for one send of a plan signed one at a time (ORC-21), else "". */
export function seriesLabel(offer) {
  const s = offer?.series;
  if (!s || !Number.isInteger(s.index) || !Number.isInteger(s.total) || s.total < 2 || s.index < 0 || s.index >= s.total) return '';
  return `Send ${s.index + 1} of ${s.total}: `;
}

/**
 * The chat messages after an owner-signed send went through: its receipt, then (a plan's sends are
 * signed one at a time) the next send to sign, or why it couldn't be prepared.
 */
export function afterOwnerSign(result) {
  const out = [{ role: 'system', txHash: result.txHash, explorerUrl: result.explorerUrl }];
  const next = result?.next;
  if (next?.kind === 'safe-owner' && next.id && next.typedData) {
    out.push({ role: 'agent', tone: 'info', error: 'That send went through. Sign the next one with your wallet.', ownerSign: next });
  } else if (result?.nextError) {
    out.push({ role: 'agent', error: result.nextError });
  }
  return out;
}
