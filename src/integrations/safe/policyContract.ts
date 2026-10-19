// ─── Safe — the OrchestraPolicy registry: ABI and configured address ───
// One entry per account, keyed by the account's (Safe) address, so one user's registration can't
// replace another's. The one place the ABI lives. Nothing here is enforced against spending: the
// registry is a record, only the policy engine limits money.

import { ethers } from "ethers";

export const POLICY_ABI = [
  "function registerSafe(address safeAddress, address owner, uint256 spendingLimitUSD) external",
  "function updateSpendingLimit(address safeAddress, uint256 newLimitUSD) external",
  "function hasPolicy(address safeAddress) view returns (bool)",
  "function agent() view returns (address)",
];

/** The configured registry (lowercased), or null when this server has none. */
export function policyAddress(): string | null {
  return process.env.ORCHESTRA_POLICY_ADDRESS?.trim().toLowerCase() || null;
}

export const NOT_PER_ACCOUNT_REGISTRY = "ORCHESTRA_POLICY_ADDRESS isn't the per-account registry; nothing registered";

/**
 * Is the contract at `address` the per-account registry for this agent? The old registry has the
 * same `registerSafe` and `hasPolicy` signatures but keys entries by the sender, so writing to it
 * would overwrite the agent's one entry. Only the new one has `agent()`, and it must be ours.
 * A call that reverts, fails or answers with another address says no.
 */
export async function isPerAccountRegistry(provider: ethers.ContractRunner, address: string, agent: string): Promise<boolean> {
  try {
    const owner = await new ethers.Contract(address, POLICY_ABI, provider).agent();
    return String(owner).toLowerCase() === agent.toLowerCase();
  } catch {
    return false;
  }
}
