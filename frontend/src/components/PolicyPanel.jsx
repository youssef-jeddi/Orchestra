'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SlidersHorizontal, Sparkles, RefreshCw } from 'lucide-react';
import { useOrchestra } from '@/context/OrchestraContext';
import { getPolicy, setPolicy, getHabit } from '@/lib/bridge';

const ACCENT = '#C084FC';

// The tunable deterministic guardrails, mirrored from the policy engine.
const FIELDS = [
  { key: 'dailyLimitUsd',   label: 'Daily auto-approve limit',  suffix: '$',   hint: 'Total USD the agent can auto-approve in a rolling 24h. Defaults to $100.' },
  { key: 'maxAutoTxPerDay', label: 'Auto-approvals per day',    suffix: 'txs', hint: 'Max number of auto-approvals in 24h.' },
  { key: 'typicalMaxUsd',   label: 'Typical tx size override',  suffix: '$',   hint: 'Leave blank to let the agent learn it.' },
];

export default function PolicyPanel() {
  const { ledger } = useOrchestra();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});      // string-valued form fields
  const [habit, setHabit] = useState(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [demoWallet, setDemoWallet] = useState(null);

  // Dev-only override: visit ?demoWallet=0x... to exercise the panel without a
  // Ledger connected. Disabled in production builds so it can't leak.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const p = new URLSearchParams(window.location.search).get('demoWallet');
    if (p) setDemoWallet(p);
  }, []);

  const wallet = ledger.walletAddress || demoWallet;

  const load = useCallback(async () => {
    setStatus('');
    try {
      const { policy } = await getPolicy();
      const next = {};
      for (const f of FIELDS) next[f.key] = policy?.[f.key] != null ? String(policy[f.key]) : '';
      setValues(next);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
    if (wallet) {
      try { setHabit(await getHabit(wallet)); } catch { /* no data yet */ }
    }
  }, [wallet]);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!wallet) return null;

  const handleSave = async () => {
    setSaving(true);
    setStatus('Saving…');
    try {
      // '' → null clears the field; otherwise parse a number.
      const patch = {};
      for (const f of FIELDS) {
        const raw = values[f.key];
        patch[f.key] = raw === '' || raw == null ? null : Number(raw);
      }
      await setPolicy(patch);
      setStatus('Guardrails saved.');
      if (wallet) { try { setHabit(await getHabit(wallet)); } catch {} }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
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
          position: 'fixed', top: 24, right: 320, zIndex: 51,
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 100, padding: '8px 16px', cursor: 'none',
          display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--font-inter)', fontSize: 12, fontWeight: 400,
          color: '#E8E4DE',
        }}
      >
        <SlidersHorizontal size={13} />
        Guardrails
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
              zIndex: 9997, background: '#111114', boxSizing: 'border-box',
              borderLeft: '1px solid #222', overflowY: 'auto', overflowX: 'hidden',
              fontFamily: 'var(--font-inter)', scrollbarWidth: 'none',
            }}
          >
            {/* Header */}
            <div style={{ padding: '24px 24px 16px', borderBottom: '1px solid #1A1A1A' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ fontFamily: 'var(--font-playfair)', fontSize: 18, fontWeight: 400, color: '#E8E4DE', margin: 0 }}>
                  Guardrails
                </h2>
                <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#666', cursor: 'none', fontSize: 20 }}>
                  &times;
                </button>
              </div>
              <p style={{ fontSize: 12, color: '#777', fontWeight: 300, margin: '8px 0 0', lineHeight: 1.6 }}>
                Deterministic limits the agent enforces before anything executes. Every rule can only ever ask for more approval, never less.
              </p>
            </div>

            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Guardrail fields */}
              {FIELDS.map((f) => (
                <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, color: '#BBB', fontWeight: 400 }}>{f.label}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #333', borderRadius: 8, padding: '0 12px', minWidth: 0, boxSizing: 'border-box' }}>
                    <span style={{ fontSize: 12, color: '#666', flexShrink: 0 }}>{f.suffix}</span>
                    <input
                      type="number"
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder="—"
                      style={{
                        flex: 1, minWidth: 0, width: '100%', background: 'transparent', border: 'none', outline: 'none',
                        color: '#E8E4DE', fontSize: 14, fontFamily: 'var(--font-inter)',
                        padding: '10px 0', cursor: 'none', boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: 11, color: '#666', fontWeight: 300 }}>{f.hint}</span>
                </div>
              ))}

              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  padding: '11px 0', borderRadius: 8, cursor: 'none',
                  fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: 400,
                  background: 'rgba(192,132,252,0.12)', border: `1px solid ${ACCENT}55`,
                  color: ACCENT, opacity: saving ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save guardrails'}
              </button>

              {status && (
                <p style={{ fontSize: 12, color: status.startsWith('Error') ? '#f87171' : '#0f8', margin: 0 }}>
                  {status}
                </p>
              )}

              {/* Learned habit profile */}
              <div style={{ borderTop: '1px solid #1A1A1A', paddingTop: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Sparkles size={14} color={ACCENT} />
                    <span style={{ fontSize: 13, color: '#E8E4DE', fontWeight: 400 }}>What I&apos;ve learned about you</span>
                  </div>
                  <button
                    onClick={() => wallet && getHabit(wallet).then(setHabit).catch(() => {})}
                    style={{ background: 'none', border: 'none', color: '#666', cursor: 'none', display: 'flex' }}
                    title="Refresh"
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>

                {habit && habit.sampleSize > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <HabitRow label="Actions observed (24h)" value={habit.sampleSize} />
                    <HabitRow label="Typical size (median)" value={habit.medianUsd != null ? `$${habit.medianUsd}` : '—'} />
                    <HabitRow label="Largest seen" value={habit.maxUsd != null ? `$${habit.maxUsd}` : '—'} />
                    <div style={{ marginTop: 4, padding: '10px 12px', borderRadius: 8, background: 'rgba(192,132,252,0.06)', border: `1px solid ${ACCENT}22` }}>
                      <span style={{ fontSize: 11, color: '#999', lineHeight: 1.6 }}>
                        {habit.typicalMaxUsd != null
                          ? `Baseline learned: transactions over ~$${habit.typicalMaxUsd * 10} are flagged as unusual and ask for approval.`
                          : `Still learning — needs a few more actions before it flags anomalies.`}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p style={{ fontSize: 12, color: '#666', fontWeight: 300, margin: 0, lineHeight: 1.6 }}>
                    No activity yet. As the agent auto-approves transactions, it learns your typical patterns here.
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function HabitRow({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 12, color: '#888', fontWeight: 300 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#E8E4DE', fontWeight: 400 }}>{value}</span>
    </div>
  );
}
