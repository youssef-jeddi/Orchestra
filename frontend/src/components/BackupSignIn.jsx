'use client';

// "Add a backup sign-in" (ORC-58): the account's sign-in methods, buttons to link an email or a
// passkey on another device through Privy, and a one-time nudge for passkey-only users once money is
// in their account. Mounted only under PrivyProvider (NEXT_PUBLIC_PRIVY_APP_ID set), for users
// signed in through Privy: with its embedded wallet (passkey, email, …), or with their own wallet
// (MetaMask through Privy), who only see their methods and that their recovery phrase is the backup.
// The dev-only preview (?previewBackup=1 on `next dev`) uses stand-in accounts and never calls Privy.
//
// Linking adds a login method to the same Privy user, so signing in later with that email (or that
// passkey) lands on the same user, the same embedded wallet and so the same account (the Safe it owns).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePrivy, useLinkAccount } from '@privy-io/react-auth';
import {
  linkedMethods, isPasskeyOnly, canLinkEmail, usesOwnWallet, nudgeMemory, shouldNudge, linkError,
  NUDGE_TITLE, NUDGE_TEXT, BACKUP_HELP, LINKED_EMAIL_OK, LINKED_PASSKEY_OK, PASSKEY_HELP, WALLET_USER_TEXT,
  PREVIEW_ACCOUNTS, PREVIEW_NOTE,
} from '@/lib/backupSignIn';

// Dev preview: what "linking" adds, until the page reloads. Nothing reaches Privy.
let previewAccounts = PREVIEW_ACCOUNTS;
const previewListeners = new Set();
const previewStore = {
  subscribe: (fn) => { previewListeners.add(fn); return () => previewListeners.delete(fn); },
  get: () => previewAccounts,
  add: (account) => { previewAccounts = [...previewAccounts, account]; previewListeners.forEach((fn) => fn()); },
};

export default function BackupSignIn({ preview, ...props }) {
  return preview ? <PreviewBackup {...props} /> : <PrivyBackup {...props} />;
}

function PrivyBackup(props) {
  const { user } = usePrivy();
  const [notice, setNotice] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(null); // 'email' | 'passkey' | null
  const kind = useRef('email'); // which link is open, for Privy's callbacks
  const [linked, setLinked] = useState(false);
  const { linkEmail, linkPasskey } = useLinkAccount({
    onSuccess: ({ linkMethod }) => {
      setBusy(null);
      setNotice({ ok: true, text: linkMethod === 'passkey' ? LINKED_PASSKEY_OK : LINKED_EMAIL_OK });
      setLinked(true);
    },
    onError: (code) => {
      setBusy(null);
      const text = linkError(code, kind.current);
      if (text) setNotice({ ok: false, text });
    },
  });
  const onLink = useCallback((k) => {
    setNotice(null);
    kind.current = k;
    setBusy(k);
    if (k === 'passkey') linkPasskey();
    else linkEmail();
  }, [linkEmail, linkPasskey]);
  return <BackupView {...props} accounts={user?.linkedAccounts || []} onLink={onLink} busy={busy}
    notice={notice} onNotice={setNotice} linked={linked} />;
}

function PreviewBackup(props) {
  const accounts = useSyncExternalStore(previewStore.subscribe, previewStore.get, previewStore.get);
  const [notice, setNotice] = useState(null);
  const [linked, setLinked] = useState(false);
  const onLink = useCallback((k) => {
    previewStore.add(k === 'passkey'
      ? { type: 'passkey', credentialId: `preview-${previewStore.get().length}` }
      : { type: 'email', address: 'you@example.com' });
    setNotice({ ok: true, text: `${k === 'passkey' ? LINKED_PASSKEY_OK : LINKED_EMAIL_OK} ${PREVIEW_NOTE}` });
    setLinked(true);
  }, []);
  // Always funded and never "seen" in the preview, so the nudge can be tried again after a reload.
  return <BackupView {...props} preview funded accounts={accounts} onLink={onLink} busy={null}
    notice={notice} onNotice={setNotice} linked={linked} />;
}

function BackupView({ wallet, funded, showPanel, onClosePanel, buttonStyle, pillStyle, accounts, onLink, busy, notice, onNotice, linked, preview }) {
  const [dismissed, setDismissed] = useState(false);
  const ownWallet = usesOwnWallet(accounts);
  const passkeyOnly = !ownWallet && isPasskeyOnly(accounts);

  // Once per wallet on this browser: shown the first time the account holds money (read when the
  // wallet signs in, so it stays up for this visit until dismissed), never again after that.
  const seenBefore = useMemo(
    () => (preview ? false : wallet && typeof window !== 'undefined' ? nudgeMemory(window.localStorage).seen(wallet) : true),
    [wallet, preview],
  );
  const nudge = !dismissed && !linked && shouldNudge({ passkeyOnly, funded, seen: seenBefore });
  useEffect(() => { if (nudge && !preview) nudgeMemory(window.localStorage).markSeen(wallet); }, [nudge, wallet, preview]);
  const dismiss = () => setDismissed(true);

  const rows = linkedMethods(accounts);
  const emailLinkable = canLinkEmail(accounts);
  const small = { ...pillStyle(false), fontSize: 12, padding: '5px 12px' };

  return (
    <>
      {nudge && (
        <div role="status" style={{ marginTop: 12, padding: '10px 12px', border: '1px solid rgba(192,132,252,0.35)', borderRadius: 12, background: 'rgba(192,132,252,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, color: '#E8E4DE' }}>🛟 {NUDGE_TITLE}{preview && <span style={{ color: '#C084FC', fontSize: 12 }}> (preview)</span>}</span>
            <button onClick={dismiss} title="Not now" aria-label="Dismiss"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
          <p style={{ margin: '6px 0 10px', fontSize: 13, color: '#B9B5AE', lineHeight: 1.5 }}>{NUDGE_TEXT}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onLink('email')} style={buttonStyle(false)}>Add my email</button>
            <button onClick={dismiss} style={pillStyle(false)}>Not now</button>
          </div>
        </div>
      )}

      {showPanel && (
        <div style={{ marginTop: 12, padding: '10px 12px', border: '1px solid #1c1c22', borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: '#999' }}>How you sign in</span>
            {preview && <span style={{ fontSize: 11, color: '#C084FC' }}>preview</span>}
            <button onClick={onClosePanel} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
          {rows.length === 0 && <p style={{ fontSize: 12, color: '#555', margin: 0 }}>Loading…</p>}
          {rows.map((r) => (
            <div key={`${r.type}:${r.detail}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '1px solid #1c1c22' }}>
              <span style={{ fontSize: 13, color: '#E8E4DE' }}>✓ {r.name}</span>
              {r.detail && <span style={{ fontSize: 12, color: '#8d8a84' }}>{r.detail}</span>}
            </div>
          ))}
          {ownWallet ? (
            // Their own wallet's recovery phrase is the backup; an email would sign them in without it.
            <p style={{ margin: '8px 0 0', fontSize: 12, color: '#8d8a84', lineHeight: 1.5 }}>{WALLET_USER_TEXT}</p>
          ) : (
            <>
              {emailLinkable ? (
                <>
                  <p style={{ margin: '8px 0', fontSize: 12, color: '#8d8a84', lineHeight: 1.5 }}>{BACKUP_HELP}</p>
                  <button onClick={() => onLink('email')} disabled={!!busy} style={small}
                    title="Link an email to this account: you'll get a code to confirm it">
                    {busy === 'email' ? 'Follow the steps in the window…' : '+ Add a backup sign-in (email)'}
                  </button>
                </>
              ) : (
                <p style={{ margin: '8px 0 0', fontSize: 12, color: '#8d8a84', lineHeight: 1.5 }}>
                  Lost this device? Sign in with your email and you&apos;ll find the same account.
                </p>
              )}
              <div style={{ marginTop: 8 }}>
                <button onClick={() => onLink('passkey')} disabled={!!busy} style={small} title={PASSKEY_HELP}>
                  {busy === 'passkey' ? 'Follow the passkey prompts…' : '+ Add a passkey on another device'}
                </button>
                <p style={{ margin: '6px 0 0', fontSize: 11, color: '#8d8a84', lineHeight: 1.5 }}>{PASSKEY_HELP}</p>
              </div>
            </>
          )}
        </div>
      )}

      {notice && (
        <div role={notice.ok ? 'status' : 'alert'} style={{ marginTop: 8, display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.5,
          color: notice.ok ? '#30D158' : '#FF453A', border: `1px solid ${notice.ok ? '#30D15844' : '#FF453A44'}`, borderRadius: 10, padding: '8px 12px',
          background: notice.ok ? '#30D15811' : '#FF453A11' }}>
          <span>{notice.text}</span>
          <button onClick={() => onNotice(null)} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      )}
    </>
  );
}
