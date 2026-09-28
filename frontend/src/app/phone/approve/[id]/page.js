'use client';

// ── /phone/approve/<id>?t=… ──
// Opened on the phone from the Telegram "Review & approve" button. Shows what
// will execute — decoded by the server from the stored payload, not from the
// chat — and approving takes this phone's passkey. Its challenge is derived
// from the payload hash, so the signature commits to exactly what's shown.

import { Suspense, use, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import {
  reviewApproval, approvalPasskeyOptions, approveOnPhone, rejectOnPhone, phoneStyles as s,
  useBrowserEnv, passkeyErrorMessage, OPEN_IN_BROWSER,
} from '@/lib/phone';

export default function PhoneApprovePage({ params }) {
  const { id } = use(params);
  return (
    <main style={s.page}>
      <span style={s.brand}>Orchestra</span>
      <Suspense fallback={<p style={s.muted}>Loading…</p>}>
        <Review id={id} />
      </Suspense>
    </main>
  );
}

const SETTLED_TEXT = {
  rejected: '🚫 Rejected. Nothing was executed.',
  expired: '⌛ This approval expired. Nothing was executed. Ask Orchestra again.',
  executing: '⏳ Approved. Executing…',
};

function Review({ id }) {
  const t = useSearchParams().get('t');
  const [data, setData] = useState(null); // { review, status, ... }
  const [busy, setBusy] = useState(null); // 'approve' | 'reject' | null
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { txHash, explorerUrl }
  // Passkey options are fetched as soon as the approval is pending, so the prompt
  // fires straight from the tap (mobile Safari refuses it after an await).
  const [authOptions, setAuthOptions] = useState(null);
  const { inApp } = useBrowserEnv();

  const load = useCallback(() => {
    if (!t) return;
    reviewApproval(id, t).then(setData).catch((err) => setError(err.message));
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (data?.status !== 'pending' || authOptions || !t) return;
    approvalPasskeyOptions(id, t).then(setAuthOptions).catch((err) => setError(err.message));
  }, [data?.status, authOptions, id, t]);

  if (!t) return <p style={s.error}>This link is incomplete. Open it from the Telegram message again.</p>;
  if (!data) return error ? <p style={s.error}>{error}</p> : <p style={s.muted}>Loading the transaction…</p>;

  const { review } = data;
  const status = result ? 'executed' : data.status;

  const approve = async () => {
    setBusy('approve');
    setError(null);
    try {
      const optionsJSON = authOptions ?? (await approvalPasskeyOptions(id, t));
      const response = await startAuthentication({ optionsJSON });
      setBusy('executing');
      setResult(await approveOnPhone(id, t, response));
    } catch (err) {
      setError(`${passkeyErrorMessage(err, 'passkey check')} Nothing was executed.`);
      setAuthOptions(null); // refetch: the server hands back the same challenge until an attempt uses it
      load();
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy('reject');
    setError(null);
    try {
      await rejectOnPhone(id, t);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div style={s.card}>
        <span style={{ fontSize: 12, color: '#FFB400', letterSpacing: 0.3 }}>⚠️ APPROVAL NEEDED</span>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: review.decoded ? '#E8E4DE' : '#FF453A' }}>{review.title}</h1>
        {review.details.map((d) => (
          <div key={d.label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12, color: '#777', textTransform: 'capitalize' }}>{d.label}</span>
            <span style={d.mono
              ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 14, wordBreak: 'break-all', color: '#E8E4DE' }
              : { fontSize: 15, color: '#E8E4DE' }}>
              {d.value}
            </span>
          </div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 12, color: '#777' }}>From</span>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, wordBreak: 'break-all', color: '#bbb' }}>
            Your Safe {review.safeAddress} · {review.network}
          </span>
        </div>
        <p style={{ ...s.muted, borderTop: '1px solid #222228', paddingTop: 10 }}>
          <b style={{ color: '#bbb' }}>Why you’re asked:</b> {review.why}
        </p>
        <p style={{ ...s.muted, fontSize: 11, color: '#666' }}>
          Expires {new Date(review.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ref {review.ref}
        </p>
      </div>

      {status === 'executed' && (
        <div style={s.card}>
          <p style={s.ok}>✓ Approved and executed.</p>
          {(result?.explorerUrl || data.explorerUrl) && (
            <a href={result?.explorerUrl || data.explorerUrl} target="_blank" rel="noreferrer" style={{ color: '#30D158', fontSize: 14 }}>
              View on Etherscan ↗
            </a>
          )}
        </div>
      )}
      {status === 'failed' && <p style={s.error}>❌ Approved, but execution failed: {data.error || 'unknown error'}</p>}
      {SETTLED_TEXT[status] && <p style={status === 'executing' ? s.muted : s.error}>{SETTLED_TEXT[status]}</p>}

      {status === 'pending' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {inApp && <p style={s.error}>{OPEN_IN_BROWSER}</p>}
          {!review.decoded && <p style={s.error}>This transaction couldn’t be decoded. Reject it unless you know exactly what it is.</p>}
          <button onClick={approve} disabled={!!busy} style={s.primary(busy === 'approve' || busy === 'executing')}>
            {busy === 'approve' ? 'Confirm with your passkey…' : busy === 'executing' ? '⏳ Approved. Executing…' : '🔐 Approve with passkey'}
          </button>
          <button onClick={reject} disabled={!!busy} style={s.secondary}>
            {busy === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      )}
      {error && <p style={s.error}>{error}</p>}
    </>
  );
}
