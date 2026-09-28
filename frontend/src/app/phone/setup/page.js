'use client';

// ── /phone/setup?token=… ──
// Opened on the phone from the one-time Telegram link. Creates a passkey on
// this phone for this domain; from then on, risky transactions are approved on
// /phone/approve with it.
//
// The registration options are fetched when the page opens, not on tap: mobile
// Safari only allows the passkey prompt straight from a tap, and an await
// before it can make the browser refuse (NotAllowedError).

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import {
  phoneSetupOptions, phoneSetupVerify, phoneStyles as s,
  useBrowserEnv, passkeyErrorMessage, OPEN_IN_BROWSER,
} from '@/lib/phone';

export default function PhoneSetupPage() {
  return (
    <main style={s.page}>
      <span style={s.brand}>Orchestra</span>
      <Suspense fallback={<p style={s.muted}>Loading…</p>}>
        <Setup />
      </Suspense>
    </main>
  );
}

function Setup() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState('idle'); // idle | working | done
  const [error, setError] = useState(null);
  const [prepared, setPrepared] = useState(null); // { wallet, options }
  const env = useBrowserEnv();

  const prepare = useCallback(() => {
    if (!token) return;
    phoneSetupOptions(token).then(setPrepared).catch((err) => setError(err.message));
  }, [token]);

  useEffect(() => {
    prepare();
  }, [prepare]);

  if (!token) return <p style={s.error}>This link is incomplete. Open the setup link from Telegram again.</p>;

  const create = async () => {
    setState('working');
    setError(null);
    try {
      // Options are already here, so the prompt fires directly from the tap.
      const { options } = prepared ?? (await phoneSetupOptions(token));
      const response = await startRegistration({ optionsJSON: options });
      await phoneSetupVerify(token, response);
      setState('done');
    } catch (err) {
      setError(passkeyErrorMessage(err, 'passkey creation'));
      setState('idle');
      setPrepared(null);
      prepare(); // fresh challenge for the next try
    }
  };

  if (state === 'done') {
    const wallet = prepared?.wallet;
    return (
      <div style={s.card}>
        <p style={s.ok}>✓ Passkey set up on this phone.</p>
        <p style={s.muted}>
          From now on, risky transactions{wallet ? ` for ${wallet.slice(0, 6)}…${wallet.slice(-4)}` : ''} arrive
          in Telegram with a “Review &amp; approve” button, and you confirm them here with this passkey.
          You can close this page.
        </p>
      </div>
    );
  }

  const blocked = !env.supported || env.inApp;
  return (
    <div style={s.card}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>Set up this phone</h1>
      <p style={s.muted}>
        Create a passkey on this phone. Risky transactions will then need it: you&apos;ll see exactly what
        will execute, and confirm with your fingerprint or face.
      </p>
      {blocked && <p style={s.error}>{env.supported ? OPEN_IN_BROWSER : 'This browser doesn’t support passkeys. ' + OPEN_IN_BROWSER}</p>}
      <button onClick={create} disabled={state === 'working' || !prepared} style={s.primary(state === 'working' || !prepared)}>
        {state === 'working' ? 'Follow your phone’s prompt…' : prepared ? '🔐 Create passkey' : 'Preparing…'}
      </button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  );
}
