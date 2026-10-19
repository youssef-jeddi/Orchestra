// ── Changing the limit with a wallet transaction (the older page) ──
// After the owner's transaction is mined, the server saves the new limit by the same rules as the
// Limits sheet: lowering goes straight through; raising on a wallet that has a passkey answers
// with a challenge (403 confirmation_required), which the passkey answers and the same call, with
// the same transaction, then repeats. Pure apart from the two calls passed in, so it's testable.

import { startAuthentication } from '@simplewebauthn/browser';
import { finalizeLimitUpdate } from './bridge';

export const PASSKEY_TO_RAISE = 'Raising your limit also needs your passkey. After you confirm in your wallet, I will ask for it.';

/** Is this the server asking for the passkey to finish a raise? */
export function needsPasskey(err) {
  return err?.code === 'confirmation_required' && err?.data?.method === 'passkey' && !!err?.data?.options;
}

/**
 * Finish a limit update for `txHash`. Resolves the server's answer ({ limitUsd, raised, notice? });
 * a cancelled passkey prompt rejects with the browser's error, and the caller can call again with
 * the same transaction.
 */
export async function finishLimitUpdate(newLimitUSD, ledgerAddress, txHash, { finalize = finalizeLimitUpdate, authenticate = startAuthentication } = {}) {
  try {
    return await finalize(newLimitUSD, ledgerAddress, txHash);
  } catch (err) {
    if (!needsPasskey(err)) throw err;
    const response = await authenticate({ optionsJSON: err.data.options });
    return finalize(newLimitUSD, ledgerAddress, txHash, { nonce: err.data.nonce, response });
  }
}
