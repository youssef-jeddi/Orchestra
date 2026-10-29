// ── Passkey recovery UI helpers (ORC-118) ──
// Pure decisions for the /simple "lost my passkey" flow. Tested without a browser.

export const RECOVERY_EMAIL_PROMPT =
  "To replace a lost passkey, first we'll email you a code to check it's really you.";

/** Should the Passkeys panel offer recovery? Server says `offered` when the account already has a passkey. */
export const shouldOfferRecovery = (recovery) => !!recovery?.offered;

/** Show the cancel control for an in-flight or delayed recovery. */
export const canCancelRecovery = (recovery) =>
  !!recovery && ['awaiting_telegram', 'granted', 'pending'].includes(recovery.status);

/** Pending replacement that cannot approve yet. */
export const isPendingReplacement = (p) => !!p?.pendingUntil && p.active === false;

export function pendingLabel(p, now = Date.now()) {
  if (!p?.pendingUntil) return '';
  const t = Date.parse(p.pendingUntil);
  if (!Number.isFinite(t)) return 'Waiting…';
  if (t <= now) return 'Now active';
  const hours = Math.max(1, Math.ceil((t - now) / 3_600_000));
  return hours >= 24 ? `Active in ~${Math.ceil(hours / 24)} day(s)` : `Active in ~${hours}h`;
}
