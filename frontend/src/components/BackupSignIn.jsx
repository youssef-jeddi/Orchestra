'use client';

// "Add a backup sign-in" (ORC-58): the account's sign-in methods, a button to link an email through
// Privy, and a one-time nudge for passkey-only users once money is in their account. Mounted only
// under PrivyProvider (NEXT_PUBLIC_PRIVY_APP_ID set) and only for users signed in through Privy's
// embedded wallet: a MetaMask or Ledger user's way back in is their own wallet's recovery phrase.
//
// Linking adds a login method to the same Privy user, so signing in later with that email lands on
// the same user, the same embedded wallet and so the same account (the Safe it owns).

import { useEffect, useMemo, useState } from 'react';
import { usePrivy, useLinkAccount } from '@privy-io/react-auth';
import {
  linkedMethods, isPasskeyOnly, canLinkEmail, nudgeMemory, shouldNudge, linkError,
  NUDGE_TITLE, NUDGE_TEXT, BACKUP_HELP, LINKED_EMAIL_OK,
} from '@/lib/backupSignIn';

export default function BackupSignIn({ wallet, funded, showPanel, onClosePanel, buttonStyle, pillStyle }) {
  const { user } = usePrivy();
  const accounts = user?.linkedAccounts || [];
  const [notice, setNotice] = useState(null); // { ok, text }
  const [dismissed, setDismissed] = useState(false);
  const { linkEmail } = useLinkAccount({
    onSuccess: ({ linkMethod }) => {
      if (linkMethod === 'email') setNotice({ ok: true, text: LINKED_EMAIL_OK });
      setDismissed(true);
    },
    onError: (code) => {
      const text = linkError(code);
      if (text) setNotice({ ok: false, text });
    },
  });

  const passkeyOnly = isPasskeyOnly(accounts);

  // Once per wallet on this browser: shown the first time the account holds money (read when the
  // wallet signs in, so it stays up for this visit until dismissed), never again after that.
  const seenBefore = useMemo(
    () => (wallet && typeof window !== 'undefined' ? nudgeMemory(window.localStorage).seen(wallet) : true),
    [wallet],
  );
  const nudge = !dismissed && shouldNudge({ passkeyOnly, funded, seen: seenBefore });
  useEffect(() => { if (nudge) nudgeMemory(window.localStorage).markSeen(wallet); }, [nudge, wallet]);
  const dismiss = () => setDismissed(true);

  const addEmail = () => { setNotice(null); linkEmail(); };
  const rows = linkedMethods(accounts);
  const emailLinkable = canLinkEmail(accounts);

  return (
    <>
      {nudge && (
        <div role="status" style={{ marginTop: 12, padding: '10px 12px', border: '1px solid rgba(192,132,252,0.35)', borderRadius: 12, background: 'rgba(192,132,252,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, color: '#E8E4DE' }}>🛟 {NUDGE_TITLE}</span>
            <button onClick={dismiss} title="Not now" aria-label="Dismiss"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
          <p style={{ margin: '6px 0 10px', fontSize: 13, color: '#B9B5AE', lineHeight: 1.5 }}>{NUDGE_TEXT}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={addEmail} style={buttonStyle(false)}>Add my email</button>
            <button onClick={dismiss} style={pillStyle(false)}>Not now</button>
          </div>
        </div>
      )}

      {showPanel && (
        <div style={{ marginTop: 12, padding: '10px 12px', border: '1px solid #1c1c22', borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: '#999' }}>How you sign in</span>
            <button onClick={onClosePanel} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
          {rows.length === 0 && <p style={{ fontSize: 12, color: '#555', margin: 0 }}>Loading…</p>}
          {rows.map((r) => (
            <div key={`${r.type}:${r.detail}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '1px solid #1c1c22' }}>
              <span style={{ fontSize: 13, color: '#E8E4DE' }}>✓ {r.name}</span>
              {r.detail && <span style={{ fontSize: 12, color: '#8d8a84' }}>{r.detail}</span>}
            </div>
          ))}
          {emailLinkable ? (
            <>
              <p style={{ margin: '8px 0', fontSize: 12, color: '#8d8a84', lineHeight: 1.5 }}>{BACKUP_HELP}</p>
              <button onClick={addEmail} style={{ ...pillStyle(false), fontSize: 12, padding: '5px 12px' }}
                title="Link an email to this account: you'll get a code to confirm it">
                + Add a backup sign-in (email)
              </button>
            </>
          ) : (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: '#8d8a84', lineHeight: 1.5 }}>
              Lost this device? Sign in with your email and you&apos;ll find the same account.
            </p>
          )}
        </div>
      )}

      {notice && (
        <div role={notice.ok ? 'status' : 'alert'} style={{ marginTop: 8, display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.5,
          color: notice.ok ? '#30D158' : '#FF453A', border: `1px solid ${notice.ok ? '#30D15844' : '#FF453A44'}`, borderRadius: 10, padding: '8px 12px',
          background: notice.ok ? '#30D15811' : '#FF453A11' }}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      )}
    </>
  );
}
