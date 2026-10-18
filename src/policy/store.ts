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
import type { PolicyProfile, ActivityRecord } from "./index";

const PROFILE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_RETENTION_MS = 2 * DAY_MS; // keep a little more than the 24h window

const profileCache = new Map<string, { value: PolicyProfile; expires: number }>();
const activityCache = new Map<string, ActivityRecord[]>();

/** Before policies were per wallet, one global record held everyone's. */
const LEGACY_PROFILE_KEY = "user:profile";
const profileKey = (wallet: string) => `user:profile:${wallet.toLowerCase()}`;

/**
 * A wallet's stored profile (`user:profile:<wallet>`), falling back to the
 * legacy global record until the wallet saves its own. Read-only fallback:
 * writes always go to the wallet's own key.
 */
export async function readUserProfile(wallet: string): Promise<Record<string, any>> {
  try {
    const own = (await read(profileKey(wallet))) as any;
    if (own && typeof own === "object") return own;
    const legacy = (await read(LEGACY_PROFILE_KEY)) as any;
    return legacy && typeof legacy === "object" ? legacy : {};
  } catch {
    return {};
  }
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
  const key = wallet.toLowerCase();
  const now = Date.now();
  const hit = profileCache.get(key);
  if (hit && hit.expires > now) return hit.value;

  const p = await readUserProfile(key);
  const stored = p.policy && typeof p.policy === "object" ? (p.policy as PolicyProfile) : {};
  // `policy.knownAddresses` may have been written through the API (older versions accepted any
  // field): ignore it and use only what the server recorded itself.
  const value: PolicyProfile = { ...stored, knownAddresses: recipientsOf(p) };
  profileCache.set(key, { value, expires: now + PROFILE_TTL_MS });
  return value;
}

/** Recent (trailing 24h) auto-approved activity for a wallet. */
export async function getRecentActivity(wallet: string): Promise<ActivityRecord[]> {
  const key = wallet.toLowerCase();
  let list = activityCache.get(key);
  if (!list) {
    try {
      const rows = (await readMany(`activity:${key}`)) as any[];
      list = (rows || []).filter(
        (r) => r && typeof r.at === "string" && typeof r.valueUsd === "number"
      );
    } catch {
      list = [];
    }
    activityCache.set(key, list);
  }
  const cutoff = Date.now() - DAY_MS;
  return list.filter((r) => {
    const t = Date.parse(r.at);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

/** Record an auto-approved action (write-through: memory now, 0G async). */
export async function recordActivity(wallet: string, rec: ActivityRecord): Promise<void> {
  const key = wallet.toLowerCase();
  if (!activityCache.has(key)) await getRecentActivity(key); // seed from 0G first
  const list = activityCache.get(key) || [];

  list.push(rec);

  // Trim to retention window so the in-memory list can't grow unbounded.
  const cutoff = Date.now() - ACTIVITY_RETENTION_MS;
  const trimmed = list.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isNaN(t) || t >= cutoff;
  });
  activityCache.set(key, trimmed);

  append(`activity:${key}`, rec).catch(() => {});
}

/** Test hook — clears all caches. */
export function _resetPolicyStoreCache(): void {
  profileCache.clear();
  activityCache.clear();
}
