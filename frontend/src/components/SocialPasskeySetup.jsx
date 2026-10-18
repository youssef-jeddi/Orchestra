'use client';

// Users who signed in with Google, Apple, … add their first passkey here. Two steps, both needed
// by the server:
//   1. confirm it's them by signing in again with the same provider (the page goes to the
//      provider and comes back; the request they were making is kept in this tab meanwhile), and
//   2. the passkey itself (Face ID, fingerprint or device PIN), its own tap.
// On coming back, the confirmation is sent to the server by itself and step 2 appears.

import { useState, useEffect, useRef } from 'react';
import { usePrivy, useLoginWithOAuth, getIdentityToken } from '@privy-io/react-auth';
import { emailVerify } from '@/lib/bridge';
import { registerPasskey } from '@/lib/passkey';
import { PASSKEY_PROMPT, emailStepError, passkeyDraft, socialConfirmLabel, socialConfirmHelp } from '@/lib/emailPasskey';

const draftStore = () => passkeyDraft(window.sessionStorage);

export default function SocialPasskeySetup({ wallet, provider, getHeld, returning, onDone, onClose, style }) {
  const { logout } = usePrivy();
  const { initOAuth } = useLoginWithOAuth();
  const [step, setStep] = useState(returning ? 'checking' : 'confirm'); // confirm | leaving | checking | passkey | adding
  const [error, setError] = useState(null);
  const checked = useRef(false);

  // Back from the provider: the fresh sign-in is the proof, send it to the server.
  useEffect(() => {
    if (!returning || checked.current) return;
    checked.current = true;
    (async () => {
      try {
        await emailVerify(await getIdentityToken());
        setStep('passkey');
      } catch (err) {
        setError(emailStepError(err, 'email'));
        setStep('confirm');
      }
    })();
  }, [returning]);

  const confirm = async () => {
    setError(null);
    setStep('leaving');
    try {
      const held = getHeld();
      draftStore().save({ wallet, text: held?.text, history: held?.history });
      // A fresh sign-in needs a signed-out start; disableSignup keeps a wrong account from creating a new one.
      await logout();
      await initOAuth({ provider: provider.id, disableSignup: true });
    } catch (err) {
      draftStore().clear();
      setError(emailStepError(err, 'email'));
      setStep('confirm');
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
      setStep(err?.code === 'email_verification_required' ? 'confirm' : 'passkey');
    }
  };

  const button = { ...style?.button, cursor: 'pointer' };

  return (
    <div style={{ marginTop: 12, padding: '12px 14px', border: '1px solid #1c1c22', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#B9B5AE', lineHeight: 1.5 }}>{PASSKEY_PROMPT}</p>
        <button onClick={onClose} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>×</button>
      </div>

      {(step === 'confirm' || step === 'leaving') && (
        <>
          <span style={{ fontSize: 12, color: '#777' }}>{socialConfirmHelp(provider.name)}</span>
          <button onClick={confirm} disabled={step === 'leaving'} style={{ ...button, alignSelf: 'flex-start' }}>
            {step === 'leaving' ? `Opening ${provider.name}…` : socialConfirmLabel(provider.name)}
          </button>
        </>
      )}

      {step === 'checking' && <span style={{ fontSize: 13, color: '#777' }}>Checking it&apos;s you…</span>}

      {(step === 'passkey' || step === 'adding') && (
        <>
          <span style={{ fontSize: 12, color: '#30D158' }}>✓ Confirmed with {provider.name}. Now add your passkey.</span>
          <button onClick={addPasskey} disabled={step === 'adding'} style={{ ...button, alignSelf: 'flex-start' }}>
            {step === 'adding' ? 'Follow the prompt on your device…' : '🔑 Add passkey'}
          </button>
        </>
      )}

      {error && <span style={{ fontSize: 13, color: '#FF453A' }}>{error}</span>}
    </div>
  );
}
