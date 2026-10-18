// ─── Safe — verify a spending-limit update on-chain ───
// /finalize-limit-update must only record a new limit once the chain shows the
// owner actually executed it: the tx exists, succeeded, was sent by the owner
// (the Safe accepts the pre-approved v=1 signature only from msg.sender = owner)
// to their Safe, with exactly the calldata /prepare-limit-update built for that
// limit. Pure, so it's testable without a node.

export interface LimitTxInput {
  tx: { from: string; to: string | null; data: string } | null;
  receipt: { status: number | null } | null;
  wallet: string;
  safeAddress: string;
  expectedData: string;
}

/** Why the tx doesn't prove the limit update, or null if it does. */
export function limitTxProblem({ tx, receipt, wallet, safeAddress, expectedData }: LimitTxInput): string | null {
  if (!tx || !receipt) return "the transaction isn't mined yet (or doesn't exist). Try again once it's confirmed.";
  if (receipt.status !== 1) return "the transaction reverted.";
  if (tx.from.toLowerCase() !== wallet.toLowerCase()) return "it wasn't sent by your wallet.";
  if (!tx.to || tx.to.toLowerCase() !== safeAddress.toLowerCase()) return "it wasn't sent to your Safe.";
  if (tx.data.toLowerCase() !== expectedData.toLowerCase()) return "it doesn't set the requested limit.";
  return null;
}
