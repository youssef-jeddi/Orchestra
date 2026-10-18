// ─── Safe — onboarding wiring: deploy, configure and register a user's account ───
// Runs the real steps for OnboardingQueue (onboarding.ts), each only if the chain shows it missing. The server's default limit is
// used for everything: nothing the client sends decides a policy value here.

import { ethers } from "ethers";
import { makeSepoliaProvider } from "../../utils/rpc";
import { read, write, deleteKey } from "../zero-g/storage";
import { readUserProfile, writeUserProfile } from "../../policy/store";
import Safe from "@safe-global/protocol-kit";
import { deploySafe, predictSafeAddress } from "./deploy";
import { getAgentAddress } from "./agentWallet";
import { enableAllowanceModule, addAgentDelegate, setAgentAllowances, isAgentDelegate, tokensWithoutAllowance } from "./spendingLimit";
import { ALLOWANCE_MODULE_ADDRESS } from "../../types/safe";
import { OnboardingError, OnboardingLimiter, OnboardingQueue, accountReady } from "./onboarding";
import { type InflightRecord, type InflightStore, chainProbes, makeTracker } from "./inflight";
import { type SetupFacts, type SetupStep, type SetupInspection, allStepsDone, deriveSteps, finishSetup, isSetupComplete, remainingSteps } from "./setupSteps";

export const DEFAULT_SPENDING_LIMIT_USD = 100;

async function agentAddress(): Promise<string> {
  try {
    return getAgentAddress();
  } catch {
    throw new OnboardingError(500, "Account setup isn't available right now. Please try again later.");
  }
}

// Our own progress record for an account's setup: written before the first transaction, so a
// crash or timeout after the deploy still leaves a trace that the setup is unfinished. Chain
// state decides each step; this only holds what the chain can't show (registered, finished).
interface SetupRecord { safeAddress: string; startedAt: string; registeredAt?: string; completedAt?: string }
const setupKey = (user: string) => `onboard:${user.toLowerCase()}`;
const inflightKey = (user: string) => `inflight:${user.toLowerCase()}`;
const POLICY_READ_ABI = ["function getPolicy(address user) view returns (tuple(address safeAddress, address agentWallet, uint256 spendingLimitUSD, bool initialized))"];

/** Reads where the wallet's account stands: its address, and each setup step from the chain. */
async function inspectAccount(wallet: string): Promise<SetupInspection> {
  const user = ethers.getAddress(wallet);
  const agent = await agentAddress();
  const safeAddress = await predictSafeAddress(user, agent);
  const record = (await read(setupKey(user))) as SetupRecord | null;
  if (record?.completedAt && record.safeAddress === safeAddress) return { safeAddress, steps: allStepsDone() };

  const provider = makeSepoliaProvider();
  // A failed read throws: not knowing is never taken as "not deployed" (that would deploy twice).
  const hasCode = (await provider.getCode(safeAddress)) !== "0x";
  const policyAddress = process.env.ORCHESTRA_POLICY_ADDRESS;
  let facts: SetupFacts = {
    hasCode, moduleEnabled: false, agentIsDelegate: false, allowancesMissing: 3,
    policyConfigured: !!policyAddress, registered: false, recorded: false,
  };
  if (hasCode) {
    const stored = (await read(`safe:${user.toLowerCase()}`)) as { safeAddress?: string } | null;
    // An account from before step tracking (stored, no progress record) was set up by the old
    // flow: its registration isn't re-sent (the policy contract holds one entry per agent, so
    // re-registering would overwrite another account's).
    const legacy = !record && !!stored?.safeAddress;
    let registeredOnChain = false;
    if (policyAddress && !record?.registeredAt && !legacy) {
      const policy = new ethers.Contract(policyAddress, POLICY_READ_ABI, provider);
      registeredOnChain = String((await policy.getPolicy(agent)).safeAddress).toLowerCase() === safeAddress.toLowerCase();
    }
    const safe = await Safe.init({ provider: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", safeAddress });
    facts = {
      ...facts,
      moduleEnabled: await safe.isModuleEnabled(ALLOWANCE_MODULE_ADDRESS),
      agentIsDelegate: await isAgentDelegate(safeAddress, agent),
      allowancesMissing: (await tokensWithoutAllowance(safeAddress, agent)).length,
      registered: !!record?.registeredAt || registeredOnChain || legacy,
      recorded: legacy,
    };
  }
  const steps = deriveSteps(facts);
  if (isSetupComplete(steps) && !record?.completedAt) {
    // Everything checks out on chain (an account from before step tracking): remember it, so
    // later sign-ins skip these reads.
    await write(setupKey(user), { ...record, safeAddress, startedAt: record?.startedAt ?? new Date().toISOString(), completedAt: new Date().toISOString() } satisfies SetupRecord);
  }
  return { safeAddress, steps };
}

/** Runs the account's missing setup steps, in order, each checked against the chain first. */
async function finishAccount(wallet: string, isCancelled: () => boolean): Promise<void> {
  const user = ethers.getAddress(wallet);
  const agent = await agentAddress();
  const agentKey = process.env.AGENT_PRIVATE_KEY!;
  const provider = makeSepoliaProvider();
  const limit = DEFAULT_SPENDING_LIMIT_USD;
  const { safeAddress } = await inspectAccount(user);

  // Every transaction below is recorded before and after it is sent, so a run that stops while one
  // is unconfirmed makes the next run wait for it instead of sending it again.
  const store: InflightStore = {
    load: async () => (await read(inflightKey(user))) as InflightRecord | null,
    save: (rec) => write(inflightKey(user), rec),
    clear: () => deleteKey(inflightKey(user)),
  };
  const probes = chainProbes(provider, agent);
  const track = (step: SetupStep) => makeTracker(step, { store, probes, isCancelled });

  const record = ((await read(setupKey(user))) as SetupRecord | null) ?? { safeAddress, startedAt: new Date().toISOString() };
  await write(setupKey(user), record); // before any transaction: an interrupted setup stays visible

  const ran = await finishSetup(() => inspectAccount(user), {
    deploy: async () => { await deploySafe(user, agent, provider, track("deploy")); },
    module: () => enableAllowanceModule(safeAddress, agentKey, track("module")),
    delegate: () => addAgentDelegate(safeAddress, agent, agentKey, track("delegate")),
    allowances: async () => setAgentAllowances(safeAddress, agent, limit, agentKey, await tokensWithoutAllowance(safeAddress, agent), track("allowances")),
    register: async () => {
      // An earlier run's registration may have confirmed since this run read the chain.
      if ((await inspectAccount(user)).steps.register) return;
      const tracker = track("register");
      await tracker.begin();
      const abi = ["function registerSafe(address safeAddress, address agentWallet, uint256 spendingLimitUSD) external"];
      const policy = new ethers.Contract(process.env.ORCHESTRA_POLICY_ADDRESS!, abi, new ethers.Wallet(agentKey, provider));
      const tx = await policy.registerSafe(safeAddress, agent, limit * 100);
      await tracker.sent(tx.hash);
      await tx.wait();
      await tracker.settled();
      console.log(`[onboard] Policy registered: ${tx.hash}`);
      await write(setupKey(user), { ...record, registeredAt: new Date().toISOString() } satisfies SetupRecord);
    },
    record: async () => {
      await write(`safe:${user.toLowerCase()}`, {
        safeAddress, agentWallet: agent, spendingLimitUSD: limit, deployedAt: new Date().toISOString(),
      });
      // Merge: keep any existing guardrail policy instead of wiping it.
      const profile = await readUserProfile(user);
      await writeUserProfile(user, {
        ...profile,
        address: user,
        safeAddress,
        riskTolerance: profile.riskTolerance || "moderate",
        autoApproveLimit: limit,
        preferredTokens: profile.preferredTokens || ["USDC", "WETH", "ETH"],
        createdAt: profile.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    },
  }, isCancelled);

  // Done only if the chain agrees: the next inspect decides, not this function's say-so.
  if (ran.length) {
    const after = await inspectAccount(user);
    if (!isSetupComplete(after.steps)) throw new Error(`setup incomplete: ${remainingSteps(after.steps).join(", ")}`);
    const latest = ((await read(setupKey(user))) as SetupRecord | null) ?? record;
    await deleteKey(inflightKey(user)); // everything is done: nothing can still be in flight
    if (!latest.completedAt) await write(setupKey(user), { ...latest, completedAt: new Date().toISOString() } satisfies SetupRecord);
    console.log(`[onboard] Account ready: ${safeAddress} (ran: ${ran.join(", ")})`);
  }
}

export const onboarding = new OnboardingQueue({
  inspect: inspectAccount,
  finish: finishAccount,
  limiter: new OnboardingLimiter(),
});

/** The spending limit stored for a wallet's account (the default if none). */
export async function storedSpendingLimit(wallet: string): Promise<number> {
  return Number(((await read(`safe:${wallet.toLowerCase()}`)) as any)?.spendingLimitUSD) || DEFAULT_SPENDING_LIMIT_USD;
}

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
