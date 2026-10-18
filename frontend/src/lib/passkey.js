// ── Passkey (WebAuthn) client flows ──
// Thin wrappers around @simplewebauthn/browser + the bridge endpoints. The
// browser lib handles the base64url encoding of the WebAuthn ceremony JSON.

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import {
  passkeyConfirmOptions, passkeyRegisterOptions, passkeyRegister,
  passkeyAuthOptions, passkeyApprove, requestPhoneSetup, passkeyRemove,
} from './bridge';

/**
 * Adding a passkey to a wallet that already has one takes that passkey first:
 * returns its assertion, or null when the wallet has none yet.
 */
async function confirmExistingPasskey() {
  const { required, options } = await passkeyConfirmOptions();
  if (!required) return null;
  return startAuthentication({ optionsJSON: options });
}

/** Register a device passkey for this wallet. Prompts the OS biometric UI (twice if it already has one). */
export async function registerPasskey(walletAddress) {
  const assertion = await confirmExistingPasskey();
  const optionsJSON = await passkeyRegisterOptions(walletAddress, assertion);
  const response = await startRegistration({ optionsJSON });
  return passkeyRegister(walletAddress, response);
}

/** Remove one of the account's passkeys, confirming with an existing one. Returns the updated list. */
export async function removePasskey(id) {
  return passkeyRemove(id, await confirmExistingPasskey());
}

/** Ask for a phone passkey setup link on Telegram, confirming with the existing passkey if there is one. */
export async function setUpPhonePasskey() {
  return requestPhoneSetup(await confirmExistingPasskey());
}

/**
 * Approve a server-held pending action with a passkey assertion. The server
 * executes the payload it stored for `approvalId` (the challenge commits to its
 * hash) — the browser never sends what to execute. Returns { txHash, explorerUrl }.
 */
export async function approveWithPasskey(walletAddress, approvalId) {
  const optionsJSON = await passkeyAuthOptions(walletAddress, approvalId);
  const response = await startAuthentication({ optionsJSON });
  return passkeyApprove(walletAddress, approvalId, response);
}
