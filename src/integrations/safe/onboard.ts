// ─── Safe — onboarding wiring: deploy, configure and register a user's account ───
// Runs the real steps for OnboardingQueue (onboarding.ts). The server's default limit is
// used for everything: nothing the client sends decides a policy value here.

import { ethers } from "ethers";
import { makeSepoliaProvider } from "../../utils/rpc";
import { read, write } from "../zero-g/storage";
import { readUserProfile, writeUserProfile } from "../../policy/store";
import { deploySafe, predictSafeAddress } from "./deploy";
import { detectExistingSafe } from "./detect";
import { getAgentAddress } from "./agentWallet";
import { setInitialSpendingLimits } from "./spendingLimit";
import { OnboardingError, OnboardingLimiter, OnboardingQueue } from "./onboarding";

export const DEFAULT_SPENDING_LIMIT_USD = 100;

async function agentAddress(): Promise<string> {
  try {
    return getAgentAddress();
  } catch {
    throw new OnboardingError(500, "Account setup isn't available right now. Please try again later.");
  }
}

/** Deploys the account and sets it up exactly as before: limits, OrchestraPolicy, stored record, profile. */
async function deployAndConfigure(wallet: string, isCancelled: () => boolean): Promise<void> {
  const proceed = () => { if (isCancelled()) throw new Error("deployment timed out"); };
  const user = ethers.getAddress(wallet);
  const agent = await agentAddress();
  const agentKey = process.env.AGENT_PRIVATE_KEY!;
  const provider = makeSepoliaProvider();
  const limit = DEFAULT_SPENDING_LIMIT_USD;

  proceed();
  const safeAddress = await deploySafe(user, agent, provider);

  proceed();
  // Spending limits are non-blocking, as before: the account works without them.
  try {
    await setInitialSpendingLimits(safeAddress, agent, limit, agentKey);
  } catch (e: any) {
    console.warn(`[onboard] Spending limits setup deferred: ${e.message}`);
  }

  proceed();
  const policyAddress = process.env.ORCHESTRA_POLICY_ADDRESS;
  if (policyAddress) {
    const abi = ["function registerSafe(address safeAddress, address agentWallet, uint256 spendingLimitUSD) external"];
    const policy = new ethers.Contract(policyAddress, abi, new ethers.Wallet(agentKey, provider));
    const tx = await policy.registerSafe(safeAddress, agent, limit * 100);
    await tx.wait();
    console.log(`[onboard] Policy registered: ${tx.hash}`);
  }

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
  console.log(`[onboard] Account ready: ${safeAddress}`);
}

export const onboarding = new OnboardingQueue({
  existing: (wallet) => detectExistingSafe(wallet),
  predict: async (wallet) => predictSafeAddress(ethers.getAddress(wallet), await agentAddress()),
  deploy: deployAndConfigure,
  limiter: new OnboardingLimiter(),
});

/** The spending limit stored for a wallet's account (the default if none). */
export async function storedSpendingLimit(wallet: string): Promise<number> {
  return Number(((await read(`safe:${wallet.toLowerCase()}`)) as any)?.spendingLimitUSD) || DEFAULT_SPENDING_LIMIT_USD;
}
