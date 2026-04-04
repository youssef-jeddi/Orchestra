'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, ChevronRight, Wallet, ArrowDown, Settings } from 'lucide-react';
import { useOrchestra } from '@/context/OrchestraContext';

export default function SafePanel() {
  const { ledger, safe } = useOrchestra();
  const [open, setOpen] = useState(false);
  const [deployLimit, setDeployLimit] = useState(100);
  const [depositToken, setDepositToken] = useState('eth');
  const [depositAmount, setDepositAmount] = useState('');
  const [status, setStatus] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [depositing, setDepositing] = useState(false);

  // Only show toggle when Ledger connected
  if (!ledger.walletAddress) return null;

  const handleDeploy = async () => {
    setDeploying(true);
    setStatus('Deploying Safe...');
    try {
      const addr = await safe.deploy(deployLimit);
      setStatus(`Safe deployed: ${addr.slice(0, 8)}...`);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setDeploying(false);
    }
  };

  const handleDeposit = async () => {
    if (!depositAmount || Number(depositAmount) <= 0) return;
    setDepositing(true);
    setStatus('Sign deposit on Ledger...');
    try {
      const result = await safe.deposit(depositToken, depositAmount);
      setStatus(`Deposited! TX: ${result.txHash.slice(0, 12)}...`);
      setDepositAmount('');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setDepositing(false);
    }
  };

  return (
    <>
      {/* Toggle button */}
      <motion.button
        onClick={() => setOpen(!open)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        style={{
          position: 'fixed', top: 24, right: 200, zIndex: 51,
          background: safe.safeStatus === 'deployed' ? 'rgba(0,255,128,0.08)' : 'transparent',
          border: `1px solid ${safe.safeStatus === 'deployed' ? 'rgba(0,255,128,0.2)' : 'rgba(255,255,255,0.15)'}`,
          borderRadius: 100, padding: '8px 16px', cursor: 'none',
          display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--font-inter)', fontSize: 12, fontWeight: 400,
          color: safe.safeStatus === 'deployed' ? '#0f8' : '#E8E4DE',
        }}
      >
        <Shield size={13} />
        {safe.safeStatus === 'deployed' ? 'Safe' : 'Setup Safe'}
      </motion.button>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, width: 360,
              zIndex: 9997, background: '#111114',
              borderLeft: '1px solid #222', overflowY: 'auto',
              fontFamily: 'var(--font-inter)',
              scrollbarWidth: 'none',
            }}
          >
            {/* Header */}
            <div style={{ padding: '24px 24px 16px', borderBottom: '1px solid #1A1A1A' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ fontFamily: 'var(--font-playfair)', fontSize: 18, fontWeight: 400, color: '#E8E4DE', margin: 0 }}>
                  Safe Account
                </h2>
                <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#666', cursor: 'none', fontSize: 20 }}>
                  &times;
                </button>
              </div>
            </div>

            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Not deployed */}
              {safe.safeStatus !== 'deployed' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ fontSize: 13, color: '#999', fontWeight: 300, margin: 0, lineHeight: 1.6 }}>
                    Deploy a Safe smart account. The agent can auto-execute swaps below your spending limit.
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[50, 100, 500].map((amt) => (
                      <button
                        key={amt}
                        onClick={() => setDeployLimit(amt)}
                        style={{
                          flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, cursor: 'none',
                          fontFamily: 'var(--font-inter)',
                          background: deployLimit === amt ? 'rgba(192,132,252,0.12)' : 'transparent',
                          border: `1px solid ${deployLimit === amt ? 'rgba(192,132,252,0.3)' : '#333'}`,
                          color: deployLimit === amt ? '#C084FC' : '#888',
                        }}
                      >
                        ${amt}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={handleDeploy} disabled={deploying}
                    style={{
                      padding: '10px 0', borderRadius: 10,
                      background: 'rgba(192,132,252,0.12)', border: '1px solid rgba(192,132,252,0.3)',
                      color: '#C084FC', fontSize: 13, fontWeight: 500, cursor: 'none',
                      fontFamily: 'var(--font-inter)', opacity: deploying ? 0.6 : 1,
                    }}
                  >
                    {deploying ? 'Deploying...' : 'Deploy Safe Account'}
                  </button>
                </div>
              )}

              {/* Deployed */}
              {safe.safeStatus === 'deployed' && (
                <>
                  {/* Address */}
                  <div style={{ padding: '10px 14px', background: 'rgba(0,255,128,0.04)', borderRadius: 10, border: '1px solid rgba(0,255,128,0.12)' }}>
                    <p style={{ fontSize: 10, color: '#0f8', textTransform: 'uppercase', letterSpacing: '0.1em', margin: '0 0 4px' }}>Safe Address</p>
                    <p style={{ fontSize: 12, color: '#E8E4DE', fontFamily: 'monospace', margin: 0, wordBreak: 'break-all' }}>
                      {safe.safeAddress}
                    </p>
                    <p style={{ fontSize: 11, color: '#666', margin: '4px 0 0' }}>Limit: ${safe.spendingLimit}</p>
                  </div>

                  {/* Balances */}
                  <div>
                    <p style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: '0.1em', margin: '0 0 8px' }}>Balances</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {[
                        { label: 'ETH', value: safe.balances.eth?.toFixed(4) },
                        { label: 'USDC', value: safe.balances.usdc?.toFixed(2) },
                        { label: 'WETH', value: safe.balances.weth?.toFixed(4) },
                      ].map((t) => (
                        <div key={t.label} style={{ flex: 1, padding: '8px 10px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid #1A1A1A', textAlign: 'center' }}>
                          <p style={{ fontSize: 10, color: '#666', margin: '0 0 2px' }}>{t.label}</p>
                          <p style={{ fontSize: 13, color: '#E8E4DE', margin: 0, fontWeight: 400 }}>{t.value}</p>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => safe.refreshBalances()}
                      style={{ marginTop: 6, background: 'none', border: 'none', color: '#666', fontSize: 10, cursor: 'none', fontFamily: 'var(--font-inter)' }}
                    >
                      Refresh
                    </button>
                  </div>

                  {/* Deposit */}
                  <div>
                    <p style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: '0.1em', margin: '0 0 8px' }}>
                      <ArrowDown size={10} style={{ display: 'inline', marginRight: 4 }} />
                      Deposit to Safe
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select
                        value={depositToken}
                        onChange={(e) => setDepositToken(e.target.value)}
                        style={{
                          width: 80, padding: '8px', borderRadius: 8, fontSize: 12,
                          background: '#1A1A1A', border: '1px solid #333', color: '#E8E4DE',
                          cursor: 'none', fontFamily: 'var(--font-inter)',
                        }}
                      >
                        <option value="eth">ETH</option>
                        <option value="usdc">USDC</option>
                        <option value="weth">WETH</option>
                      </select>
                      <input
                        type="text"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        placeholder="0.01"
                        style={{
                          flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 12,
                          background: '#1A1A1A', border: '1px solid #333', color: '#E8E4DE',
                          outline: 'none', cursor: 'none', fontFamily: 'var(--font-inter)',
                        }}
                      />
                    </div>
                    <button
                      onClick={handleDeposit} disabled={depositing}
                      style={{
                        width: '100%', marginTop: 8, padding: '8px 0', borderRadius: 8,
                        background: 'rgba(192,132,252,0.08)', border: '1px solid rgba(192,132,252,0.2)',
                        color: '#C084FC', fontSize: 12, fontWeight: 400, cursor: 'none',
                        fontFamily: 'var(--font-inter)', opacity: depositing ? 0.6 : 1,
                      }}
                    >
                      {depositing ? 'Signing...' : 'Deposit'}
                    </button>
                  </div>
                </>
              )}

              {/* Status */}
              {status && (
                <p style={{ fontSize: 11, color: '#999', margin: 0, lineHeight: 1.5 }}>
                  {status}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
