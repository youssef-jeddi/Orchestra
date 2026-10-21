// ─── Policy — kill switch for automatic actions (ORC-39) ───
// One action stops everything the agent would do on its own, either for everyone (the global
// switch: the admin endpoint or an admin Telegram chat) or for one wallet (its owner, from
// Telegram /pause or the Limits sheet). While a switch is on, `decide` turns every automatic
// action into a request for the owner's OK; approvals, owner-signed sends and deposits are
// unaffected, and what would be refused is still refused.
//
// It fails closed: a global flag that can't be read (at startup or later) counts as paused, and so
// does a wallet flag that isn't exactly on or off. Turning a pause on is applied in memory first
// and then saved (a failed save still pauses this process); turning it off is saved first and only
// then applied (a failed save leaves it paused). Resuming a wallet needs the owner's proof, like
// raising a limit (see limits.ts); pausing never does.
//
// Every change is kept in an audit list (`audit:killswitch:global`, `audit:killswitch:<wallet>`).

import { read, write, append } from "../integrations/zero-g/storage";
import { injectFault } from "../utils/faultInject";
import { safeErr } from "../utils/redact";
import { updateUserProfile, walletPauseOf, readUserProfile, hasUnsavedSpend } from "./store";
import type { PauseInfo } from "./index";

export const GLOBAL_SWITCH_KEY = "killswitch:global";
const GLOBAL_AUDIT_KEY = "audit:killswitch:global";
const walletAuditKey = (wallet: string) => `audit:killswitch:${wallet.toLowerCase()}`;
/** While the global flag is unreadable, another read is tried at most this often. */
const RELOAD_EVERY_MS = 30_000;

/** Who changed a switch, in words for the audit list and the notices. Never a secret. */
export type SwitchActor = "admin-endpoint" | "admin-telegram" | "telegram" | "web";

export interface SwitchRecord {
  on: boolean;
  at: string;
  by: SwitchActor;
  reason?: string;
}

type GlobalState = { kind: "loaded"; record: SwitchRecord | null } | { kind: "unreadable" };

// Before the first load the switch is unknown, which counts as paused.
let globalState: GlobalState = { kind: "unreadable" };
let lastLoad = 0;
let loading: Promise<boolean> | null = null;

/** A stored global record, or "bad" when it isn't one (which counts as paused). */
function parseRecord(v: unknown): SwitchRecord | null | "bad" {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || typeof (v as any).on !== "boolean") return "bad";
  return v as SwitchRecord;
}

/** Read the global switch from storage. False (and paused) when it can't be read. */
export function loadGlobalSwitch(): Promise<boolean> {
  if (loading) return loading;
  lastLoad = Date.now();
  loading = (async () => {
    try {
      await injectFault("killswitch-read");
      const rec = parseRecord(await read(GLOBAL_SWITCH_KEY));
      if (rec === "bad") throw new Error("the stored kill switch isn't a valid record");
      globalState = { kind: "loaded", record: rec };
      return true;
    } catch (err) {
      globalState = { kind: "unreadable" };
      console.error(`[kill-switch] couldn't read the global switch, so automatic actions stay paused: ${safeErr(err)}`);
      return false;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** The global pause right now, or null. An unreadable switch is a pause, and another read is started. */
export function globalPause(now = Date.now()): PauseInfo | null {
  if (globalState.kind === "unreadable") {
    if (now - lastLoad >= RELOAD_EVERY_MS) loadGlobalSwitch().catch(() => {});
    return { scope: "global", cause: "unreadable" };
  }
  return globalState.record?.on ? { scope: "global", cause: "admin" } : null;
}

export interface GlobalSwitchView {
  on: boolean;
  unreadable: boolean;
  at?: string;
  by?: SwitchActor;
  reason?: string;
}

/** What GET /admin/kill-switch answers. */
export function globalSwitchView(): GlobalSwitchView {
  if (globalState.kind === "unreadable") return { on: true, unreadable: true };
  const r = globalState.record;
  return r ? { on: r.on, unreadable: false, at: r.at, by: r.by, ...(r.reason ? { reason: r.reason } : {}) } : { on: false, unreadable: false };
}

/** A reason from an admin request: short, one line, or nothing. */
export function cleanReason(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
  return s || undefined;
}

/**
 * Turn the global switch on or off. On: applied in memory, then saved (a failed save throws but the
 * switch stays on in this process). Off: saved first, so a failed save throws and it stays on.
 */
export async function setGlobalSwitch(on: boolean, by: SwitchActor, reason?: string, now = Date.now()): Promise<SwitchRecord> {
  const rec: SwitchRecord = { on, at: new Date(now).toISOString(), by, ...(reason ? { reason } : {}) };
  if (on) globalState = { kind: "loaded", record: rec };
  await write(GLOBAL_SWITCH_KEY, rec);
  globalState = { kind: "loaded", record: rec };
  append(GLOBAL_AUDIT_KEY, rec).catch((err) => console.error(`[kill-switch] couldn't save the audit record: ${safeErr(err)}`));
  console.log(`[kill-switch] global switch turned ${on ? "ON (automatic actions paused for everyone)" : "OFF"} by ${by}`);
  return rec;
}

// ── One wallet ──

/** Wallets paused in this process whose pause couldn't be saved yet (a failed save still pauses). */
const pausedInMemory = new Set<string>();

/** The audit record for a wallet's pause or resume. */
export function walletPauseRecord(on: boolean, by: SwitchActor, now = Date.now()): SwitchRecord {
  return { on, at: new Date(now).toISOString(), by };
}

/** Keep a wallet's pause or resume in its audit list. Never fails the change. */
export function auditWalletPause(wallet: string, rec: SwitchRecord): void {
  append(walletAuditKey(wallet), rec).catch((err) => console.error(`[kill-switch] couldn't save the audit record: ${safeErr(err)}`));
}

/**
 * Pause a wallet's automatic actions (no proof needed: it only takes power away). Returns whether
 * it was on before. A failed save throws, but the wallet stays paused in this process.
 */
export async function pauseWallet(wallet: string, by: SwitchActor, now = Date.now()): Promise<{ changed: boolean }> {
  const key = wallet.toLowerCase();
  pausedInMemory.add(key);
  let changed = false;
  const rec = walletPauseRecord(true, by, now);
  await updateUserProfile(key, (p) => {
    changed = walletPauseOf(p) === null;
    return changed ? { ...p, autoPause: rec } : p;
  });
  pausedInMemory.delete(key); // saved: the stored flag carries it from here
  if (changed) {
    auditWalletPause(key, rec);
    console.log(`[kill-switch] a wallet paused its automatic actions (${by})`);
  }
  return { changed };
}

/** A pause of this wallet that is only in memory (its save failed). Resuming it still needs proof. */
export function isMemoryPaused(wallet: string): boolean {
  return pausedInMemory.has(wallet.toLowerCase());
}

/** Called after a resume is saved, so an earlier unsaved in-memory pause doesn't linger. */
export function clearMemoryPause(wallet: string): void {
  pausedInMemory.delete(wallet.toLowerCase());
}

/**
 * Everything that pauses this wallet's automatic actions, most general first: the global switch, a
 * pause not saved yet, the wallet's stored pause (`profilePause`, from getPolicyProfile), and a
 * spend record that couldn't be saved (ORC-40 fix C). Null means automatic actions may run.
 */
export function pauseFor(wallet: string | undefined, profilePause: PauseInfo | null | undefined, now = Date.now()): PauseInfo | null {
  const global = globalPause(now);
  if (global) return global;
  if (!wallet) return null;
  if (pausedInMemory.has(wallet.toLowerCase())) return { scope: "wallet", cause: "user" };
  if (profilePause) return profilePause;
  if (hasUnsavedSpend(wallet)) return { scope: "wallet", cause: "unsaved-spend" };
  return null;
}

export interface PauseStatus {
  /** The wallet's own pause (the owner can resume it). */
  wallet: boolean;
  /** The global switch is on (or unreadable). Only the team can turn it off. */
  global: boolean;
  /** Some flag couldn't be read, so it counts as paused. */
  unreadable: boolean;
  /** Automatic actions are paused for another reason (a spend record not saved yet). */
  other: boolean;
}

/** What /simple and Telegram /status show. A wallet flag that can't be read counts as paused. */
export async function pauseStatus(wallet: string): Promise<PauseStatus> {
  const g = globalPause();
  let own: PauseInfo | null;
  try {
    own = pausedInMemory.has(wallet.toLowerCase()) ? { scope: "wallet", cause: "user" } : walletPauseOf(await readUserProfile(wallet));
  } catch {
    own = { scope: "wallet", cause: "unreadable" };
  }
  return {
    wallet: own?.cause === "user",
    global: !!g,
    unreadable: g?.cause === "unreadable" || own?.cause === "unreadable",
    other: hasUnsavedSpend(wallet),
  };
}

/** Test hook: forget the switch state (back to "not loaded", which is paused). */
export function _resetKillSwitch(state: "unloaded" | "off" = "unloaded"): void {
  globalState = state === "off" ? { kind: "loaded", record: null } : { kind: "unreadable" };
  lastLoad = state === "off" ? Date.now() : 0;
  loading = null;
  pausedInMemory.clear();
}
