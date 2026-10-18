// ─── Safe — account inspection and finishing, with every read injected ───
// Turns what storage and the chain say about one account into setup steps, and runs the missing
// ones. The real reads live in onboard.ts; here nothing touches the network, so the rules (what
// counts as recorded, what counts as an account from before step tracking) are tested directly.

import { type SetupFacts, type SetupInspection, type SetupStep, allStepsDone, deriveSteps, finishSetup, isSetupComplete, remainingSteps } from "./setupSteps";

/**
 * Our own progress record for an account's setup: written before the first transaction, so a
 * crash or timeout after the deploy still leaves a trace that the setup is unfinished. Chain
 * state decides each step; this only holds what the chain can't show.
 */
export interface SetupRecord {
  safeAddress: string;
  startedAt: string;
  /** Set when the setup began on an account from before step tracking: it was registered by the old flow and is never registered again. */
  legacy?: boolean;
  registeredAt?: string;
  completedAt?: string;
}

/** Everything inspection reads. Chain reads throw when they fail: not knowing is never "not done". */
export interface AccountReads {
  safeAddress: string;
  policyConfigured: boolean;
  setupRecord(): Promise<SetupRecord | null>;
  saveSetupRecord(rec: SetupRecord): Promise<void>;
  /** The stored account record (`safe:<wallet>`). */
  storedAccount(): Promise<{ safeAddress?: string } | null>;
  /** The stored profile. */
  profile(): Promise<{ safeAddress?: string } | null>;
  hasCode(): Promise<boolean>;
  moduleEnabled(): Promise<boolean>;
  agentIsDelegate(): Promise<boolean>;
  allowancesMissing(): Promise<number>;
  /** The policy contract's entry for this agent points at this account. */
  registeredOnChain(): Promise<boolean>;
  now(): string;
}

export interface Inspected extends SetupInspection {
  /** The account predates step tracking: its registration is never sent again. */
  legacy: boolean;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Reads where the account stands: each setup step, from the chain and our records. */
export async function inspectWith(r: AccountReads): Promise<Inspected> {
  const { safeAddress } = r;
  const record = await r.setupRecord();
  if (record?.completedAt && same(record.safeAddress, safeAddress)) return { safeAddress, steps: allStepsDone(), legacy: !!record.legacy };

  const hasCode = await r.hasCode(); // a failed read throws: never taken as "not deployed" (that would deploy twice)
  let legacy = false;
  let facts: SetupFacts = {
    hasCode, moduleEnabled: false, agentIsDelegate: false, allowancesMissing: 3,
    policyConfigured: r.policyConfigured, registered: false, recorded: false,
  };
  if (hasCode) {
    const stored = await r.storedAccount();
    const hasStored = same(stored?.safeAddress, safeAddress);
    // An account from before step tracking (stored, no progress record) was set up by the old flow:
    // its registration isn't re-sent (the policy contract holds one entry per agent, so
    // re-registering would overwrite another account's). The setup record keeps that answer once
    // it exists; a record from before the flag was added is read like a missing one.
    legacy = record ? (record.legacy ?? hasStored) : hasStored;
    const registeredOnChain = r.policyConfigured && !record?.registeredAt && !legacy ? await r.registeredOnChain() : false;
    // "Recorded" is about our records alone: the stored account and the profile are really written.
    const recorded = hasStored && same((await r.profile())?.safeAddress, safeAddress);
    facts = {
      ...facts,
      moduleEnabled: await r.moduleEnabled(),
      agentIsDelegate: await r.agentIsDelegate(),
      allowancesMissing: await r.allowancesMissing(),
      registered: !!record?.registeredAt || registeredOnChain || legacy,
      recorded,
    };
  }
  const steps = deriveSteps(facts);
  if (isSetupComplete(steps) && !record?.completedAt) {
    // Everything checks out: remember it, so later sign-ins skip these reads.
    await r.saveSetupRecord({ ...record, safeAddress, startedAt: record?.startedAt ?? r.now(), ...(legacy ? { legacy: true } : {}), completedAt: r.now() });
  }
  return { safeAddress, steps, legacy };
}

/**
 * Finish the account: note on the setup record (before any transaction) whether it predates step
 * tracking, run only the missing steps, then let a fresh inspection say whether it is done.
 */
export async function finishWith(
  r: AccountReads,
  run: Record<SetupStep, () => Promise<void>>,
  isCancelled: () => boolean,
  onComplete: () => Promise<void> = async () => {},
): Promise<SetupStep[]> {
  const first = await inspectWith(r);
  const existing = await r.setupRecord();
  const record: SetupRecord = { ...(existing ?? { safeAddress: first.safeAddress, startedAt: r.now() }), legacy: first.legacy };
  await r.saveSetupRecord(record); // before any transaction: an interrupted setup stays visible

  const ran = await finishSetup(() => inspectWith(r), run, isCancelled);
  // Done only if the chain and our records agree: the next inspection decides, not this function's say-so.
  if (ran.length) {
    const after = await inspectWith(r);
    if (!isSetupComplete(after.steps)) throw new Error(`setup incomplete: ${remainingSteps(after.steps).join(", ")}`);
    await onComplete();
  }
  return ran;
}
