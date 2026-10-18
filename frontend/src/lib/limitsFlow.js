// ── Saving a limit change from the Limits sheet ──
// Lowering a limit or removing an address goes straight through with the session. Raising one
// first asks the server for a challenge bound to the exact new values, answers it with the
// user's passkey (or a wallet signature when they have no passkey), and sends that proof along.
// Cancelling either prompt changes nothing.

import { startAuthentication } from '@simplewebauthn/browser';
import { limitsConfirmOptions, saveLimitChange } from './bridge';
import { isCancel } from './limits';

async function walletSignature(ledger, typedData) {
  const sig = await ledger.signTyped(typedData);
  const { ethers } = await import('ethers');
  // Ledger returns {v,r,s}; MetaMask returns a serialized hex string.
  return typeof sig === 'string' ? sig : ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized;
}

/**
 * Save `change` ({ policy?, removeAddress? }). `onConfirming(method)` is called when proof is needed.
 * Resolves { saved: true, limits } or { saved: false, cancelled: true } if the user backed out.
 */
export async function saveLimits(ledger, change, onConfirming) {
  try {
    const ask = await limitsConfirmOptions(change);
    if (!ask.required) return { saved: true, limits: await saveLimitChange(change) };
    onConfirming?.(ask.method);
    const confirmation = ask.method === 'passkey'
      ? { nonce: ask.nonce, response: await startAuthentication({ optionsJSON: ask.options }) }
      : { nonce: ask.nonce, signature: await walletSignature(ledger, ask.typedData) };
    return { saved: true, limits: await saveLimitChange({ ...change, confirmation }) };
  } catch (err) {
    if (isCancel(err)) return { saved: false, cancelled: true };
    throw err;
  }
}
