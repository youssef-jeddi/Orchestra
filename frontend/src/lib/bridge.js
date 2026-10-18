// ─── Bridge HTTP + WebSocket helpers ───
// All communication with the backend bridge server

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
export const BRIDGE_HTTP = API_URL;
export const BRIDGE_WS = API_URL.replace(/^http/, 'ws') + '/ws';

// ── Wallet session ──
// Set by useSession after the wallet signs in; sent on every request so the
// server can act for that wallet. A 401 `session_required` clears it.
let sessionToken = null;
const sessionInvalidListeners = new Set();

export function setSessionToken(token) {
  sessionToken = token || null;
}

/** Subscribe to "the server rejected our session". Returns an unsubscribe function. */
export function onSessionInvalid(fn) {
  sessionInvalidListeners.add(fn);
  return () => sessionInvalidListeners.delete(fn);
}

export async function bridgeFetch(path, options = {}) {
  const res = await fetch(`${BRIDGE_HTTP}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && data.code === 'session_required') {
      sessionToken = null;
      sessionInvalidListeners.forEach((fn) => fn());
    }
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.code = data.code; // e.g. 'session_required', so callers can sign in and retry
    throw err;
  }
  return data;
}

export async function authLoginRequest(walletAddress) {
  return bridgeFetch('/auth/login-request', { method: 'POST', body: JSON.stringify({ walletAddress }) });
}

export async function authLogin(walletAddress, nonce, signature) {
  return bridgeFetch('/auth/login', { method: 'POST', body: JSON.stringify({ walletAddress, nonce, signature }) });
}

// Privy sign-in: the identity token proves the wallet is the user's, no signature needed.
export async function authPrivy(walletAddress, identityToken) {
  return bridgeFetch('/auth/privy', { method: 'POST', body: JSON.stringify({ walletAddress, identityToken }) });
}

export async function getSession() {
  return bridgeFetch('/auth/session');
}

// ── Specific API calls ──

export async function sendIntent(message, walletAddress, options = {}) {
  return bridgeFetch('/intent', {
    method: 'POST',
    body: JSON.stringify({ message, walletAddress, ...options }),
  });
}

export async function getQuote(walletAddress, amount) {
  return bridgeFetch('/quote', {
    method: 'POST',
    body: JSON.stringify({ walletAddress, amount }),
  });
}

export async function submitSwap(quote, permitData, signature, routing) {
  return bridgeFetch('/swap', {
    method: 'POST',
    body: JSON.stringify({ quote, permitData, signature, routing }),
  });
}

export async function broadcast(signedTx) {
  return bridgeFetch('/broadcast', {
    method: 'POST',
    body: JSON.stringify({ signedTx }),
  });
}

export async function getNonce(address) {
  return bridgeFetch(`/nonce/${address}`);
}

export async function checkSafe(address) {
  return bridgeFetch(`/check-safe?address=${address}`);
}

/** Starts (or joins) the signed-in wallet's account setup; the server decides every value. */
export async function startOnboarding() {
  return bridgeFetch('/onboard', { method: 'POST', body: JSON.stringify({}) });
}

export async function getOnboardingStatus() {
  return bridgeFetch('/onboard/status');
}

export async function getSafeBalances(address) {
  return bridgeFetch(`/safe-balances?address=${address}`);
}

export async function prepareLimitUpdate(newLimitUSD, ledgerAddress) {
  return bridgeFetch('/prepare-limit-update', {
    method: 'POST',
    body: JSON.stringify({ newLimitUSD, ledgerAddress }),
  });
}

export async function finalizeLimitUpdate(newLimitUSD, ledgerAddress, txHash) {
  return bridgeFetch('/finalize-limit-update', {
    method: 'POST',
    body: JSON.stringify({ newLimitUSD, ledgerAddress, txHash }),
  });
}

export async function triggerMockTrade() {
  return bridgeFetch('/mock-trade', {
    method: 'POST',
    body: JSON.stringify({
      summary: 'Swap 0.5 ETH -> ~1,247 USDC via Uniswap V3',
      riskLevel: 'requires_approval',
    }),
  });
}

export async function setComputeProvider(provider) {
  return bridgeFetch('/set-compute-provider', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export async function getComputeProvider() {
  return bridgeFetch('/compute-provider');
}

// ── Policy config + learned habit profile ──

export async function getPolicy() {
  return bridgeFetch('/policy');
}

// patch: { dailyLimitUsd, maxAutoTxPerDay, typicalMaxUsd, ... }; null clears a field.
export async function setPolicy(policy) {
  return bridgeFetch('/policy', {
    method: 'POST',
    body: JSON.stringify({ policy }),
  });
}

export async function getHabit(walletAddress) {
  return bridgeFetch(`/habit?wallet=${walletAddress}`);
}

export async function getPrices() {
  return bridgeFetch('/prices');
}

// ── Passkey (WebAuthn) ──

export async function getPasskeyStatus(walletAddress) {
  return bridgeFetch(`/passkey/status?wallet=${walletAddress}`);
}

/** A check with the wallet's existing passkey ({ required, options }), needed to add another. */
export async function passkeyConfirmOptions() {
  return bridgeFetch('/passkey/confirm-options', { method: 'POST', body: '{}' });
}

export async function passkeyRegisterOptions(walletAddress, assertion) {
  return bridgeFetch('/passkey/register-options', {
    method: 'POST', body: JSON.stringify({ walletAddress, assertion }),
  });
}

export async function passkeyRegister(walletAddress, response) {
  return bridgeFetch('/passkey/register', {
    method: 'POST', body: JSON.stringify({ walletAddress, response }),
  });
}

/** The account's passkeys (no keys): { passkeys: [{ id, rpID, label, source, createdAt }] }. */
export async function listPasskeys() {
  return bridgeFetch('/passkey/list');
}

/** Remove a passkey; `assertion` is the check with an existing passkey. */
export async function passkeyRemove(id, assertion) {
  return bridgeFetch('/passkey/remove', { method: 'POST', body: JSON.stringify({ id, assertion }) });
}

export async function passkeyAuthOptions(walletAddress, approvalId) {
  return bridgeFetch('/passkey/auth-options', {
    method: 'POST', body: JSON.stringify({ walletAddress, approvalId }),
  });
}

export async function passkeyApprove(walletAddress, approvalId, response) {
  return bridgeFetch('/passkey/approve', {
    method: 'POST', body: JSON.stringify({ walletAddress, approvalId, response }),
  });
}

// ── Server-held approvals ──

export async function getApproval(approvalId) {
  return bridgeFetch(`/approvals/${approvalId}`);
}

// ── Telegram approvals ──

export async function getTelegramStatus(walletAddress) {
  return bridgeFetch(`/telegram/status?wallet=${walletAddress}`);
}

export async function telegramLinkRequest(walletAddress) {
  return bridgeFetch('/telegram/link-request', {
    method: 'POST', body: JSON.stringify({ walletAddress }),
  });
}

/**
 * Send a one-time phone passkey setup link to the linked Telegram (needs a
 * session, and `assertion` from an existing passkey once the wallet has one).
 */
export async function requestPhoneSetup(assertion) {
  return bridgeFetch('/passkey/phone-setup', { method: 'POST', body: JSON.stringify({ assertion }) });
}

export async function telegramLink(walletAddress, code, signature) {
  return bridgeFetch('/telegram/link', {
    method: 'POST', body: JSON.stringify({ walletAddress, code, signature }),
  });
}
