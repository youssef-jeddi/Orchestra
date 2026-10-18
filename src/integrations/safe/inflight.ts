// ─── Safe — in-flight setup transactions: never send a step twice ───
// A setup transaction can be sent and still unconfirmed when a run times out or the process stops.
// The chain then still shows the step as missing, so a plain retry would send it again (a second
// deploy reverts and burns gas; a second module transaction fights the first for the same Safe
// nonce). Before each send the run writes an intent record (the agent's next nonce), after it the
// transaction hash; the next run judges that record against the chain before sending anything.
// Pure and injectable (probes, store, clock) so it is tested without network.

import { OnboardingError } from "./onboarding";
import type { SetupStep } from "./setupSteps";

export interface InflightRecord {
  step: SetupStep;
  /** The agent's pending nonce just before sending: a transaction we sent used this one or a later one. */
  agentNonce: number;
  startedAt: number;
  /** Set once the transaction was broadcast. */
  hash?: string;
}

/** What the next run learns from the chain about a transaction it may have sent. */
export interface ChainProbes {
  /** The mined result, or null while it isn't mined. */
  receipt(hash: string): Promise<{ ok: boolean } | null>;
  /** True while the network still knows the transaction (waiting in a pool). */
  known(hash: string): Promise<boolean>;
  pendingNonce(): Promise<number>;
  latestNonce(): Promise<number>;
}

/**
 * clear: nothing is in flight, send freely. settled: it was mined (the chain's step facts say
 * whether it worked), send only what is still missing. pending: it may still confirm, send nothing.
 */
export type InflightVerdict = "clear" | "settled" | "pending";

/** How long an unconfirmed transaction is waited for before it is treated as dropped. */
export const INFLIGHT_GRACE_MS = Number(process.env.ONBOARD_INFLIGHT_GRACE_MS) || 20 * 60_000;
/** Not seeing a transaction at once proves nothing (RPC nodes lag); only later does a nonce that moved on mean it was replaced. */
export const INFLIGHT_MIN_DROP_MS = 2 * 60_000;

/** Judges a record against the chain. A failed read throws: not knowing is never taken as "nothing in flight". */
export async function judgeInflight(
  rec: InflightRecord, probes: ChainProbes, now: number, graceMs = INFLIGHT_GRACE_MS, minDropMs = INFLIGHT_MIN_DROP_MS,
): Promise<InflightVerdict> {
  const age = now - rec.startedAt;
  if (rec.hash) {
    if (await probes.receipt(rec.hash)) return "settled";
    if (await probes.known(rec.hash)) return "pending";
    // Unknown to the node: replaced (the agent's nonce moved past it) or dropped.
    if (age >= minDropMs && (await probes.latestNonce()) > rec.agentNonce) return "clear";
    return age >= graceMs ? "clear" : "pending";
  }
  // Intent only: the run stopped between recording and broadcasting, or just after broadcasting.
  if ((await probes.pendingNonce()) <= rec.agentNonce) return "clear"; // nothing left the agent since
  return age >= graceMs ? "clear" : "pending";
}

/** A transaction from an earlier run may still confirm: nothing is sent until it does or is given up on. */
export class SetupPendingError extends OnboardingError {
  constructor() {
    super(409, "We're still finishing your account setup. Give it a few minutes, then try again.", "setup_pending");
  }
}

export interface InflightStore {
  load(): Promise<InflightRecord | null>;
  save(rec: InflightRecord): Promise<void>;
  clear(): Promise<void>;
}

/** What a step wraps around each transaction it sends: begin() before, sent(hash) after, settled() once mined. */
export interface TxTracker {
  begin(): Promise<void>;
  sent(hash: string): Promise<void>;
  settled(): Promise<void>;
}

/**
 * A tracker for one run's step. `begin` refuses (SetupPendingError) while an earlier transaction
 * may still confirm, and refuses once the run timed out so an abandoned run can't keep sending.
 */
export function makeTracker(
  step: SetupStep,
  deps: { store: InflightStore; probes: ChainProbes; isCancelled: () => boolean; now?: () => number; graceMs?: number },
): TxTracker {
  const now = deps.now ?? Date.now;
  let current: InflightRecord | null = null;
  return {
    async begin() {
      if (deps.isCancelled()) throw new Error("deployment timed out");
      const earlier = await deps.store.load();
      if (earlier) {
        if ((await judgeInflight(earlier, deps.probes, now(), deps.graceMs)) === "pending") throw new SetupPendingError();
        await deps.store.clear();
      }
      current = { step, agentNonce: await deps.probes.pendingNonce(), startedAt: now() };
      await deps.store.save(current);
    },
    async sent(hash) {
      current = { ...(current ?? { step, agentNonce: await deps.probes.pendingNonce(), startedAt: now() }), hash };
      await deps.store.save(current);
    },
    async settled() {
      current = null;
      await deps.store.clear();
    },
  };
}

/** Chain probes for the agent's address, from any ethers-like provider. */
export function chainProbes(
  provider: {
    getTransactionReceipt(h: string): Promise<{ status: number | null } | null>;
    getTransaction(h: string): Promise<unknown | null>;
    getTransactionCount(a: string, tag: "pending" | "latest"): Promise<number>;
  },
  agent: string,
): ChainProbes {
  return {
    receipt: async (h) => { const r = await provider.getTransactionReceipt(h); return r ? { ok: r.status === 1 } : null; },
    known: async (h) => !!(await provider.getTransaction(h)),
    pendingNonce: () => provider.getTransactionCount(agent, "pending"),
    latestNonce: () => provider.getTransactionCount(agent, "latest"),
  };
}
