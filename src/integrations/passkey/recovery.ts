// ─── Passkey recovery — replace a lost passkey after email-backup sign-in (ORC-118) ───
// A user who lost their only authenticator can still sign in with the email backup (ORC-58),
// but adding another passkey normally needs a check with an existing one — which they no
// longer have. Recovery is the way through, and it fails closed:
//   1. a fresh email code (same proof as the first passkey), then
//   2a. Telegram confirmation when Telegram is linked (new passkey is active at once), or
//   2b. a 48h delay when it isn't (new passkey is stored but can't approve until then).
// Notices go to Telegram when linked; email notices need a mail sender we don't have yet
// (reported in the PR — this module only records what would be emailed).
// Cancel is available on /simple and in Telegram at every stage.
// Pure decisions are exported and tested; storage holds the in-flight recovery only.

import { read, write, deleteKey } from "../zero-g/storage";

/** User-facing recovery failure: status + code for the bridge (ORC-118). */
export class RecoveryError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** How long a replacement passkey stays unable to approve, when Telegram isn't linked. */
export const RECOVERY_DELAY_MS = 48 * 60 * 60 * 1000;
/** How long a recovery grant (after OTP / Telegram confirm) can be used to register. */
export const RECOVERY_GRANT_TTL_MS = 15 * 60_000;

export type RecoveryMode = "telegram" | "delay";

export type RecoveryRecord =
  | {
      status: "awaiting_telegram";
      startedAt: string;
      /** Set when the confirm/cancel message was sent. */
      telegramMessageId?: number;
    }
  | {
      status: "granted";
      mode: RecoveryMode;
      grantedAt: string;
      expiresAt: string;
    }
  | {
      status: "pending";
      mode: "delay";
      credId: string;
      pendingUntil: string;
      startedAt: string;
      /** What we would email the user; the bridge logs this until a mail sender exists. */
      emailNotice?: string;
    };

const key = (wallet: string) => `passkey-recovery:${wallet.toLowerCase()}`;

async function readRec(wallet: string): Promise<RecoveryRecord | null> {
  const r = (await read(key(wallet))) as RecoveryRecord | null;
  if (!r || typeof r !== "object" || !("status" in r)) return null;
  return r;
}

async function writeRec(wallet: string, rec: RecoveryRecord): Promise<void> {
  await write(key(wallet), rec);
}

export async function clearRecovery(wallet: string): Promise<void> {
  await deleteKey(key(wallet));
}

/** Is this credential allowed to approve right now? Pending replacements are not. */
export function isCredActive(cred: { pendingUntil?: string }, now = Date.now()): boolean {
  if (!cred.pendingUntil) return true;
  const t = Date.parse(cred.pendingUntil);
  return Number.isFinite(t) && t <= now;
}

/** Plain label for the /simple button, mentioning the 48h wait when it applies. */
export function recoveryOfferLabel(telegramLinked: boolean): string {
  return telegramLinked
    ? "Lost your passkey? Add a new one (confirm on Telegram)"
    : "Lost your passkey? Add a new one (48h wait)";
}

export function recoveryHelp(telegramLinked: boolean): string {
  return telegramLinked
    ? "We'll email you a code, then ask you to confirm on Telegram. Once you confirm, the new passkey can approve right away."
    : "We'll email you a code, then you'll add a passkey on this device. It can't approve anything for 48 hours (cancel anytime). Link Telegram for a faster confirm next time.";
}

/** The view the bridge returns for GET /passkey/recovery. */
export function recoveryView(
  rec: RecoveryRecord | null,
  { telegramLinked, hasPasskey, now = Date.now() }: { telegramLinked: boolean; hasPasskey: boolean; now?: number },
) {
  // Recovery is only for accounts that already have a passkey they can't use; first passkey uses the normal flow.
  const offered = !!hasPasskey;
  if (!rec) {
    return {
      offered,
      status: "none" as const,
      mode: telegramLinked ? ("telegram" as const) : ("delay" as const),
      label: recoveryOfferLabel(telegramLinked),
      help: recoveryHelp(telegramLinked),
    };
  }
  if (rec.status === "awaiting_telegram") {
    return {
      offered,
      status: "awaiting_telegram" as const,
      mode: "telegram" as const,
      startedAt: rec.startedAt,
      label: "Waiting for your confirmation on Telegram…",
      help: "Open Telegram and press Confirm. If this wasn't you, press Cancel there or here.",
    };
  }
  if (rec.status === "granted") {
    const expired = Date.parse(rec.expiresAt) <= now;
    if (expired) {
      return {
        offered,
        status: "none" as const,
        mode: telegramLinked ? ("telegram" as const) : ("delay" as const),
        label: recoveryOfferLabel(telegramLinked),
        help: recoveryHelp(telegramLinked),
        expired: true,
      };
    }
    return {
      offered,
      status: "granted" as const,
      mode: rec.mode,
      expiresAt: rec.expiresAt,
      label: rec.mode === "telegram"
        ? "Telegram confirmed. Add your new passkey now."
        : "Email confirmed. Add your new passkey now (48h wait before it can approve).",
      help: rec.mode === "delay"
        ? "After you add it, it stays inactive for 48 hours. You can cancel it anytime on this page or on Telegram."
        : "This passkey will be able to approve as soon as it's added.",
    };
  }
  // pending
  const ready = Date.parse(rec.pendingUntil) <= now;
  return {
    offered,
    status: ready ? ("ready" as const) : ("pending" as const),
    mode: "delay" as const,
    credId: rec.credId,
    pendingUntil: rec.pendingUntil,
    startedAt: rec.startedAt,
    label: ready
      ? "Your replacement passkey is now active."
      : `Replacement passkey waiting until ${new Date(rec.pendingUntil).toLocaleString()} (cancel anytime)`,
    help: ready
      ? "It can approve transactions. You can remove your old unused passkeys once you have this one."
      : "It can't approve anything yet. Telegram approvals still work. Cancel if this wasn't you.",
  };
}

/**
 * After a fresh email code was spent: open recovery. Telegram-linked → wait for confirm;
 * otherwise → a short-lived grant to register a delayed passkey.
 */
export async function startRecovery(
  wallet: string,
  { telegramLinked, now = Date.now() }: { telegramLinked: boolean; now?: number },
): Promise<RecoveryRecord> {
  const existing = await readRec(wallet);
  if (existing && existing.status === "pending") {
    throw new RecoveryError(409, "A replacement passkey is already waiting. Cancel it first if you want to start over.", "recovery_pending")
  }
  if (existing && existing.status === "awaiting_telegram") {
    throw new RecoveryError(409, "We're already waiting for your confirmation on Telegram. Confirm or cancel there, or cancel here.", "recovery_awaiting_telegram")
  }
  if (existing && existing.status === "granted" && Date.parse(existing.expiresAt) > now) {
    throw new RecoveryError(409, "You already confirmed. Add your new passkey now, or cancel and start over.", "recovery_granted")
  }

  if (telegramLinked) {
    const rec: RecoveryRecord = { status: "awaiting_telegram", startedAt: new Date(now).toISOString() };
    await writeRec(wallet, rec);
    return rec;
  }
  const rec: RecoveryRecord = {
    status: "granted",
    mode: "delay",
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RECOVERY_GRANT_TTL_MS).toISOString(),
  };
  await writeRec(wallet, rec);
  return rec;
}

export async function setTelegramMessageId(wallet: string, messageId: number): Promise<void> {
  const rec = await readRec(wallet);
  if (!rec || rec.status !== "awaiting_telegram") return;
  await writeRec(wallet, { ...rec, telegramMessageId: messageId });
}

/** Telegram Confirm: turn awaiting_telegram into a short-lived grant (no delay). */
export async function confirmRecoveryTelegram(wallet: string, now = Date.now()): Promise<RecoveryRecord> {
  const rec = await readRec(wallet);
  if (!rec || rec.status !== "awaiting_telegram") {
    throw new RecoveryError(404, "There's nothing to confirm right now.", "recovery_not_awaiting")
  }
  const next: RecoveryRecord = {
    status: "granted",
    mode: "telegram",
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RECOVERY_GRANT_TTL_MS).toISOString(),
  };
  await writeRec(wallet, next);
  return next;
}

/** A live grant the registration flow may use (single-check; does not consume). */
export async function peekRecoveryGrant(wallet: string, now = Date.now()): Promise<{ mode: RecoveryMode } | null> {
  const rec = await readRec(wallet);
  if (!rec || rec.status !== "granted") return null;
  if (Date.parse(rec.expiresAt) <= now) {
    await clearRecovery(wallet);
    return null;
  }
  return { mode: rec.mode };
}

/**
 * After a successful WebAuthn registration under a recovery grant: either clear (Telegram,
 * passkey is active) or mark pending with the 48h delay.
 */
export async function completeRecoveryRegistration(
  wallet: string,
  credId: string,
  { now = Date.now() }: { now?: number } = {},
): Promise<{ mode: RecoveryMode; pendingUntil?: string; emailNotice?: string }> {
  const rec = await readRec(wallet);
  if (!rec || rec.status !== "granted") {
    throw new RecoveryError(400, "The recovery step expired. Start again with a fresh email code.", "recovery_expired")
  }
  if (Date.parse(rec.expiresAt) <= now) {
    await clearRecovery(wallet);
    throw new RecoveryError(400, "The recovery step expired. Start again with a fresh email code.", "recovery_expired")
  }
  if (rec.mode === "telegram") {
    await clearRecovery(wallet);
    return { mode: "telegram" };
  }
  const pendingUntil = new Date(now + RECOVERY_DELAY_MS).toISOString();
  const emailNotice =
    `A new passkey was added to your Orchestra account. It can't approve anything until ${new Date(pendingUntil).toUTCString()} (48 hours). ` +
    `If this wasn't you, open Orchestra → Passkeys and press Cancel, or cancel in Telegram if linked.`;
  await writeRec(wallet, {
    status: "pending",
    mode: "delay",
    credId,
    pendingUntil,
    startedAt: new Date(now).toISOString(),
    emailNotice,
  });
  return { mode: "delay", pendingUntil, emailNotice };
}

export async function getRecovery(wallet: string): Promise<RecoveryRecord | null> {
  return readRec(wallet);
}

/** Cancel at any stage. Returns the pending cred id when one must be removed from the wallet. */
export async function cancelRecovery(wallet: string): Promise<{ pendingCredId?: string }> {
  const rec = await readRec(wallet);
  await clearRecovery(wallet);
  if (rec && rec.status === "pending") return { pendingCredId: rec.credId };
  return {};
}

/** Test hook. */
export async function _resetRecovery(wallet: string): Promise<void> {
  await clearRecovery(wallet);
}
