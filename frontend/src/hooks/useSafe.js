'use client';

import { useState, useCallback, useEffect } from 'react';
import * as api from '@/lib/bridge';

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
    if (!ledger.walletAddress || !safeAddress) throw new Error('Connect Ledger and deploy Safe first');

    const { ethers } = await import('ethers');
    const nonceData = await api.getNonce(ledger.walletAddress);
    const maxFeePerGas = BigInt(nonceData.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(nonceData.maxPriorityFeePerGas);

    let tx;
    if (token === 'eth') {
      tx = ethers.Transaction.from({
        to: safeAddress,
        value: ethers.parseEther(amount),
        nonce: nonceData.nonce,
        maxFeePerGas, maxPriorityFeePerGas,
        gasLimit: 21000, chainId: 11155111, type: 2,
      });
    } else {
      const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
      const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
      const tokenAddr = token === 'usdc' ? USDC : WETH;
      const decimals = token === 'usdc' ? 6 : 18;
      const iface = new ethers.Interface(['function transfer(address to, uint256 amount)']);
      const data = iface.encodeFunctionData('transfer', [safeAddress, ethers.parseUnits(amount, decimals)]);

      tx = ethers.Transaction.from({
        to: tokenAddr, value: 0n, data,
        nonce: nonceData.nonce,
        maxFeePerGas, maxPriorityFeePerGas,
        gasLimit: 80000, chainId: 11155111, type: 2,
      });
    }

    ledger.log(`Depositing ${amount} ${token.toUpperCase()} to Safe...`);
    const sig = await ledger.sign(tx.unsignedSerialized);
    const { ethers: e2 } = await import('ethers');
    const signedTx = tx.clone();
    signedTx.signature = e2.Signature.from(sig);

    const result = await api.broadcast(signedTx.serialized);
    ledger.log(`Deposit broadcast: ${result.txHash}`);

    // Refresh balances after delay
    setTimeout(() => refreshBalances(), 5000);
    return result;
  }, [ledger, safeAddress, refreshBalances]);

  return {
    safeAddress, spendingLimit, balances, safeStatus,
    deploy, deposit, refreshBalances,
    setSpendingLimit,
  };
}
