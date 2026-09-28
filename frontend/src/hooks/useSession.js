'use client';

// ── Wallet session ──
// Proves wallet ownership to the bridge: the wallet signs an EIP-712 login once
// (MetaMask or Ledger), the server returns a short-lived token, and bridgeFetch
// sends it on every request. The token is kept per wallet in localStorage so a
// reload doesn't ask for another signature until it expires.

import { useState, useEffect, useCallback, useRef } from 'react';
import { authLoginRequest, authLogin, getSession, setSessionToken, onSessionInvalid } from '@/lib/bridge';

const storageKey = (wallet) => `orchestra:session:${wallet.toLowerCase()}`;

function loadToken(wallet) {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    // Keep a minute of slack so a request doesn't race the expiry.
    return token && Date.parse(expiresAt) > Date.now() + 60_000 ? token : null;
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

export function useSession(ledger) {
  const wallet = ledger.walletAddress;
  const [status, setStatus] = useState('none'); // 'none' | 'signing' | 'ready' | 'error'
  const [error, setError] = useState(null);
  const autoTried = useRef(null); // wallet we already auto-prompted for

  const signIn = useCallback(async () => {
    if (!wallet) return;
    setStatus('signing');
    setError(null);
    try {
      const { nonce, typedData } = await authLoginRequest(wallet);
      const sig = await ledger.signTyped(typedData);
      const { ethers } = await import('ethers');
      // Ledger returns {v,r,s}; MetaMask returns a serialized hex string.
      const signature = typeof sig === 'string' ? sig : ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized;
      const { token, expiresAt } = await authLogin(wallet, nonce, signature);
      saveToken(wallet, token, expiresAt);
      setSessionToken(token);
      setStatus('ready');
    } catch (err) {
      setSessionToken(null);
      setError(err.message);
      setStatus('error');
    }
  }, [wallet, ledger]);

  // New wallet: reuse a stored token if the server still accepts it, else ask once.
  useEffect(() => {
    let alive = true;
    setSessionToken(null);
    if (!wallet) { setStatus('none'); return; }

    const stored = loadToken(wallet);
    if (stored) {
      setSessionToken(stored);
      getSession()
        .then(() => { if (alive) setStatus('ready'); })
        .catch(() => { if (alive) { dropToken(wallet); setStatus('none'); } });
    } else if (autoTried.current !== wallet) {
      autoTried.current = wallet;
      signIn();
    } else {
      setStatus('none');
    }
    return () => { alive = false; };
  }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps -- signIn changes with ledger; run once per wallet

  // The server rejected the token (expired, or the server restarted without SESSION_SECRET).
  useEffect(() => onSessionInvalid(() => {
    if (wallet) dropToken(wallet);
    setStatus('none');
  }), [wallet]);

  return { status, error, signIn, ready: status === 'ready' };
}
