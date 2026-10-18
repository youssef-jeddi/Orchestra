'use client';

// ── Limits sheet (/simple) ──
// A beginner's view of how much the agent may do without asking: the daily amount, an optional
// count of automatic payments, what it has learned about their usual amounts, and the addresses
// they've sent to (removable, never addable by hand). Words and form logic live in lib/limits.js;
// the server decides whether a change needs proof (passkey, or a wallet signature without a passkey).

import { useState, useEffect, useCallback } from 'react';
import { getPolicy, getHabit } from '@/lib/bridge';
import { saveLimits } from '@/lib/limitsFlow';
import { shortAddress } from '@/lib/onboarding';
import { LIMITS_TEXT, MAX_DAILY, MAX_COUNT, habitLine, confirmingText, formFrom, changesFrom } from '@/lib/limits';

export default function LimitsSheet({ ledger, onClose, buttonStyle }) {
  const wallet = ledger.walletAddress;
  const [policy, setPolicy] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [habit, setHabit] = useState(null);
  const [form, setForm] = useState({ daily: '', count: '' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ text: '', bad: false });

  const show = useCallback((limits) => {
    setPolicy(limits.policy);
    setRecipients(limits.knownRecipients || []);
    setForm(formFrom(limits.policy));
  }, []);

  useEffect(() => {
    getPolicy().then(show).catch((err) => setNote({ text: `Couldn't load your limits: ${err.message}`, bad: true }));
    if (wallet) getHabit(wallet).then(setHabit).catch(() => {});
  }, [wallet, show]);

  const run = async (change) => {
    setBusy(true);
    setNote({ text: '', bad: false });
    try {
      const out = await saveLimits(ledger, change, (method) => setNote({ text: confirmingText(method), bad: false }));
      if (out.saved) {
        show(out.limits);
        setNote({ text: LIMITS_TEXT.saved, bad: false });
      } else {
        setNote({ text: LIMITS_TEXT.cancelled, bad: false });
      }
    } catch (err) {
      setNote({ text: err.message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const { error, policy: changes } = changesFrom(form, policy);
    if (error) { setNote({ text: error, bad: true }); return; }
    if (Object.keys(changes).length === 0) { setNote({ text: LIMITS_TEXT.noChange, bad: false }); return; }
    run({ policy: changes });
  };

  const input = { background: 'transparent', border: '1px solid #333', borderRadius: 8, padding: '6px 10px', color: '#E8E4DE', fontSize: 14, width: 90, outline: 'none', fontFamily: 'var(--font-inter)' };

  return (
    <div style={{ marginTop: 12, padding: '12px 14px', border: '1px solid #1c1c22', borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 15, color: '#E8E4DE' }}>{LIMITS_TEXT.title}</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }} title="Close">×</button>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: '#777', lineHeight: 1.5 }}>{LIMITS_TEXT.intro}</p>

      {!policy && !note.bad && <p style={{ fontSize: 12, color: '#555', margin: 0 }}>Loading…</p>}
      {policy && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: '#B9B5AE' }}>
            Send up to $
            <input type="number" min="0" max={MAX_DAILY} value={form.daily} disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, daily: e.target.value }))} style={input} aria-label="Daily amount in dollars" />
            a day without asking me
          </label>
          <p style={{ margin: '4px 0 12px', fontSize: 11, color: '#666' }}>{LIMITS_TEXT.dailyHint}</p>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: '#B9B5AE' }}>
            Ask me after
            <input type="number" min="0" max={MAX_COUNT} placeholder="off" value={form.count} disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, count: e.target.value }))} style={input} aria-label="Automatic payments per day" />
            automatic payments a day
          </label>
          <p style={{ margin: '4px 0 12px', fontSize: 11, color: '#666' }}>{LIMITS_TEXT.countHint}</p>

          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#B9B5AE' }}>{habitLine(habit)}</p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={save} disabled={busy} style={buttonStyle(busy)}>{busy ? 'Saving…' : LIMITS_TEXT.save}</button>
            {note.text && <span style={{ fontSize: 12, color: note.bad ? '#FF453A' : '#999' }}>{note.text}</span>}
          </div>

          <div style={{ marginTop: 16, borderTop: '1px solid #1c1c22', paddingTop: 10 }}>
            <span style={{ fontSize: 12, color: '#999' }} title={LIMITS_TEXT.removeHint}>{LIMITS_TEXT.addresses}</span>
            {recipients.length === 0 && <p style={{ fontSize: 12, color: '#666', margin: '6px 0 0' }}>{LIMITS_TEXT.noAddresses}</p>}
            {recipients.map((a) => (
              <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: '#E8E4DE' }} title={a}>{shortAddress(a)}</span>
                <button onClick={() => run({ removeAddress: a })} disabled={busy}
                  style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 100, padding: '4px 10px', fontSize: 12, color: '#E8E4DE', cursor: 'pointer' }}
                  title={LIMITS_TEXT.removeHint}>Remove</button>
              </div>
            ))}
          </div>
        </>
      )}
      {!policy && note.bad && <span style={{ fontSize: 12, color: '#FF453A' }}>{note.text}</span>}
    </div>
  );
}
