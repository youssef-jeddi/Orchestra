// ── Requests past the account's on-chain daily ceiling ──
// The bridge answers such a request with code 'over_daily_cap' and, when the owner can sign it
// themselves, `ownerSign`: the server-held transaction to sign (see signing.js). Pure, so the chat
// message for a failed request is tested without a browser.

/** The chat message for a failed request: its sentence, plus the owner-sign offer if the server made one. */
export function errorMessage(err) {
  const offer = err?.code === 'over_daily_cap' ? err.data?.ownerSign : null;
  // Only an offer of the kind we know how to sign is shown as a button.
  return { role: 'agent', error: err.message, ...(offer?.kind === 'safe-owner' && offer.id && offer.typedData ? { ownerSign: offer } : {}) };
}
