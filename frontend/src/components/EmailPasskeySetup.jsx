'use client';

// Email users add their first passkey here. Two steps, both needed by the server:
//   1. a fresh email code (Privy emails it and checks it; the server then sees the new
//      verification time in the user's identity token), and
//   2. the passkey itself (Face ID, fingerprint or device PIN).
// The passkey prompt is its own tap: browsers only allow it right after a tap, not after
// the network calls that come after typing the code.

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePrivy, useLoginWithEmail, getIdentityToken } from '@privy-io/react-auth';
import { emailVerify } from '@/lib/bridge';
import { registerPasskey } from '@/lib/passkey';
import { PASSKEY_PROMPT, emailStepError } from '@/lib/emailPasskey';

export default function EmailPasskeySetup({ wallet, onDone, onClose, style }) {
  const { user } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const email = user?.email?.address;
  const [step, setStep] = useState('sending'); // sending | code | checking | passkey | adding
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const started = useRef(false);

  const requestCode = useCallback(async () => {
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

  // One tap on "Add passkey" already emailed the code.
  useEffect(() => {
    if (started.current || !email) return;
    started.current = true;
    requestCode(); // eslint-disable-line react-hooks/set-state-in-effect -- sending the email is the side effect here
  }, [email, requestCode]);

  const confirmCode = async () => {
    setError(null);
    setStep('checking');
    try {
      await loginWithCode({ code: code.trim() });
      await emailVerify(await getIdentityToken());
      setStep('passkey');
    } catch (err) {
      setError(emailStepError(err, 'email'));
      setStep('code');
    }
  };

  const addPasskey = async () => {
    setError(null);
    setStep('adding');
    try {
      await registerPasskey(wallet);
      onDone();
    } catch (err) {
      setError(emailStepError(err, 'passkey'));
      setStep(err?.code === 'email_verification_required' ? 'code' : 'passkey');
    }
  };

  const input = {
    flex: 1, minWidth: 0, background: '#0F0F12', border: '1px solid #2a2a30', borderRadius: 10,
    padding: '9px 12px', color: '#E8E4DE', fontSize: 15, letterSpacing: 4, outline: 'none', cursor: 'text',
  };
  const button = { ...style?.button, cursor: 'pointer' };

  return (
    <div style={{ marginTop: 12, padding: '12px 14px', border: '1px solid #1c1c22', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#B9B5AE', lineHeight: 1.5 }}>{PASSKEY_PROMPT}</p>
        <button onClick={onClose} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>×</button>
      </div>

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

      {(step === 'passkey' || step === 'adding') && (
        <>
          <span style={{ fontSize: 12, color: '#30D158' }}>✓ Email confirmed. Now add your passkey.</span>
          <button onClick={addPasskey} disabled={step === 'adding'} style={{ ...button, alignSelf: 'flex-start' }}>
            {step === 'adding' ? 'Follow the prompt on your device…' : '🔑 Add passkey'}
          </button>
        </>
      )}

      {error && <span style={{ fontSize: 13, color: '#FF453A' }}>{error}</span>}
    </div>
  );
}
