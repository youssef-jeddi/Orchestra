// ─── Bridge HTTP + WebSocket helpers ───
// All communication with the backend bridge server

import { PASSKEY_FETCH_TIMEOUT_MS } from './passkeyErrors';

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

/** The current session token, for the WebSocket's first message (never put it in the URL). */
export function getSessionToken() {
  return sessionToken;
}

/** Subscribe to "the server rejected our session". Returns an unsubscribe function. */
export function onSessionInvalid(fn) {
  sessionInvalidListeners.add(fn);
  return () => sessionInvalidListeners.delete(fn);
}

/** Thrown when the bridge doesn't answer within `timeoutMs`: a network problem, not the user's doing. */
function bridgeTimeoutError() {
  const err = new Error('The server took too long to answer');
  err.name = 'BridgeTimeoutError';
  err.network = true;
  return err;
}

export async function bridgeFetch(path, options = {}) {
  const { timeoutMs, ...init } = options;
  // Optional hard limit: abort the request (and reading its answer) after `timeoutMs`.
  // The race also covers a request that ignores the abort.
  const controller = timeoutMs ? new AbortController() : null;
  let timer = null;
  const timedOut = controller && new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(bridgeTimeoutError()); }, timeoutMs);
  });
  const request = (async () => {
    const r = await fetch(`${BRIDGE_HTTP}${path}`, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        ...init.headers,
      },
    });
    return [r, await r.json()];
  })();
  let res, data;
  try {
    [res, data] = await (timedOut ? Promise.race([request, timedOut]) : request);
  } catch (err) {
    if (controller?.signal.aborted) throw bridgeTimeoutError();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401 && data.code === 'session_required') {
      sessionToken = null;
      sessionInvalidListeners.forEach((fn) => fn());
    }
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code; // e.g. 'session_required', so callers can sign in and retry
    err.data = data; // the whole answer, e.g. the passkey challenge of a 'confirmation_required'
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

// An email user's fresh email code, as Privy's new identity token: the server keeps it as the
// single-use proof for their first passkey (and decides if it's fresh enough).
export async function emailVerify(identityToken) {
  return bridgeFetch('/passkey/email-verify', { method: 'POST', body: JSON.stringify({ identityToken }) });
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

/** `confirmation` ({ nonce, response }) answers the passkey challenge of a raise; see finishLimitUpdate. */
export async function finalizeLimitUpdate(newLimitUSD, ledgerAddress, txHash, confirmation) {
  return bridgeFetch('/finalize-limit-update', {
    method: 'POST',
    body: JSON.stringify({ newLimitUSD, ledgerAddress, txHash, ...(confirmation ? { confirmation } : {}) }),
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

/**
 * Step 1 of raising a limit: { required: false } if the change can go straight through, or the
 * passkey options / wallet typed data to answer (the change is the same body POST /policy takes).
 */
export async function limitsConfirmOptions(change) {
  return bridgeFetch('/policy/confirm-options', { method: 'POST', body: JSON.stringify(change) });
}

/** Save a limit change ({ policy?, removeAddress?, confirmation? }). Resolves with the saved limits. */
export async function saveLimitChange(change) {
  return bridgeFetch('/policy', { method: 'POST', body: JSON.stringify(change) });
}

/** Whether automatic actions are paused: { wallet, global, unreadable, other } (ORC-39). */
export async function getPauseStatus() {
  return bridgeFetch('/pause');
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

// Adding a passkey never waits on the server for long (the button would look stuck): PASSKEY_FETCH_TIMEOUT_MS.

/** A check with the wallet's existing passkey ({ required, options }), needed to add another. */
export async function passkeyConfirmOptions() {
  return bridgeFetch('/passkey/confirm-options', { method: 'POST', body: '{}', timeoutMs: PASSKEY_FETCH_TIMEOUT_MS });
}

export async function passkeyRegisterOptions(walletAddress, assertion) {
  return bridgeFetch('/passkey/register-options', {
    method: 'POST', body: JSON.stringify({ walletAddress, assertion }), timeoutMs: PASSKEY_FETCH_TIMEOUT_MS,
  });
}

export async function passkeyRegister(walletAddress, response) {
  return bridgeFetch('/passkey/register', {
    method: 'POST', body: JSON.stringify({ walletAddress, response }), timeoutMs: PASSKEY_FETCH_TIMEOUT_MS,
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

/**
 * Send the owner's signature for a request held past the on-chain daily ceiling. Only the id and
 * the signature go: the server relays the transaction it holds, never one from here.
 */
export async function submitOwnerSignature(id, signature) {
  return bridgeFetch(`/owner-sign/${encodeURIComponent(id)}/submit`, { method: 'POST', body: JSON.stringify({ signature }) });
}

/** A pending owner-sign request again (the Telegram link opens the app with its id). 404 = gone or expired. */
export async function getOwnerSign(id) {
  return bridgeFetch(`/owner-sign/${encodeURIComponent(id)}`);
}

/** This wallet's recent spends, newest first: `{ activity: [...] }`. */
export async function getActivity() {
  return bridgeFetch('/activity');
}

// ── Server-held approvals ──

export async function getApproval(approvalId) {
  return bridgeFetch(`/approvals/${approvalId}`);
}

/** Say no to one of your own pending approvals (final). Resolves with its new state; 404 = expired, 409 = already settled. */
export async function rejectApproval(approvalId) {
  return bridgeFetch(`/approvals/${encodeURIComponent(approvalId)}/reject`, { method: 'POST', body: '{}' });
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
