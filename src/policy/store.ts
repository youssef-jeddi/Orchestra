// ─── Policy store — cached 0G adapter ───
// Impure companion to the pure engine in ./index. Sources the PolicyProfile and
// recent activity the extended rules need, from 0G, behind an in-memory cache so
// they don't become a per-request round-trip on the /intent hot path.
//
// Consistency model: single bridge instance. Activity is kept in-memory
// (authoritative for the process) and mirrored to 0G for durability across
// restarts — write-through, so a burst of auto-approvals sees its own prior
// records immediately (velocity stays correct). A multi-instance deployment
// would need a shared store (see the "Lightweight DB" option).

import { read, write, readMany, append } from "../integrations/zero-g/storage";
import type { PolicyProfile, ActivityRecord, ActivitySource, PauseInfo } from "./index";
import { injectFault } from "../utils/faultInject";
import { withTimeout } from "../utils/rpc";
import { safeErr } from "../utils/redact";

const PROFILE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_RETENTION_MS = 2 * DAY_MS; // keep a little more than the 24h window

const profileCache = new Map<string, { value: PolicyProfile; expires: number }>();
const activityCache = new Map<string, ActivityRecord[]>();
/** Spend recorded while the history couldn't be loaded; merged in on the next successful load. */
const unsynced = new Map<string, ActivityRecord[]>();
/**
 * Spends whose storage write failed (ORC-40 fix C). Memory still counts them, but a restart would
 * forget them and the day's total would read too low, so the wallet's automatic actions stay
 * paused (see hasUnsavedSpend) until a retry saves them.
 */
const unsaved = new Map<string, ActivityRecord[]>();

const profileKey = (wallet: string) => `user:profile:${wallet.toLowerCase()}`;

/**
 * A wallet's stored profile (`user:profile:<wallet>`); `{}` until it has one, which means the
 * safe defaults. A storage error is NOT "no profile": it throws, so no caller falls back to the
 * $100 default for a wallet that lowered its limit, or saves an empty profile over the real one.
 * Before policies were per wallet, one shared `user:profile` record held everyone's;
 * it is never read here: a new wallet must not start with someone else's daily limit or recipients,
 * and nothing is copied from it into a wallet's own record.
 */
export async function readUserProfile(wallet: string): Promise<Record<string, any>> {
  await injectFault("profile-read");
  const own = (await read(profileKey(wallet))) as any; // null only when nothing was ever saved
  return own && typeof own === "object" ? own : {};
}

export async function writeUserProfile(wallet: string, profile: Record<string, any>): Promise<void> {
  await write(profileKey(wallet), profile);
  profileCache.delete(wallet.toLowerCase());
}

/** Per-wallet queue, so two read-modify-write updates of one profile can't overwrite each other. */
const profileLocks = new Map<string, Promise<unknown>>();

/**
 * Read a wallet's profile, change it and save it, one update at a time. Without the queue a
 * recorded recipient and a limit change racing each other could drop one of the two writes.
 */
export async function updateUserProfile(wallet: string, change: (profile: Record<string, any>) => Record<string, any>): Promise<Record<string, any>> {
  const key = wallet.toLowerCase();
  const run = (profileLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const next = change(await readUserProfile(key));
    await writeUserProfile(key, next);
    return next;
  });
  profileLocks.set(key, run);
  return run;
}

/**
 * The wallet's own pause from its stored profile (ORC-39). Missing means not paused; `{ on: false }`
 * means resumed; `{ on: true }` is a pause; anything else (an old or damaged value) can't be trusted
 * to mean "on", so it counts as paused too.
 */
export function walletPauseOf(profile: Record<string, any>): PauseInfo | null {
  const v = profile?.autoPause;
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && v.on === false) return null;
  return { scope: "wallet", cause: typeof v === "object" && v.on === true ? "user" : "unreadable" };
}

// ── Known recipients: addresses the account has actually sent to ──
// Written only by the server, in a field of its own (`knownRecipients`), never under `policy`:
// `policy` can be patched through the API, so an address list kept there could be filled in by
// a session. The unknown-recipient rule asks before the first send to anything not in this list.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The recipients saved for a wallet (lowercased), from its profile object. */
export function recipientsOf(profile: Record<string, any>): string[] {
  const list = Array.isArray(profile.knownRecipients) ? profile.knownRecipients : [];
  return [...new Set(list.filter((a: unknown): a is string => typeof a === "string" && ADDRESS.test(a)).map((a: string) => a.toLowerCase()))];
}

export async function getKnownRecipients(wallet: string): Promise<string[]> {
  return recipientsOf(await readUserProfile(wallet));
}

/** Remember an address after a send to it actually went through. */
export async function recordKnownRecipient(wallet: string, address: string): Promise<void> {
  if (!ADDRESS.test(address)) return;
  await updateUserProfile(wallet, (p) => {
    const known = recipientsOf(p);
    const lower = address.toLowerCase();
    return known.includes(lower) ? p : { ...p, knownRecipients: [...known, lower] };
  });
}

/** Forget an address: the next send to it asks again. Returns the remaining list. */
export async function removeKnownRecipient(wallet: string, address: string): Promise<string[]> {
  const next = await updateUserProfile(wallet, (p) => ({ ...p, knownRecipients: recipientsOf(p).filter((a) => a !== String(address).toLowerCase()) }));
  return recipientsOf(next);
}

/**
 * A wallet's extended policy config (`policy` of its profile) plus the recipients the server
 * recorded. No wallet → `{}`; with none recorded, every send to a new address asks.
 */
export async function getPolicyProfile(wallet?: string): Promise<PolicyProfile> {
  if (!wallet) return {};
  await injectFault("profile-read");
  await injectFault("profile-timeout");
  const key = wallet.toLowerCase();
  const now = Date.now();
  const hit = profileCache.get(key);
  if (hit && hit.expires > now) return hit.value;

  const p = await readUserProfile(key);
  const stored = p.policy && typeof p.policy === "object" ? (p.policy as PolicyProfile) : {};
  // `policy.knownAddresses` may have been written through the API (older versions accepted any
  // field): ignore it and use only what the server recorded itself.
  // `paused` is set last, from the server's own field, so a stale `policy.paused` can't override it.
  const value: PolicyProfile = { ...stored, knownAddresses: recipientsOf(p), paused: walletPauseOf(p) };
  profileCache.set(key, { value, expires: now + PROFILE_TTL_MS });
  return value;
}

/** Recent (trailing 24h) recorded activity for a wallet. */
export async function getRecentActivity(wallet: string): Promise<ActivityRecord[]> {
  const key = wallet.toLowerCase();
  let list = activityCache.get(key);
  if (!list) {
    await injectFault("activity-read");
    await injectFault("activity-timeout");
    // A failed load throws and is not cached: an empty list would read as "nothing spent today".
    const rows = (await readMany(`activity:${key}`)) as any[];
    const loaded = (rows || []).filter(
      (r) => r && typeof r.at === "string" && typeof r.valueUsd === "number"
    );
    const missed = (unsynced.get(key) ?? []).filter((u) => !loaded.some((r) => r.at === u.at && r.valueUsd === u.valueUsd));
    list = [...loaded, ...missed];
    unsynced.delete(key);
    activityCache.set(key, list);
  }
  const cutoff = Date.now() - DAY_MS;
  return list.filter((r) => {
    const t = Date.parse(r.at);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

/**
 * One activity row for a spend that actually moved funds (auto-exec, an approved action, or —
 * when wired — an owner-signed over-cap send). Shared so each path records the same shape once.
 */
export function spendActivity(input: {
  valueUsd: number;
  to?: string | null;
  token?: string | null;
  txHash?: string | null;
  explorerUrl?: string | null;
  source?: ActivitySource;
  at?: string;
}): ActivityRecord {
  const rec: ActivityRecord = { valueUsd: input.valueUsd, at: input.at ?? new Date().toISOString() };
  if (input.to) rec.to = input.to;
  if (input.token) rec.token = input.token;
  if (input.txHash) rec.txHash = input.txHash;
  if (input.explorerUrl) rec.explorerUrl = input.explorerUrl;
  if (input.source) rec.source = input.source;
  return rec;
}

/** Record a spend that executed (write-through: memory now, 0G async). */
export async function recordActivity(wallet: string, rec: ActivityRecord): Promise<void> {
  const key = wallet.toLowerCase();
  if (!activityCache.has(key)) await getRecentActivity(key).catch(() => {}); // seed from storage first
  const list = activityCache.get(key);
  if (!list) {
    // The history can't be read right now: keep this spend aside so it still counts once it can.
    unsynced.set(key, [...(unsynced.get(key) ?? []), rec]);
    saveSpend(key, rec);
    return;
  }

  list.push(rec);

  // Trim to retention window so the in-memory list can't grow unbounded.
  const cutoff = Date.now() - ACTIVITY_RETENTION_MS;
  const trimmed = list.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isNaN(t) || t >= cutoff;
  });
  activityCache.set(key, trimmed);

  saveSpend(key, rec);
}

/** Write one spend to storage; a failure keeps it in `unsaved`, which pauses the wallet's automatic actions. */
function saveSpend(key: string, rec: ActivityRecord): void {
  (async () => {
    await injectFault("activity-write");
    await append(`activity:${key}`, rec);
  })().catch((err) => {
    console.error(`[policy] couldn't save a spend record (${safeErr(err)}); automatic actions are paused for this wallet until it is saved`);
    unsaved.set(key, [...(unsaved.get(key) ?? []), rec]);
  });
}

/** A spend of this wallet couldn't be saved yet: its automatic actions are paused (ORC-40 fix C). */
export function hasUnsavedSpend(wallet: string): boolean {
  return (unsaved.get(wallet.toLowerCase())?.length ?? 0) > 0;
}

const retrying = new Map<string, Promise<void>>();

/**
 * Try again to save the wallet's unsaved spends, in order; the ones that still fail stay (and the
 * wallet stays paused). One retry per wallet at a time, so two requests don't write a row twice.
 * Never rejects.
 */
export function retryUnsavedSpends(wallet: string): Promise<void> {
  const key = wallet.toLowerCase();
  if (!unsaved.get(key)?.length) return Promise.resolve();
  const running = retrying.get(key);
  if (running) return running;
  const run = (async () => {
    for (const rec of [...(unsaved.get(key) ?? [])]) {
      try {
        await injectFault("activity-write");
        await append(`activity:${key}`, rec);
        unsaved.set(key, (unsaved.get(key) ?? []).filter((r) => r !== rec));
      } catch {
        return; // still failing: keep the rest for the next try
      }
    }
    if (!unsaved.get(key)?.length) {
      unsaved.delete(key);
      console.log("[policy] unsaved spend records are now saved; automatic actions resume for this wallet");
    }
  })().finally(() => retrying.delete(key));
  retrying.set(key, run);
  return run;
}

/** What the limit rules need for one request; `ok: false` when either part couldn't be read in time. */
export type PolicyInputs = { ok: true; profile: PolicyProfile; activity: ActivityRecord[] | undefined } | { ok: false };

/**
 * Read the wallet's profile and recent activity together, for /intent. Never rejects, and an error
 * or a timeout is `ok: false`, never an empty profile or an empty history: nothing that depends on
 * the daily limit or the daily total may run without both.
 */
export async function readPolicyInputs(wallet: string | undefined, timeoutMs = 2_000): Promise<PolicyInputs> {
  if (!wallet) return { ok: true, profile: {}, activity: undefined };
  // A spend that couldn't be saved earlier gets another try first; while it stays unsaved the
  // wallet is paused (hasUnsavedSpend), so a failure here doesn't stop the read.
  const inputs = retryUnsavedSpends(wallet).then(() => Promise.all([getPolicyProfile(wallet), getRecentActivity(wallet)])).then(
    ([profile, activity]): PolicyInputs => ({ ok: true, profile, activity }),
    (err): PolicyInputs => { console.error(`[policy] couldn't read limits or activity: ${safeErr(err)}`); return { ok: false }; },
  );
  return withTimeout(inputs, timeoutMs, { ok: false } as PolicyInputs);
}

/** Test hook — clears all caches. */
export function _resetPolicyStoreCache(): void {
  profileCache.clear();
  activityCache.clear();
  unsynced.clear();
  unsaved.clear();
}
