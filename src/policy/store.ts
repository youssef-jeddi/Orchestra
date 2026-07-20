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

import { read, readMany, append } from "../integrations/zero-g/storage";
import type { PolicyProfile, ActivityRecord } from "./index";

const PROFILE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_RETENTION_MS = 2 * DAY_MS; // keep a little more than the 24h window

let profileCache: { value: PolicyProfile; expires: number } | null = null;
const activityCache = new Map<string, ActivityRecord[]>();

/**
 * The user's extended policy config. Read from `user:profile.policy` in 0G.
 * Absent config → `{}` → every extended rule stays off (base behaviour).
 */
export async function getPolicyProfile(): Promise<PolicyProfile> {
  const now = Date.now();
  if (profileCache && profileCache.expires > now) return profileCache.value;

  let value: PolicyProfile = {};
  try {
    const p = (await read("user:profile")) as any;
    if (p && typeof p === "object" && p.policy && typeof p.policy === "object") {
      value = p.policy as PolicyProfile;
    }
  } catch {
    /* non-critical — fall back to empty policy */
  }
  profileCache = { value, expires: now + PROFILE_TTL_MS };
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
  profileCache = null;
  activityCache.clear();
}
