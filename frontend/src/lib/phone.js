import { useSyncExternalStore } from 'react';

// ── Phone approval pages: bridge calls ──
// Same-origin through the /bridge rewrite (next.config.mjs): the phone only
// needs to reach the public frontend. No wallet session here — these endpoints
// are authorized by the one-time secrets in the links sent to Telegram.

async function phonePost(path, body) {
  const res = await fetch(`/bridge${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const phoneSetupOptions = (token) => phonePost('/phone/setup/options', { token });
export const phoneSetupVerify = (token, response) => phonePost('/phone/setup/verify', { token, response });

export const reviewApproval = (id, t) => phonePost(`/phone/approvals/${encodeURIComponent(id)}/review`, { t });
export const approvalPasskeyOptions = (id, t) => phonePost(`/phone/approvals/${encodeURIComponent(id)}/options`, { t });
export const approveOnPhone = (id, t, response) => phonePost(`/phone/approvals/${encodeURIComponent(id)}/approve`, { t, response });
export const rejectOnPhone = (id, t) => phonePost(`/phone/approvals/${encodeURIComponent(id)}/reject`, { t });

// ── Passkey troubleshooting ──
// In-app browsers (Telegram's, and most apps' WebViews) don't support passkeys:
// the request is refused before any prompt shows. Telegram's Android WebView
// says "Telegram" in its user agent; iOS WebViews drop the "Safari" token.
export function inAppBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/Telegram|FBAN|FBAV|Instagram|Line\//i.test(ua)) return true;
  if (/Android/i.test(ua) && /; wv\)/.test(ua)) return true;
  return /iPhone|iPad|iPod/i.test(ua) && !/Safari\//.test(ua);
}

export function passkeysSupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

// Server render: assume a capable browser; the client snapshot corrects it after
// hydration without a mismatch.
const SERVER_ENV = Object.freeze({ inApp: false, supported: true });
let clientEnv = null;
const noSubscribe = () => () => {};
function envSnapshot() {
  clientEnv ??= Object.freeze({ inApp: inAppBrowser(), supported: passkeysSupported() });
  return clientEnv;
}

/** { inApp, supported } for this browser, hydration-safe. */
export function useBrowserEnv() {
  return useSyncExternalStore(noSubscribe, envSnapshot, () => SERVER_ENV);
}

export const OPEN_IN_BROWSER =
  'Passkeys don’t work inside Telegram’s built-in browser. Tap ⋯ (top right) → “Open in Safari” / “Open in Chrome”, then try again.';

/** A readable message for a failed WebAuthn call (NotAllowedError covers cancel, timeout and blocked). */
export function passkeyErrorMessage(err, what) {
  if (err?.name === 'NotAllowedError') {
    return inAppBrowser()
      ? OPEN_IN_BROWSER
      : `The ${what} was cancelled, timed out or blocked by the browser. Try again, and make sure passkeys are enabled on this phone (iCloud Keychain or Google Password Manager).`;
  }
  if (err?.name === 'InvalidStateError') return 'A passkey for this wallet already exists on this phone.';
  if (err?.name === 'SecurityError') return 'The browser refused this address for passkeys. Open the link exactly as sent, over https.';
  return err?.message || String(err);
}

// Shared look for the phone pages (dark, like /simple, sized for a phone screen).
export const phoneStyles = {
  page: {
    cursor: 'auto', minHeight: '100dvh', maxWidth: 480, margin: '0 auto', padding: '24px 16px 40px',
    fontFamily: 'var(--font-inter)', color: '#E8E4DE', display: 'flex', flexDirection: 'column', gap: 16,
  },
  brand: { fontFamily: 'var(--font-playfair)', fontSize: 20 },
  card: { background: '#141418', border: '1px solid #222228', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  muted: { fontSize: 13, color: '#999', lineHeight: 1.5, margin: 0 },
  primary: (busy) => ({
    padding: '14px 16px', borderRadius: 12, border: 'none', cursor: busy ? 'default' : 'pointer',
    background: busy ? '#6b4d8f' : '#C084FC', color: '#0F0F12', fontSize: 16, fontWeight: 600,
    fontFamily: 'var(--font-inter)', opacity: busy ? 0.8 : 1,
  }),
  secondary: {
    padding: '12px 16px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.15)', cursor: 'pointer',
    background: 'transparent', color: '#E8E4DE', fontSize: 15, fontFamily: 'var(--font-inter)',
  },
  error: { color: '#FF453A', fontSize: 14, border: '1px solid #FF453A44', borderRadius: 12, padding: '10px 14px', background: '#FF453A11', margin: 0 },
  ok: { color: '#30D158', fontSize: 15, border: '1px solid #30D15844', borderRadius: 12, padding: '12px 14px', background: '#30D15811', margin: 0 },
};
