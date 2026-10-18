// ── When the account balance at the top should be re-read ──
// The header balance is only fetched when the account is set up, so after anything that moves money
// out of the account it would stay stale until a reload. Pure, so it's tested without a browser
// (src/approvals/approvalCard.test.ts).

const MOVES_FUNDS = new Set(['send', 'swap', 'add_liquidity', 'remove_liquidity']);

/** An /intent answer that already went through on its own (auto-executed) and changed the balance. */
export const shouldRefreshBalances = (data) => !!data?.autoExecuted && !!data.txHash && MOVES_FUNDS.has(data.intentType);

/** A held approval's state once it has been carried out (passkey, Telegram button or phone). */
export const approvalMovedFunds = (approval) => approval?.status === 'executed' && MOVES_FUNDS.has(approval.intentType);

/** The chain needs a moment after the transaction is sent, so read again a few seconds later too. */
export const REFRESH_AGAIN_MS = 4000;

/** Refresh now and once more shortly after. `timer` is injectable for tests. */
export function refreshSoon(refresh, timer = setTimeout) {
  refresh();
  return timer(refresh, REFRESH_AGAIN_MS);
}
