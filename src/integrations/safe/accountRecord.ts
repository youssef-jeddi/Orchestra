// ─── Safe — the stored record of a finished account ───
// The last setup step: `safe:<wallet>` (the account) and the wallet's own profile.
// Only this writes `safe:<wallet>` for a new account, and only after every earlier step is done, so
// an account that is deployed but not finished is never taken for the user's own. The daily limit
// lives only in the profile's policy.

import { read, write } from "../zero-g/storage";
import { readUserProfile, writeUserProfile } from "../../policy/store";

export const DEFAULT_SPENDING_LIMIT_USD = 100;

/** Writes the account record and merges the wallet's profile (keeping its own guardrail policy). */
export async function writeAccountRecord(o: { user: string; safeAddress: string; agent: string; now?: () => string }): Promise<void> {
  const now = o.now ?? (() => new Date().toISOString());
  const key = `safe:${o.user.toLowerCase()}`;
  // Keep what an account from before step tracking already has (its deploy date), but
  // only if that record is for this same account.
  const found = ((await read(key)) ?? {}) as { safeAddress?: string; deployedAt?: string };
  const stored = found.safeAddress?.toLowerCase() === o.safeAddress.toLowerCase() ? found : {};
  await write(key, {
    safeAddress: o.safeAddress,
    agentWallet: o.agent,
    deployedAt: stored.deployedAt ?? now(),
  });
  const profile = await readUserProfile(o.user);
  await writeUserProfile(o.user, {
    ...profile,
    address: o.user,
    safeAddress: o.safeAddress,
    riskTolerance: profile.riskTolerance || "moderate",
    preferredTokens: profile.preferredTokens || ["USDC", "WETH", "ETH"],
    createdAt: profile.createdAt || now(),
    updatedAt: now(),
  });
}
