'use client';

// ── Wallet session ──
// Proves wallet ownership to the bridge: the wallet signs an EIP-712 login once
// (MetaMask or Ledger) — or, for wallets that came through Privy, Privy's identity
// token stands in for the signature — the server returns a short-lived token, and
// bridgeFetch sends it on every request. The token is kept per wallet in localStorage so a
// reload doesn't ask for another signature until it expires.

import { useState, useEffect, useCallback, useRef } from 'react';
import { authLoginRequest, authLogin, authPrivy, getSession, setSessionToken, onSessionInvalid } from '@/lib/bridge';

const storageKey = (wallet) => `orchestra:session:${wallet.toLowerCase()}`;

// Treat a session as over a minute early, so a request doesn't race the expiry.
const EXPIRY_SLACK_MS = 60_000;

function loadToken(wallet) {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    return token && Date.parse(expiresAt) > Date.now() + EXPIRY_SLACK_MS ? { token, expiresAt } : null;
  } catch {
    return null;
  }
}

function saveToken(wallet, token, expiresAt) {
  try { localStorage.setItem(storageKey(wallet), JSON.stringify({ token, expiresAt })); } catch { /* private mode */ }
}

function dropToken(wallet) {
  try { localStorage.removeItem(storageKey(wallet)); } catch { /* ignore */ }
}

const viaPrivy = (ledger) => ledger.connectionType === 'privy' || ledger.connectionType === 'external';

async function signedLogin(wallet, ledger) {
  const { nonce, typedData } = await authLoginRequest(wallet);
  const sig = await ledger.signTyped(typedData);
  const { ethers } = await import('ethers');
  // Ledger returns {v,r,s}; MetaMask returns a serialized hex string.
  const signature = typeof sig === 'string' ? sig : ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized;
  return authLogin(wallet, nonce, signature);
}

export function useSession(ledger) {
  const wallet = ledger.walletAddress;
  const [status, setStatus] = useState('none'); // 'none' | 'signing' | 'ready' | 'error'
  const [error, setError] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const autoTried = useRef(null); // wallet we already auto-prompted for

  // A different wallet starts signed out; the effect below then restores or asks.
  const [prevWallet, setPrevWallet] = useState(wallet);
  if (wallet !== prevWallet) {
    setPrevWallet(wallet);
    setStatus('none');
  }

  /** Ask the wallet to sign in. Resolves true once a session is active. */
  const signIn = useCallback(async () => {
    if (!wallet) return false;
    setStatus('signing');
    setError(null);
    try {
      const { token, expiresAt } = viaPrivy(ledger)
        ? await authPrivy(wallet, ledger.getIdentityToken())
        : await signedLogin(wallet, ledger);
      saveToken(wallet, token, expiresAt);
      setSessionToken(token);
      setExpiresAt(expiresAt);
      setStatus('ready');
      return true;
    } catch (err) {
      setSessionToken(null);
      setError(err.message);
      setStatus('error');
      return false;
    }
  }, [wallet, ledger]);

  // New wallet: reuse a stored token if the server still accepts it, else ask once.
  // Privy wallets always get a fresh session: it costs no prompt, and signing in is
  // when the server picks up the user's sign-in passkey for approvals.
  useEffect(() => {
    let alive = true;
    setSessionToken(null);
    if (!wallet) return;

    const privy = viaPrivy(ledger);
    const stored = privy ? null : loadToken(wallet);
    if (stored) {
      setSessionToken(stored.token);
      getSession()
        .then(() => { if (alive) { setExpiresAt(stored.expiresAt); setStatus('ready'); } })
        .catch(() => { if (alive) { dropToken(wallet); setStatus('none'); } });
    } else if (privy || autoTried.current !== wallet) {
      autoTried.current = wallet;
      // Signing in is the side effect here; signIn only marks 'signing' before it awaits the server.
      signIn(); // eslint-disable-line react-hooks/set-state-in-effect
    }
    return () => { alive = false; };
  }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps -- signIn changes with ledger; run once per wallet

  // The server rejected the token (expired, or the server restarted without SESSION_SECRET).
  useEffect(() => onSessionInvalid(() => {
    if (wallet) dropToken(wallet);
    setStatus('none');
  }), [wallet]);

  // A session ends on its own after a few hours: show "Sign in" when it does,
  // instead of keeping a dead token until a request fails.
  useEffect(() => {
    if (status !== 'ready' || !expiresAt || !wallet) return;
    const ms = Date.parse(expiresAt) - Date.now() - EXPIRY_SLACK_MS;
    const expire = () => { setSessionToken(null); dropToken(wallet); setStatus('none'); };
    const id = setTimeout(expire, Math.max(0, ms));
    return () => clearTimeout(id);
  }, [status, expiresAt, wallet]);

  /** True when signed in — asking the wallet to sign in first if needed. */
  const ensure = useCallback(async () => (status === 'ready' ? true : signIn()), [status, signIn]);

  return { status, error, signIn, ensure, ready: status === 'ready' };
}
