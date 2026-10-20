// ── "Add passkey" failures, in plain words ──
// Adding a passkey can fail in the browser (the prompt was closed, timed out, or this device can't
// make one) or on our server (getting the options, or saving the new passkey). Every "Add passkey"
// button on /simple shows one of these sentences and goes back to its normal state.
// Pure, so it's tested without a browser (src/integrations/passkey/passkeyErrors.test.ts).

export const PASSKEY_ADD_MESSAGES = {
  cancelled: "The passkey wasn't added because the prompt was closed or timed out. You can try again whenever you're ready.",
  unsupported: "The passkey wasn't added: this device or browser can't create one. Try again on a phone or computer with Face ID, a fingerprint or a screen lock.",
  alreadyAdded: "This device already has a passkey for your account, so there's nothing to add.",
  wrongSite: "The passkey wasn't added: passkeys can't be created on this web address. Open Orchestra from its usual address and try again.",
  failed: "We couldn't add the passkey. Please try again.",
  signedOut: "You've been signed out, so the passkey wasn't added. Sign in again, then add it.",
};

// Hard limits, so an "Add passkey" button can never stay stuck: each passkey prompt (the browser
// may never open it, or never answer) and each call to our server.
export const PASSKEY_CEREMONY_TIMEOUT_MS = 60_000;
export const PASSKEY_FETCH_TIMEOUT_MS = 15_000;

/**
 * Resolves or rejects like `promise`, but rejects with a TimeoutError after `ms` if it hasn't
 * settled, calling `onTimeout` first (e.g. to abort the browser's prompt).
 */
export function withDeadline(promise, ms, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* aborting is best effort */ }
      const err = new Error('The passkey prompt timed out');
      err.name = 'TimeoutError';
      err.passkeyTimedOut = true;
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

/** Button text while the passkey prompt is open, the same on every "Add passkey" button. */
export const PASSKEY_ADDING_LABEL = 'Follow the prompt on your device…';

/** What an "Add passkey" button shows: disabled with the waiting text while a passkey is being added. */
export function addPasskeyButton(adding, idleLabel = '🔑 Add passkey') {
  return adding ? { label: PASSKEY_ADDING_LABEL, disabled: true } : { label: idleLabel, disabled: false };
}

// Thrown by @simplewebauthn/browser when the browser has no WebAuthn at all.
const NO_WEBAUTHN = /webauthn is not supported/i;

/** Does this browser have WebAuthn at all? `g` is injected for tests. */
export function browserCanUsePasskeys(g = globalThis) {
  return typeof g?.PublicKeyCredential === 'function';
}

/**
 * Can this device make a passkey by itself (Face ID, fingerprint, Windows Hello…)? Resolves to
 * true, false, or null when the browser can't tell. Never throws.
 */
export async function devicePasskeyAvailable(g = globalThis) {
  if (!browserCanUsePasskeys(g)) return false;
  try {
    const check = g.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof check !== 'function') return null;
    return !!(await check.call(g.PublicKeyCredential));
  } catch {
    return null;
  }
}

/** Thrown before anything is asked of the server when the browser has no WebAuthn. */
export function noWebAuthnError() {
  const err = new Error('WebAuthn is not supported in this browser');
  err.name = 'NotSupportedError';
  err.passkeyUnsupported = true;
  return err;
}

/**
 * Which kind of failure this was: 'cancelled' | 'unsupported' | 'alreadyAdded' | 'wrongSite' | 'signedOut' | 'failed'.
 * `deviceAvailable` is devicePasskeyAvailable()'s answer: Chrome reports both "the user closed the
 * prompt" and "there's nothing here to make a passkey with" as NotAllowedError, so a device that
 * has no built-in passkey support is read as "can't create one".
 */
export function passkeyAddFailure(err, { deviceAvailable = null } = {}) {
  if (!err) return 'failed';
  // The session is gone (e.g. the server restarted): the page shows "Sign in" again.
  if (err.code === 'session_required') return 'signedOut';
  // An answer from our server (it has an HTTP status), no answer in time, or the network: say it
  // plainly, never the raw text.
  if (err.status || err.network) return 'failed';
  // Our own limit on the prompt fired (it never opened, or never answered).
  if (err.passkeyTimedOut) return 'cancelled';
  if (err.passkeyUnsupported || NO_WEBAUTHN.test(err.message || '')) return 'unsupported';
  const code = err.code || '';
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || err.name === 'InvalidStateError') return 'alreadyAdded';
  if (code === 'ERROR_INVALID_DOMAIN' || code === 'ERROR_INVALID_RP_ID' || err.name === 'SecurityError') return 'wrongSite';
  if (code.startsWith('ERROR_AUTHENTICATOR_') || err.name === 'NotSupportedError' || err.name === 'ConstraintError') return 'unsupported';
  if (err.name === 'NotAllowedError' || err.name === 'AbortError' || err.name === 'TimeoutError') {
    return deviceAvailable === false ? 'unsupported' : 'cancelled';
  }
  return 'failed';
}

/** The sentence to show for a failed "Add passkey". */
export function passkeyAddError(err, opts) {
  return PASSKEY_ADD_MESSAGES[passkeyAddFailure(err, opts)];
}

/** Works out the sentence, checking the device only when the browser's answer is ambiguous. */
export async function explainPasskeyAddError(err, g = globalThis) {
  const ambiguous = !err?.status && !err?.network && !err?.passkeyTimedOut && ['NotAllowedError', 'AbortError', 'TimeoutError'].includes(err?.name);
  const deviceAvailable = ambiguous ? await devicePasskeyAvailable(g) : null;
  return passkeyAddError(err, { deviceAvailable });
}
