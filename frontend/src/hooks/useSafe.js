'use client';

import { useState, useCallback, useEffect } from 'react';
import * as api from '@/lib/bridge';
import { depositToSafe } from '@/lib/signing';

export function useSafe(ledger) {
  const [safeAddress, setSafeAddress] = useState(null);
  const [spendingLimit, setSpendingLimit] = useState(100);
  const [balances, setBalances] = useState({ eth: 0, usdc: 0, weth: 0 });
  const [safeStatus, setSafeStatus] = useState('unknown'); // unknown|checking|deployed|not_deployed|error

  const refreshBalances = useCallback(async (addr) => {
    const a = addr || safeAddress;
    if (!a) return;
    try {
      const b = await api.getSafeBalances(a);
      setBalances({ eth: Number(b.eth), usdc: Number(b.usdc), weth: Number(b.weth) });
    } catch { /* ignore */ }
  }, [safeAddress]);

  // Auto-check Safe when wallet connects
  useEffect(() => {
    if (!ledger.walletAddress) {
      setSafeAddress(null);
      setSafeStatus('unknown');
      return;
    }

    let cancelled = false;
    setSafeStatus('checking');

    api.checkSafe(ledger.walletAddress).then((data) => {
      if (cancelled) return;
      if (data.hasSafe) {
        setSafeAddress(data.safeAddress);
        setSpendingLimit(data.spendingLimitUSD || 100);
        setSafeStatus('deployed');
        refreshBalances(data.safeAddress);
        ledger.log(`Safe detected: ${data.safeAddress}`);
      } else {
        setSafeStatus('not_deployed');
        ledger.log('No Safe account — needs onboarding');
      }
    }).catch((err) => {
      if (!cancelled) {
        setSafeStatus('error');
        ledger.log(`Safe check error: ${err.message}`);
      }
    });

    return () => { cancelled = true; };
  }, [ledger.walletAddress, ledger.log, refreshBalances]);

  const deploy = useCallback(async (limitUsd = 100) => {
    if (!ledger.walletAddress) throw new Error('Connect Ledger first');
    ledger.log(`Deploying Safe with $${limitUsd} limit...`);

    const data = await api.deploySafe(ledger.walletAddress, limitUsd);
    setSafeAddress(data.safeAddress);
    setSpendingLimit(limitUsd);
    setSafeStatus('deployed');
    refreshBalances(data.safeAddress);
    ledger.log(`Safe deployed: ${data.safeAddress}`);
    return data.safeAddress;
  }, [ledger, refreshBalances]);

  const deposit = useCallback(async (token, amount) => {
    if (!ledger.walletAddress || !safeAddress) throw new Error('Connect a wallet and create a Safe first');
    ledger.log(`Depositing ${amount} ${String(token).toUpperCase()} to Safe...`);
    const result = await depositToSafe(ledger, safeAddress, token, amount);
    ledger.log(`Deposit broadcast: ${result.txHash}`);
    setTimeout(() => refreshBalances(), 5000);
    return result;
  }, [ledger, safeAddress, refreshBalances]);

  return {
    safeAddress, spendingLimit, balances, safeStatus,
    deploy, deposit, refreshBalances,
    setSpendingLimit,
  };
}
