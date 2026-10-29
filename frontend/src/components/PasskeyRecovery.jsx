'use client';

// Lost-passkey recovery (ORC-118): fresh email code, then Telegram confirm or a 48h-delayed
// passkey. Mounted from the Passkeys panel on /simple when the account already has a passkey.

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePrivy, useLoginWithEmail, getIdentityToken } from '@privy-io/react-auth';
import { emailVerify, passkeyRecoveryStart, passkeyRecoveryStatus, passkeyRecoveryCancel } from '@/lib/bridge';
import { registerRecoveryPasskey } from '@/lib/passkey';
import { addPasskeyButton } from '@/lib/passkeyErrors';
import { emailStepError, passkeyStepError } from '@/lib/emailPasskey';
import { RECOVERY_EMAIL_PROMPT } from '@/lib/passkeyRecovery';

export default function PasskeyRecovery({ wallet, onDone, onClose, style }) {
  const { user } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const email = user?.email?.address;
  const [step, setStep] = useState(email ? 'sending' : 'no-email'); // sending | code | checking | wait-telegram | passkey | adding | pending
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const started = useRef(false);

  const requestCode = useCallback(async () => {
    if (!email) { setStep('no-email'); return; }
    setError(null);
    setStep('sending');
    try {
      await sendCode({ email, disableSignup: true });
      setStep('code');
    } catch (err) {
      setError(emailStepError(err, 'email'));
      setStep('code');
    }
  }, [sendCode, email]);

  useEffect(() => {
    if (started.current || !email) return;
    started.current = true;
    requestCode(); // eslint-disable-line react-hooks/set-state-in-effect
  }, [email, requestCode]);

  // Poll while waiting on Telegram confirm.
  useEffect(() => {
    if (step !== 'wait-telegram') return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await passkeyRecoveryStatus();
        if (stop) return;
        setRecovery(r);
        if (r.status === 'granted') setStep('passkey');
        else if (r.status === 'none') { onClose(); onDone(); }
      } catch { /* keep waiting */ }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { stop = true; clearInterval(id); };
  }, [step, onClose, onDone]);

  const confirmCode = async () => {
    setError(null);
    setStep('checking');
    try {
      await loginWithCode({ code: code.trim() });
      await emailVerify(await getIdentityToken());
      const r = await passkeyRecoveryStart();
      setRecovery(r);
      if (r.status === 'awaiting_telegram') setStep('wait-telegram');
      else if (r.status === 'granted') setStep('passkey');
      else setStep('passkey');
    } catch (err) {
      setError(emailStepError(err, 'email'));
      setStep('code');
    }
  };

  const addPasskey = async () => {
    setError(null);
    setStep('adding');
    try {
      const result = await registerRecoveryPasskey(wallet);
      if (result?.recovery === 'delay') {
        const r = await passkeyRecoveryStatus();
        setRecovery(r);
        setStep('pending');
        onDone();
      } else {
        onDone();
        onClose();
      }
    } catch (err) {
      setStep(err?.code === 'email_verification_required' ? 'code' : 'passkey');
      setError(await passkeyStepError(err));
    }
  };

  const cancel = async () => {
    setError(null);
    try {
      await passkeyRecoveryCancel();
      onDone();
      onClose();
    } catch (err) {
      setError(err?.message || "Couldn't cancel.");
    }
  };

  const input = {
    flex: 1, minWidth: 0, background: '#0F0F12', border: '1px solid #2a2a30', borderRadius: 10,
    padding: '9px 12px', color: '#E8E4DE', fontSize: 15, letterSpacing: 4, outline: 'none', cursor: 'text',
  };
  const button = { ...style?.button, cursor: 'pointer' };

  return (
    <div style={{ marginTop: 12, padding: '12px 14px', border: '1px solid rgba(255,69,58,0.35)', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 10, background: 'rgba(255,69,58,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#B9B5AE', lineHeight: 1.5 }}>{RECOVERY_EMAIL_PROMPT}</p>
        <button onClick={onClose} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>×</button>
      </div>

      {step === 'no-email' && (
        <span style={{ fontSize: 13, color: '#FF453A' }}>
          Recovery needs an email on this account. Add a backup email under Account first.
        </span>
      )}

      {step === 'sending' && <span style={{ fontSize: 13, color: '#777' }}>Emailing you a code…</span>}

      {(step === 'code' || step === 'checking') && (
        <>
          <span style={{ fontSize: 12, color: '#777' }}>We sent a code to {email}. Enter it here.</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
              placeholder="123456" maxLength={8} style={input}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) confirmCode(); }} />
            <button onClick={confirmCode} disabled={step === 'checking' || !code.trim()} style={button}>
              {step === 'checking' ? 'Checking…' : 'Confirm'}
            </button>
          </div>
          <button onClick={requestCode} disabled={step === 'checking'} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: '#777', fontSize: 12, cursor: 'pointer', padding: 0 }}>
            Send a new code
          </button>
        </>
      )}

      {step === 'wait-telegram' && (
        <>
          <span style={{ fontSize: 13, color: '#E8E4DE', lineHeight: 1.5 }}>
            Confirm on Telegram to unlock adding a new passkey. If this wasn&apos;t you, cancel there or below.
          </span>
          <button onClick={cancel} style={{ ...button, alignSelf: 'flex-start', background: '#2a2a30' }}>Cancel recovery</button>
        </>
      )}

      {(step === 'passkey' || step === 'adding') && (
        <>
          <span style={{ fontSize: 12, color: '#30D158' }}>
            {recovery?.mode === 'delay'
              ? '✓ Email confirmed. Add your passkey — it waits 48 hours before it can approve.'
              : '✓ Confirmed. Add your new passkey — it can approve right away.'}
          </span>
          <button onClick={addPasskey} disabled={addPasskeyButton(step === 'adding').disabled} style={{ ...button, alignSelf: 'flex-start' }}>
            {addPasskeyButton(step === 'adding').label}
          </button>
          <button onClick={cancel} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: '#777', fontSize: 12, cursor: 'pointer', padding: 0 }}>
            Cancel recovery
          </button>
        </>
      )}

      {step === 'pending' && (
        <>
          <span style={{ fontSize: 13, color: '#E8E4DE', lineHeight: 1.5 }}>
            {recovery?.label || 'Replacement passkey is waiting (48h). It can\'t approve yet. Telegram approvals still work.'}
          </span>
          <button onClick={cancel} style={{ ...button, alignSelf: 'flex-start', background: '#2a2a30' }}>Cancel pending passkey</button>
        </>
      )}

      {error && <span style={{ fontSize: 13, color: '#FF453A' }}>{error}</span>}
    </div>
  );
}
