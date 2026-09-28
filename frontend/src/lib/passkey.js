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
 * Approve a server-held pending action with a passkey assertion. The server
 * executes the payload it stored for `approvalId` (the challenge commits to its
 * hash) — the browser never sends what to execute. Returns { txHash, explorerUrl }.
 */
export async function approveWithPasskey(walletAddress, approvalId) {
  const optionsJSON = await passkeyAuthOptions(walletAddress, approvalId);
  const response = await startAuthentication({ optionsJSON });
  return passkeyApprove(walletAddress, approvalId, response);
}
