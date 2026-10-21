'use client';

// ── Paused banner (/simple, ORC-39) ──
// Shown under the header while automatic actions are paused. The wallet's own pause offers Resume,
// which goes through the same proof as raising a limit (passkey, or a wallet signature without
// one); a pause for everyone has no button. Words live in lib/pause.js.

import { useState, useCallback } from 'react';
import { saveLimits } from '@/lib/limitsFlow';
import { confirmingText } from '@/lib/limits';
import { pauseBanner, pauseChange, PAUSE_TEXT } from '@/lib/pause';
import { HINT_COLOR } from '@/lib/contrast';

export default function PauseBanner({ ledger, status, onChange, buttonStyle }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const banner = pauseBanner(status);

  const resume = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const out = await saveLimits(ledger, pauseChange(false), (method) => setNote({ text: confirmingText(method, 'resume'), bad: false }));
      setNote(out.saved ? null : { text: 'Nothing was changed.', bad: false });
      onChange?.();
    } catch (err) {
      setNote({ text: err.message, bad: true });
    } finally {
      setBusy(false);
    }
  }, [ledger, onChange]);

  if (!banner) return null;
  return (
    <div role="status" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      border: '1px solid #FFB40055', borderRadius: 12, padding: '10px 14px', background: '#FFB40011' }}>
      <span style={{ fontSize: 13, color: '#FFB400', lineHeight: 1.5, flex: '1 1 260px' }}>⏸ {banner.text}</span>
      {banner.resume && (
        <button onClick={resume} disabled={busy} style={buttonStyle(busy)}>{busy ? PAUSE_TEXT.resuming : PAUSE_TEXT.resume}</button>
      )}
      {note && <span style={{ flexBasis: '100%', fontSize: 12, color: note.bad ? '#FF453A' : HINT_COLOR }}>{note.text}</span>}
    </div>
  );
}
