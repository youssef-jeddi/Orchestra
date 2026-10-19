// ─── Safe — account inspection and finishing, with every read injected ───
// Turns what storage and the chain say about one account into setup steps, and runs the missing
// ones. The real reads live in onboard.ts; here nothing touches the network, so the rules (what
// counts as recorded, what counts as registered) are tested directly.

import { NOT_PER_ACCOUNT_REGISTRY } from "./policyContract";
import { type SetupFacts, type SetupInspection, type SetupStep, allStepsDone, deriveSteps, finishSetup, isSetupComplete, remainingSteps } from "./setupSteps";

/**
 * Our own progress record for an account's setup: written before the first transaction, so a
 * crash or timeout after the deploy still leaves a trace that the setup is unfinished. Chain
 * state decides each step; this only holds what the chain can't show.
 */
export interface SetupRecord {
  safeAddress: string;
  startedAt: string;
  /** Written by an earlier version (accounts registered by the old per-agent flow); no longer read. */
  legacy?: boolean;
  registeredAt?: string;
  /** The registry (lowercased address) `registeredAt` refers to: a registration on another registry doesn't count. */
  registeredOn?: string;
  completedAt?: string;
}

/** Everything inspection reads. Chain reads throw when they fail: not knowing is never "not done". */
export interface AccountReads {
  safeAddress: string;
  /** The registry this server uses (lowercased), or null: then there is nothing to register. */
  policyAddress: string | null;
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
  /** The configured contract is the per-account registry for our agent (not the old per-sender one, not some other contract). */
  registryIsCurrent(): Promise<boolean>;
  /** The registry has an entry for this account. Only asked once `registryIsCurrent` says yes. */
  registeredOnChain(): Promise<boolean>;
  now(): string;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Our record says this account is registered on the registry the server uses now. */
export const registeredHere = (record: SetupRecord | null, policyAddress: string | null) =>
  !!policyAddress && !!record?.registeredAt && same(record.registeredOn, policyAddress);

/**
 * Registers the account on the configured registry, if it really is the per-account one. With no
 * registry nothing happens. With another contract at that address (the old per-sender registry
 * still configured) it is treated the same way, with a warning: nothing is sent, nothing is marked
 * registered, and setup carries on, since the registry doesn't gate spending and a wrong address
 * must never stop a sign-up. Once a correct registry is configured the account registers at its
 * next sign-in (`registeredOn` won't match). `send` is the transaction itself, and is only called
 * when the registry has no entry for this account yet, so a retry never registers twice.
 */
export async function registerAccount(r: AccountReads, send: () => Promise<void>): Promise<void> {
  const policy = r.policyAddress;
  if (!policy) return;
  if (!(await r.registryIsCurrent())) {
    console.warn(`[onboard] ${NOT_PER_ACCOUNT_REGISTRY}`);
    return;
  }
  if (!(await r.registeredOnChain())) await send();
  const rec = (await r.setupRecord()) ?? { safeAddress: r.safeAddress, startedAt: r.now() };
  await r.saveSetupRecord({ ...rec, registeredAt: r.now(), registeredOn: policy });
}

/** Reads where the account stands: each setup step, from the chain and our records. */
export async function inspectWith(r: AccountReads): Promise<SetupInspection> {
  const { safeAddress, policyAddress } = r;
  const record = await r.setupRecord();
  if (record?.completedAt && same(record.safeAddress, safeAddress)) {
    // Finished: ready whatever the registry says. A registration missing on the current registry is
    // only reported, so it can be done in the background without ever blocking the account. A
    // configured contract that isn't the per-account registry is not worth trying: no pending
    // registration, so no attempt (or budget spent, or log line) at every sign-in. The extra read
    // only happens for accounts not yet registered on the configured address.
    const pending = !!policyAddress && !registeredHere(record, policyAddress) && (await r.registryIsCurrent());
    return { safeAddress, steps: allStepsDone(), ...(pending ? { registrationPending: true } : {}) };
  }

  const hasCode = await r.hasCode(); // a failed read throws: never taken as "not deployed" (that would deploy twice)
  let facts: SetupFacts = {
    hasCode, moduleEnabled: false, agentIsDelegate: false, allowancesMissing: 3,
    policyConfigured: !!policyAddress, registered: false, recorded: false,
  };
  if (hasCode) {
    const hasStored = same((await r.storedAccount())?.safeAddress, safeAddress);
    const known = registeredHere(record, policyAddress);
    // The registry is keyed by account, so asking it is exact: another account's entry never answers for this one.
    // A configured contract that isn't the per-account registry counts like no registry: nothing to register, setup goes on.
    const usable = !!policyAddress && (known || (await r.registryIsCurrent()));
    const registered = known || (usable && (await r.registeredOnChain()));
    // "Recorded" is about our records alone: the stored account and the profile are really written.
    const recorded = hasStored && same((await r.profile())?.safeAddress, safeAddress);
    facts = {
      ...facts,
      policyConfigured: usable,
      moduleEnabled: await r.moduleEnabled(),
      agentIsDelegate: await r.agentIsDelegate(),
      allowancesMissing: await r.allowancesMissing(),
      registered,
      recorded,
    };
  }
  const steps = deriveSteps(facts);
  if (isSetupComplete(steps) && !record?.completedAt) {
    // Everything checks out: remember it, so later sign-ins skip these reads.
    const { legacy: _old, ...rest } = record ?? ({} as SetupRecord);
    const registration = policyAddress && facts.registered
      ? { registeredAt: registeredHere(record, policyAddress) ? record!.registeredAt : r.now(), registeredOn: policyAddress }
      : {};
    await r.saveSetupRecord({ ...rest, ...registration, safeAddress, startedAt: record?.startedAt ?? r.now(), completedAt: r.now() });
  }
  return { safeAddress, steps };
}

/**
 * Finish the account: note on the setup record (before any transaction) that the setup has begun,
 * run only the missing steps, then let a fresh inspection say whether it is done.
 */
export async function finishWith(
  r: AccountReads,
  run: Record<SetupStep, () => Promise<void>>,
  isCancelled: () => boolean,
  onComplete: () => Promise<void> = async () => {},
): Promise<SetupStep[]> {
  const first = await inspectWith(r);
  const { legacy: _old, ...existing } = (await r.setupRecord()) ?? { safeAddress: first.safeAddress, startedAt: r.now() };
  await r.saveSetupRecord(existing); // before any transaction: an interrupted setup stays visible

  const ran = await finishSetup(() => inspectWith(r), run, isCancelled);
  // Done only if the chain and our records agree: the next inspection decides, not this function's say-so.
  if (ran.length) {
    const after = await inspectWith(r);
    if (!isSetupComplete(after.steps)) throw new Error(`setup incomplete: ${remainingSteps(after.steps).join(", ")}`);
    await onComplete();
  }
  return ran;
}
