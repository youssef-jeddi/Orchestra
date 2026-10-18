'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import * as api from '@/lib/bridge';
import { depositToSafe } from '@/lib/signing';
import { ONBOARDING_POLL_MS, safeStatusFor, shouldPoll, pollAction, onboardingErrorMessage, firstCheck } from '@/lib/onboarding';

// The user's account (a Safe) is created automatically once they are signed in: the server
// deploys it with the agent paying gas, and we only show the address and wait for it.
export function useSafe(ledger, session) {
  const [safeAddress, setSafeAddress] = useState(null);
  const [spendingLimit, setSpendingLimit] = useState(100);
  const [balances, setBalances] = useState({ eth: 0, usdc: 0, weth: 0 });
  const [safeStatus, setSafeStatus] = useState('unknown'); // unknown|checking|deploying|deployed|error
  const [setupError, setSetupError] = useState(null);
  const [finishing, setFinishing] = useState(false); // the account exists; the server is completing the rest
  const [attempt, setAttempt] = useState(0); // bumped by retry()
  const sessionReady = !!session?.ready;

  const refreshBalances = useCallback(async (addr) => {
    const a = addr || safeAddress;
    if (!a) return;
    try {
      const b = await api.getSafeBalances(a);
      setBalances({ eth: Number(b.eth), usdc: Number(b.usdc), weth: Number(b.weth) });
    } catch { /* ignore */ }
  }, [safeAddress]);

  // Once signed in, find the account (and create it if it doesn't exist yet).
  useEffect(() => {
    if (!ledger.walletAddress) {
      setSafeAddress(null);
      setSafeStatus('unknown');
      setSetupError(null);
      setFinishing(false);
      return;
    }

    let cancelled = false;
    let timer;
    setSetupError(null);

    const apply = (data) => {
      setSafeAddress(data.safeAddress);
      setSafeStatus(safeStatusFor(data.status));
      setFinishing(!!data.resumed);
      if (data.spendingLimitUSD) setSpendingLimit(data.spendingLimitUSD);
      if (data.status === 'ready') {
        refreshBalances(data.safeAddress);
        ledger.log(`Account ready: ${data.safeAddress}`);
      }
      if (data.status === 'failed') setSetupError(onboardingErrorMessage({ code: data.errorCode, message: data.error }));
    };

    const poll = async () => {
      try {
        let data = await api.getOnboardingStatus();
        if (cancelled) return;
        if (pollAction(data.status) === 'restart') data = await api.startOnboarding(); // idempotent
        if (cancelled) return;
        apply(data);
        if (shouldPoll(data.status)) timer = setTimeout(poll, ONBOARDING_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setSafeStatus('error');
        setSetupError(onboardingErrorMessage(err));
      }
    };

    const run = async () => {
      setSafeStatus('checking');
      try {
        // Signed in: the server's setup status is the only word on "ready" (a deployed account can
        // still be missing steps). Before sign-in nothing is looked up: the account appears after.
        if (firstCheck(sessionReady) === 'wait') {
          setSafeStatus('unknown');
          return;
        }
        const data = await api.startOnboarding();
        if (cancelled) return;
        apply(data);
        if (shouldPoll(data.status)) timer = setTimeout(poll, ONBOARDING_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setSafeStatus('error');
        setSetupError(onboardingErrorMessage(err));
        ledger.log(`Account setup error: ${err.message}`);
      }
    };
    run();

    return () => { cancelled = true; clearTimeout(timer); };
  }, [ledger.walletAddress, ledger.log, refreshBalances, sessionReady, attempt]);

  /** Try the setup again after an error. */
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const deposit = useCallback(async (token, amount) => {
    if (!ledger.walletAddress || !safeAddress) throw new Error('Connect a wallet first: your account is set up when you sign in.');
    ledger.log(`Depositing ${amount} ${String(token).toUpperCase()} to your account...`);
    const result = await depositToSafe(ledger, safeAddress, token, amount, { emailWallet: session?.emailWallet, hasPasskey: session?.hasPasskey });
    ledger.log(`Deposit broadcast: ${result.txHash}`);
    setTimeout(() => refreshBalances(), 5000);
    return result;
  }, [ledger, safeAddress, refreshBalances, session?.emailWallet, session?.hasPasskey]);

  return {
    safeAddress, spendingLimit, balances, safeStatus, setupError, finishing,
    retry, deposit, refreshBalances,
    setSpendingLimit,
  };
}
