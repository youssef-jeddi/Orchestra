// ─── Safe — how a batch reaches the chain: owner path or the capped module ───
// Every adapter runs its batch through `executeForAccount`. Unset SPENDING_MODULE_ADDRESS keeps the
// owner path exactly as before. With the module set, the agent calls SpendingLimitModule.exec, and
// before that the day's remaining ceiling is read: a request over it never reaches the module and
// comes back as an OverCapError carrying the offer to sign it as the owner (see ownerSign.ts).
// The contract enforces the same ceiling, so a wrong estimate here still can't move extra funds.

import { UserFacingError } from "../../utils/userFacing";
import {
  isSpendingModuleEnabled, remainingToday, exceedsRemaining, execViaModule, isDailyCapRevert,
  DailyCapRevert, OverCapError, OVER_CAP_TEXT, OVER_CAP_NO_OWNER_TEXT, logCapReadFailure,
} from "./spendingModule";
import { executeBatchViaSafe } from "./transaction";
import { offerOwnerSign } from "./ownerSign";

export type Batch = Array<{ to: string; value: string; data: string }>;

export interface AccountExecInput {
  safeAddress: string;
  agentKey: string;
  batch: Batch;
  fallbackGasLimit?: string;
  /** Estimated USD value of the plan (what the early cap check compares). */
  valueUsd: number;
  /** The signed-in wallet, who may sign an over-cap request themselves. */
  wallet?: string;
  summary?: string;
}

export interface AccountExecDeps {
  enabled: () => boolean;
  remainingCents: (safeAddress: string) => Promise<bigint>;
  viaModule: (safeAddress: string, key: string, batch: Batch, fallback?: string) => Promise<string>;
  viaOwner: (safeAddress: string, key: string, batch: Batch, fallback?: string) => Promise<string>;
  /** Hold the exact Safe transaction for the owner to sign; null when that isn't possible. */
  offer: (wallet: string, safeAddress: string, summary: string, batch: Batch) => Promise<Record<string, unknown> | null>;
}

const realDeps: AccountExecDeps = {
  enabled: isSpendingModuleEnabled,
  remainingCents: (safe) => remainingToday(safe),
  viaModule: execViaModule,
  viaOwner: executeBatchViaSafe,
  offer: async (wallet, safe, summary, batch) => {
    try {
      return await offerOwnerSign(wallet, safe, summary, batch);
    } catch (err) {
      logCapReadFailure(err);
      return null;
    }
  },
};

async function overCap(input: AccountExecInput, deps: AccountExecDeps): Promise<OverCapError> {
  const ownerSign = input.wallet ? await deps.offer(input.wallet, input.safeAddress, input.summary ?? "", input.batch) : null;
  return new OverCapError(ownerSign ? OVER_CAP_TEXT : OVER_CAP_NO_OWNER_TEXT, ownerSign ?? undefined);
}

/** Run a batch through the account: the owner path, or (module set) the capped module path. */
export async function executeForAccount(input: AccountExecInput, deps: AccountExecDeps = realDeps): Promise<string> {
  if (!deps.enabled()) return deps.viaOwner(input.safeAddress, input.agentKey, input.batch, input.fallbackGasLimit);

  let remaining: bigint;
  try {
    remaining = await deps.remainingCents(input.safeAddress);
  } catch (err) {
    // Fails closed: without today's figure nothing goes to the module.
    logCapReadFailure(err);
    throw new UserFacingError("I couldn't check your account's daily ceiling just now, so nothing was sent. Please try again in a moment.", 503);
  }
  if (exceedsRemaining(input.valueUsd, remaining)) throw await overCap(input, deps);

  try {
    return await deps.viaModule(input.safeAddress, input.agentKey, input.batch, input.fallbackGasLimit);
  } catch (err) {
    // The real spend (measured by the contract) went past what the estimate said.
    if (err instanceof DailyCapRevert || isDailyCapRevert(err)) throw await overCap(input, deps);
    throw err;
  }
}
