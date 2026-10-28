// ─── Safe — onboarding wiring: deploy, configure and register a user's account ───
// Runs the real steps for OnboardingQueue (onboarding.ts), each only if the chain shows it missing. The server's default limit is
// used for everything: nothing the client sends decides a policy value here.

import { ethers } from "ethers";
import { makeSepoliaProvider } from "../../utils/rpc";
import { read, write, deleteKey } from "../zero-g/storage";
import { readUserProfile } from "../../policy/store";
import { deploySafe, predictSafeAddress, resolveAccountSetup, type AccountSetup } from "./deploy";
import { getAgentAddress } from "./agentWallet";
import { agentAddressFor } from "./agentKeys";
import { OnboardingError, OnboardingLimiter, OnboardingQueue, accountReady } from "./onboarding";
import { type InflightRecord, type InflightStore, type TxTracker, chainProbes, makeTracker } from "./inflight";
import { type SetupInspection, type SetupStep } from "./setupSteps";
import { type AccountReads, type SetupRecord, finishWith, inspectWith, registerAccount } from "./inspect";
import { POLICY_ABI, isPerAccountRegistry, registerSafeArgs, policyAddress as configuredPolicy } from "./policyContract";
import { DEFAULT_SPENDING_LIMIT_USD, writeAccountRecord } from "./accountRecord";
import { shortAddr } from "../../utils/redact";
import { noteRelayerGas } from "../../policy/gasStore";

export { DEFAULT_SPENDING_LIMIT_USD };

async function agentAddress(): Promise<string> {
  try {
    return getAgentAddress();
  } catch {
    throw new OnboardingError(500, "Account setup isn't available right now. Please try again later.");
  }
}

const setupKey = (user: string) => `onboard:${user.toLowerCase()}`;
const inflightKey = (user: string) => `inflight:${user.toLowerCase()}`;

/** How this wallet's account is (or will be) set up, and where it lives. */
interface AccountPlan {
  setup: AccountSetup;
  /** The agent written into the Safe's setup: the shared one (owner/v1) or the account's own key (v2). */
  configAgent: string;
  safeAddress: string;
}

const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function accountPlan(user: string, sharedAgent: string, provider: ethers.Provider): Promise<AccountPlan> {
  const setup = await resolveAccountSetup(provider);
  const configAgent = setup.kind === "v2" ? await agentAddressFor(user) : sharedAgent;
  // A finished account recorded for this same module keeps its recorded address, whatever the
  // derivation would give now. A record from another module (a v1 account once the bridge runs v2,
  // or one from before records named their module) is an old wallet: the account is derived anew.
  const stored = (await read(`safe:${user.toLowerCase()}`)) as { safeAddress?: string; spendingModule?: string } | null;
  if (setup.kind !== "owner" && stored?.safeAddress && sameAddr(stored.spendingModule, setup.module)) {
    return { setup, configAgent, safeAddress: ethers.getAddress(stored.safeAddress) };
  }
  return { setup, configAgent, safeAddress: await predictSafeAddress(user, configAgent, setup) };
}

/** The real reads for one wallet's account: our storage and Sepolia. Rules live in inspect.ts. */
async function accountReads(wallet: string): Promise<AccountReads & { plan: AccountPlan }> {
  const user = ethers.getAddress(wallet);
  const agent = await agentAddress();
  const provider = makeSepoliaProvider();
  const plan = await accountPlan(user, agent, provider);
  const { safeAddress } = plan;
  const policyAddress = configuredPolicy();
  return {
    plan,
    safeAddress,
    policyAddress,
    setupRecord: async () => (await read(setupKey(user))) as SetupRecord | null,
    saveSetupRecord: (rec) => write(setupKey(user), rec),
    storedAccount: async () => (await read(`safe:${user.toLowerCase()}`)) as { safeAddress?: string } | null,
    profile: async () => (await readUserProfile(user)) as { safeAddress?: string },
    hasCode: async () => (await provider.getCode(safeAddress)) !== "0x",
    registryIsCurrent: () => isPerAccountRegistry(provider, policyAddress!, agent),
    registeredOnChain: async () => new ethers.Contract(policyAddress!, POLICY_ABI, provider).hasPolicy(safeAddress),
    now: () => new Date().toISOString(),
  };
}

/** Reads where the wallet's account stands: its address, and each setup step from the chain. */
async function inspectAccount(wallet: string): Promise<SetupInspection> {
  return inspectWith(await accountReads(wallet));
}

/** Every transaction is recorded before and after it is sent, so a run that stops while one is unconfirmed makes the next run wait for it instead of sending it again. */
function trackerFor(user: string, agent: string, isCancelled: () => boolean) {
  const store: InflightStore = {
    load: async () => (await read(inflightKey(user))) as InflightRecord | null,
    save: (rec) => write(inflightKey(user), rec),
    clear: () => deleteKey(inflightKey(user)),
  };
  const probes = chainProbes(makeSepoliaProvider(), agent);
  return (step: SetupStep) => makeTracker(step, { store, probes, isCancelled });
}

/**
 * Registers the account on the configured registry, unless the registry already has it (then only
 * our record is updated). Safe to retry: the chain is asked first, the transaction is tracked, and a
 * second `registerSafe` for the same account would revert rather than overwrite anything.
 */
function registerOnPolicy(user: string, reads: AccountReads, track: (step: SetupStep) => TxTracker): Promise<void> {
  // The rules (no registry: nothing; not the per-account registry: refuse before sending anything) are in registerAccount.
  return registerAccount(reads, async () => {
    const tracker = track("register");
    await tracker.begin();
    const policy = new ethers.Contract(reads.policyAddress!, POLICY_ABI, new ethers.Wallet(process.env.AGENT_PRIVATE_KEY!, makeSepoliaProvider()));
    // The registry is a record only; the on-chain ceiling lives in the spending module, so no limit is written here.
    const tx = await policy.registerSafe(...registerSafeArgs(reads.safeAddress, user));
    await tracker.sent(tx.hash);
    const receipt = await tx.wait();
    await noteRelayerGas({ account: reads.safeAddress, kind: "setup", txHash: tx.hash, receipt, wallet: user }); // ORC-31
    await tracker.settled();
    console.log(`[onboard] Policy registered: ${tx.hash}`);
  });
}

/**
 * Registers a finished account that the current registry doesn't know yet. The account stays ready
 * meanwhile (the registry doesn't gate spending); a failure is logged and tried again at the next sign-in.
 */
async function registerFinishedAccount(wallet: string): Promise<void> {
  const user = ethers.getAddress(wallet);
  const agent = await agentAddress();
  await registerOnPolicy(user, await accountReads(user), trackerFor(user, agent, () => false));
}

/** Runs the account's missing setup steps, in order, each checked against the chain first. */
async function finishAccount(wallet: string, isCancelled: () => boolean): Promise<void> {
  const user = ethers.getAddress(wallet);
  const agent = await agentAddress();
  const provider = makeSepoliaProvider();
  const reads = await accountReads(user);
  const { safeAddress } = reads;
  const track = trackerFor(user, agent, isCancelled);

  const ran = await finishWith(reads, {
    deploy: async () => { await deploySafe(user, reads.plan.configAgent, provider, track("deploy"), reads.plan.setup); },
    // The chain is asked first (a registration from an earlier run may have confirmed since this run read it).
    register: () => registerOnPolicy(user, reads, track),
    // The only writer of `safe:<wallet>`, and the last step: an unfinished account is never recorded as the user's own.
    record: () => writeAccountRecord({
      user, safeAddress, agent: reads.plan.configAgent,
      spendingModule: reads.plan.setup.kind === "owner" ? undefined : reads.plan.setup.module,
    }),
  }, isCancelled, async () => {
    await deleteKey(inflightKey(user)); // everything is done: nothing can still be in flight
  });
  if (ran.length) console.log(`[onboard] Account ready: ${shortAddr(safeAddress)} (ran: ${ran.join(", ")})`);
}

export const onboarding = new OnboardingQueue({
  inspect: inspectAccount,
  finish: finishAccount,
  registerFinished: registerFinishedAccount,
  limiter: new OnboardingLimiter(),
});

// A "yes" is remembered briefly so a chat of several messages doesn't re-read the chain each time;
// a "no" is never remembered, so a finished setup is noticed at once.
const readyUntil = new Map<string, number>();

/** May the agent act for this wallet's account? Only when setup is complete; a failed check says no. */
export async function isAccountReady(wallet: string): Promise<boolean> {
  const key = wallet.toLowerCase();
  if ((readyUntil.get(key) ?? 0) > Date.now()) return true;
  const ready = await accountReady(onboarding, wallet);
  if (ready) readyUntil.set(key, Date.now() + 60_000); else readyUntil.delete(key);
  return ready;
}
