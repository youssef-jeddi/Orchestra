// ── Passkey (WebAuthn) client flows ──
// Thin wrappers around @simplewebauthn/browser + the bridge endpoints. The
// browser lib handles the base64url encoding of the WebAuthn ceremony JSON.

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import {
  passkeyRegisterOptions, passkeyRegister,
  passkeyAuthOptions, passkeyApprove,
} from './bridge';

/** Register a device passkey for this wallet. Prompts the OS biometric UI. */
export async function registerPasskey(walletAddress) {
  const optionsJSON = await passkeyRegisterOptions(walletAddress);
  const response = await startRegistration({ optionsJSON });
  return passkeyRegister(walletAddress, response);
}

/**
 * Approve + execute an action with a passkey assertion. `payload` is the thing
 * to execute: { quoteData } for a swap or { sendData } for a transfer.
 * Returns { txHash, explorerUrl }.
 */
export async function approveWithPasskey(walletAddress, payload) {
  const optionsJSON = await passkeyAuthOptions(walletAddress);
  const response = await startAuthentication({ optionsJSON });
  return passkeyApprove(walletAddress, response, payload);
}
