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
    ? { canSign: true, refused: false, text: check.text }
    : { canSign: false, refused: true, text: NOT_A_PAYMENT };
}
