'use client';

// ── Limits sheet (/simple) ──
// A beginner's view of how much the agent may do without asking: the daily amount, an optional
// count of automatic payments, what it has learned about their usual amounts, and the addresses
// they've sent to (removable, never addable by hand). Words and form logic live in lib/limits.js;
// the server decides whether a change needs proof (passkey, or a wallet signature without a passkey).
// The "Pause automatic actions" switch (ORC-39) pauses at once; turning it off is like a raise.

import { useState, useEffect, useCallback } from 'react';
import { getPolicy, getHabit } from '@/lib/bridge';
import { saveLimits } from '@/lib/limitsFlow';
import { shortAddress } from '@/lib/onboarding';
import { LIMITS_TEXT, MAX_DAILY, MAX_COUNT, NO_NOTE, habitLine, confirmingText, removeConfirmText, formFrom, formAfterSave, changesFrom, noteAfterAction } from '@/lib/limits';
import { HINT_COLOR, HINT_SIZE } from '@/lib/contrast';
import { PAUSE_TEXT, pauseChange } from '@/lib/pause';

export default function LimitsSheet({ ledger, onClose, buttonStyle, onPauseChange }) {
  const wallet = ledger.walletAddress;
  const [policy, setPolicy] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [habit, setHabit] = useState(null);
  const [form, setForm] = useState({ daily: '', count: '' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(NO_NOTE);
  const [confirming, setConfirming] = useState(null); // the saved address being removed, asked about inline
  const [paused, setPaused] = useState(false);

  const show = useCallback((limits) => {
    setPolicy(limits.policy);
    setRecipients(limits.knownRecipients || []);
    setPaused(!!limits.paused);
    setForm(formFrom(limits.policy));
  }, []);

  useEffect(() => {
    getPolicy().then(show).catch((err) => setNote({ text: `Couldn't load your limits: ${err.message}`, bad: true }));
    if (wallet) getHabit(wallet).then(setHabit).catch(() => {});
  }, [wallet, show]);

  // "Saved." and "Nothing was changed." describe the last save: anything the user does next makes them stale.
  const moveOn = useCallback(() => setNote((n) => noteAfterAction(n, !!policy)), [policy]);

  // `resetOnFail`: a limit change that is cancelled or refused puts the saved numbers back in the form.
  const run = async (change, { resetOnFail = false } = {}) => {
    setBusy(true);
    setNote(NO_NOTE);
    const resuming = change.pauseAuto === false;
    try {
      const out = await saveLimits(ledger, change, (method) => setNote({ text: confirmingText(method, resuming ? 'resume' : 'raise'), bad: false }));
      if (out.saved) {
        show(out.limits);
        setNote({ text: change.pauseAuto === undefined ? LIMITS_TEXT.saved : (out.limits.paused ? PAUSE_TEXT.paused : PAUSE_TEXT.resumed), bad: false });
        if (change.pauseAuto !== undefined) onPauseChange?.();
      } else {
        if (resetOnFail) setForm(formAfterSave(out, policy));
        setNote({ text: LIMITS_TEXT.cancelled, bad: false });
      }
    } catch (err) {
      if (resetOnFail) setForm(formAfterSave(null, policy));
      setNote({ text: err.message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const { error, policy: changes } = changesFrom(form, policy);
    if (error) { setNote({ text: error, bad: true }); return; }
    if (Object.keys(changes).length === 0) { setNote({ text: LIMITS_TEXT.noChange, bad: false }); return; }
    run({ policy: changes }, { resetOnFail: true });
  };

  const smallBtn = { background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 100, padding: '4px 10px', fontSize: 12, color: '#E8E4DE', cursor: 'pointer' };
  const input = { background: 'transparent', border: '1px solid #333', borderRadius: 8, padding: '6px 10px', color: '#E8E4DE', fontSize: 14, width: 120, outline: 'none', fontFamily: 'var(--font-inter)' };

  return (
    <div style={{ marginTop: 12, padding: '12px 14px', border: '1px solid #1c1c22', borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 15, color: '#E8E4DE' }}>{LIMITS_TEXT.title}</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }} title="Close">×</button>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: HINT_SIZE, color: HINT_COLOR, lineHeight: 1.5 }}>{LIMITS_TEXT.intro}</p>

      {!policy && !note.bad && <p style={{ fontSize: HINT_SIZE, color: HINT_COLOR, margin: 0 }}>Loading…</p>}
      {policy && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#E8E4DE', cursor: busy ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={paused} disabled={busy}
              onChange={(e) => { moveOn(); run(pauseChange(e.target.checked)); }} />
            {PAUSE_TEXT.toggle}
          </label>
          <p style={{ margin: '4px 0 12px', fontSize: HINT_SIZE, color: HINT_COLOR }}>{PAUSE_TEXT.toggleHint}</p>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#B9B5AE' }}>
            {LIMITS_TEXT.daily}
            <input type="number" min="0" max={MAX_DAILY} value={form.daily} disabled={busy}
              onChange={(e) => { moveOn(); setForm((f) => ({ ...f, daily: e.target.value })); }} style={input} />
          </label>
          <p style={{ margin: '4px 0 12px', fontSize: HINT_SIZE, color: HINT_COLOR }}>{LIMITS_TEXT.dailyHint}</p>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#B9B5AE' }}>
            {LIMITS_TEXT.count}
            <input type="number" min="0" max={MAX_COUNT} placeholder={LIMITS_TEXT.countPlaceholder} value={form.count} disabled={busy}
              onChange={(e) => { moveOn(); setForm((f) => ({ ...f, count: e.target.value })); }} style={input} />
          </label>
          <p style={{ margin: '4px 0 12px', fontSize: HINT_SIZE, color: HINT_COLOR }}>{LIMITS_TEXT.countHint}</p>

          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#B9B5AE' }}>{habitLine(habit)}</p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={save} disabled={busy} style={buttonStyle(busy)}>{busy ? 'Saving…' : LIMITS_TEXT.save}</button>
            {note.text && <span style={{ fontSize: 12, color: note.bad ? '#FF453A' : HINT_COLOR }}>{note.text}</span>}
          </div>

          <div style={{ marginTop: 16, borderTop: '1px solid #1c1c22', paddingTop: 10 }}>
            <span style={{ fontSize: HINT_SIZE, color: HINT_COLOR }} title={LIMITS_TEXT.removeHint}>{LIMITS_TEXT.addresses}</span>
            {recipients.length === 0 && <p style={{ fontSize: HINT_SIZE, color: HINT_COLOR, margin: '6px 0 0' }}>{LIMITS_TEXT.noAddresses}</p>}
            {recipients.map((a) => (
              confirming === a ? (
                <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '6px 0' }}>
                  <span style={{ fontSize: 13, color: '#E8E4DE' }}>{removeConfirmText(shortAddress(a))}</span>
                  <button onClick={() => { setConfirming(null); run({ removeAddress: a }); }} disabled={busy} style={smallBtn}>{LIMITS_TEXT.remove}</button>
                  <button onClick={() => { setConfirming(null); moveOn(); }} disabled={busy} style={smallBtn}>{LIMITS_TEXT.keep}</button>
                </div>
              ) : (
                <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                  <span style={{ fontSize: 13, color: '#E8E4DE' }} title={a}>{shortAddress(a)}</span>
                  <button onClick={() => { moveOn(); setConfirming(a); }} disabled={busy} style={{ ...smallBtn, marginLeft: 'auto' }}
                    title={LIMITS_TEXT.removeHint}>{LIMITS_TEXT.remove}</button>
                </div>
              )
            ))}
          </div>
        </>
      )}
      {!policy && note.bad && <span style={{ fontSize: 12, color: '#FF453A' }}>{note.text}</span>}
    </div>
  );
}
