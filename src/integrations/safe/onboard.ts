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
import { type SetupInspection, type SetupStep } from "./setupSteps";
import { type AccountReads, type SetupRecord, finishWith, inspectWith } from "./inspect";

export const DEFAULT_SPENDING_LIMIT_USD = 100;

async function agentAddress(): Promise<string> {
  try {
    return getAgentAddress();
  } catch {
    throw new OnboardingError(500, "Account setup isn't available right now. Please try again later.");
  }
}

const setupKey = (user: string) => `onboard:${user.toLowerCase()}`;
const inflightKey = (user: string) => `inflight:${user.toLowerCase()}`;
const POLICY_READ_ABI = ["function getPolicy(address user) view returns (tuple(address safeAddress, address agentWallet, uint256 spendingLimitUSD, bool initialized))"];

/** The real reads for one wallet's account: our storage and Sepolia. Rules live in inspect.ts. */
async function accountReads(wallet: string): Promise<AccountReads> {
  const user = ethers.getAddress(wallet);
  const agent = await agentAddress();
  const safeAddress = await predictSafeAddress(user, agent);
  const provider = makeSepoliaProvider();
  const policyAddress = process.env.ORCHESTRA_POLICY_ADDRESS;
  const rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  return {
    safeAddress,
    policyConfigured: !!policyAddress,
    setupRecord: async () => (await read(setupKey(user))) as SetupRecord | null,
    saveSetupRecord: (rec) => write(setupKey(user), rec),
    storedAccount: async () => (await read(`safe:${user.toLowerCase()}`)) as { safeAddress?: string } | null,
    profile: async () => (await readUserProfile(user)) as { safeAddress?: string },
    hasCode: async () => (await provider.getCode(safeAddress)) !== "0x",
    moduleEnabled: async () => (await Safe.init({ provider: rpc, safeAddress })).isModuleEnabled(ALLOWANCE_MODULE_ADDRESS),
    agentIsDelegate: () => isAgentDelegate(safeAddress, agent),
    allowancesMissing: async () => (await tokensWithoutAllowance(safeAddress, agent)).length,
    registeredOnChain: async () => {
      const policy = new ethers.Contract(policyAddress!, POLICY_READ_ABI, provider);
      return String((await policy.getPolicy(agent)).safeAddress).toLowerCase() === safeAddress.toLowerCase();
    },
    now: () => new Date().toISOString(),
  };
}

/** Reads where the wallet's account stands: its address, and each setup step from the chain. */
async function inspectAccount(wallet: string): Promise<SetupInspection> {
  const { safeAddress, steps } = await inspectWith(await accountReads(wallet));
  return { safeAddress, steps };
}

/** Runs the account's missing setup steps, in order, each checked against the chain first. */
async function finishAccount(wallet: string, isCancelled: () => boolean): Promise<void> {
  const user = ethers.getAddress(wallet);
  const agent = await agentAddress();
  const agentKey = process.env.AGENT_PRIVATE_KEY!;
  const provider = makeSepoliaProvider();
  const limit = DEFAULT_SPENDING_LIMIT_USD;
  const reads = await accountReads(user);
  const { safeAddress } = reads;

  // Every transaction below is recorded before and after it is sent, so a run that stops while one
  // is unconfirmed makes the next run wait for it instead of sending it again.
  const store: InflightStore = {
    load: async () => (await read(inflightKey(user))) as InflightRecord | null,
    save: (rec) => write(inflightKey(user), rec),
    clear: () => deleteKey(inflightKey(user)),
  };
  const probes = chainProbes(provider, agent);
  const track = (step: SetupStep) => makeTracker(step, { store, probes, isCancelled });

  const ran = await finishWith(reads, {
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
      const rec = await reads.setupRecord(); // always there: finishWith writes it before any transaction
      await write(setupKey(user), { ...rec!, registeredAt: new Date().toISOString() } satisfies SetupRecord);
    },
    record: async () => {
      // Keep what an account from before step tracking already has (its limit, its deploy date).
      const stored = ((await reads.storedAccount()) ?? {}) as { spendingLimitUSD?: number; deployedAt?: string };
      await write(`safe:${user.toLowerCase()}`, {
        safeAddress, agentWallet: agent, spendingLimitUSD: stored.spendingLimitUSD ?? limit, deployedAt: stored.deployedAt ?? new Date().toISOString(),
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
  }, isCancelled, async () => {
    await deleteKey(inflightKey(user)); // everything is done: nothing can still be in flight
  });
  if (ran.length) console.log(`[onboard] Account ready: ${safeAddress} (ran: ${ran.join(", ")})`);
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
