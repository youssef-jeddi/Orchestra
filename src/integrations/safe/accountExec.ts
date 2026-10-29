// ─── Safe — how a batch reaches the chain: owner path or the capped module ───
// Every adapter runs its batch through `executeForAccount`. Unset SPENDING_MODULE_ADDRESS keeps the
// owner path exactly as before. With the module set, the agent calls SpendingLimitModule.exec, and
// before that the day's remaining ceiling is read: a request over it never reaches the module and
// comes back as an OverCapError carrying the offer to sign it as the owner (see ownerSign.ts).
// The contract enforces the same ceiling, so a wrong estimate here still can't move extra funds.
// v1 or v2 is read from the module itself: v1 signs with the shared key, v2 has the account's own
// key sign and the shared key only relay (ORC-38). v2 needs the signed-in wallet to find that key.
// Before anything else, the account's network fee allowance for today is checked (ORC-31): over it,
// or unreadable, nothing is sent and no owner-sign offer is made.

import { UserFacingError } from "../../utils/userFacing";
import {
  isSpendingModuleEnabled, remainingToday, exceedsRemaining, execViaModule, execViaModuleV2, isDailyCapRevert,
  DailyCapRevert, OverCapError, OVER_CAP_TEXT, OVER_CAP_NO_OWNER_TEXT, logCapReadFailure,
  moduleVersion, spendingModuleAddress, AGENT_MISSING_TEXT,
} from "./spendingModule";
import { executeBatchViaSafe } from "./transaction";
import { offerOwnerSign } from "./ownerSign";
import { assertGasBudget } from "../../policy/gasStore";

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
  /** Recipient / token, kept with the owner-sign offer so the activity list can show them afterwards. */
  to?: string;
  token?: string;
  /** What the plan says it sends; the browser checks the owner-sign transaction against it (ORC-113). */
  amount?: string;
  symbol?: string;
}

export interface AccountExecDeps {
  /** Throws when the account's network fees for today are used up or can't be read (ORC-31). */
  gasBudget: (safeAddress: string) => Promise<void>;
  enabled: () => boolean;
  remainingCents: (safeAddress: string) => Promise<bigint>;
  /** `key` is the shared key (v1: the agent; v2: only the relayer); `wallet` finds the account's own key on v2. */
  viaModule: (safeAddress: string, key: string, batch: Batch, fallback?: string, wallet?: string) => Promise<string>;
  viaOwner: (safeAddress: string, key: string, batch: Batch, fallback?: string) => Promise<string>;
  /** Hold the exact Safe transaction for the owner to sign; null when that isn't possible. */
  offer: (wallet: string, safeAddress: string, summary: string, batch: Batch, meta: OfferMeta) => Promise<Record<string, unknown> | null>;
}

export interface OfferMeta { valueUsd: number; to?: string; token?: string; amount?: string; symbol?: string }

const realDeps: AccountExecDeps = {
  gasBudget: assertGasBudget,
  enabled: isSpendingModuleEnabled,
  remainingCents: (safe) => remainingToday(safe),
  viaModule: async (safe, key, batch, fallback, wallet) => {
    if ((await moduleVersion(spendingModuleAddress()!)) < 2) return execViaModule(safe, key, batch, fallback);
    // Without the account's wallet there is no key to sign with: refuse rather than guess.
    if (!wallet) throw new UserFacingError(AGENT_MISSING_TEXT, 409);
    return execViaModuleV2(safe, wallet, key, batch, fallback);
  },
  viaOwner: executeBatchViaSafe,
  offer: async (wallet, safe, summary, batch, meta) => {
    try {
      return await offerOwnerSign(wallet, safe, summary, batch, meta);
    } catch (err) {
      logCapReadFailure(err);
      return null;
    }
  },
};

async function overCap(input: AccountExecInput, deps: AccountExecDeps): Promise<OverCapError> {
  const ownerSign = input.wallet ? await deps.offer(input.wallet, input.safeAddress, input.summary ?? "", input.batch, {
    valueUsd: input.valueUsd, to: input.to, token: input.token,
    ...(input.amount !== undefined ? { amount: input.amount } : {}), ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
  }) : null;
  return new OverCapError(ownerSign ? OVER_CAP_TEXT : OVER_CAP_NO_OWNER_TEXT, ownerSign ?? undefined);
}

/** Run a batch through the account: the owner path, or (module set) the capped module path. */
export async function executeForAccount(input: AccountExecInput, deps: AccountExecDeps = realDeps): Promise<string> {
  await deps.gasBudget(input.safeAddress); // first: over budget, nothing is read, offered or sent
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
    return await deps.viaModule(input.safeAddress, input.agentKey, input.batch, input.fallbackGasLimit, input.wallet);
  } catch (err) {
    // The real spend (measured by the contract) went past what the estimate said.
    if (err instanceof DailyCapRevert || isDailyCapRevert(err)) throw await overCap(input, deps);
    throw err;
  }
}

/**
 * Whether `valueUsd` still fits in the account's on-chain daily ceiling (always true without the
 * module). Asked once before a multi-step plan starts (ORC-21), so a plan that can't finish on the
 * agent's own allowance is answered in plain words before its first step runs. Fails closed: an
 * unreadable ceiling throws the same plain error as a single request.
 */
export async function fitsDailyCeiling(safeAddress: string, valueUsd: number, deps: Pick<AccountExecDeps, "enabled" | "remainingCents"> = realDeps): Promise<boolean> {
  if (!deps.enabled()) return true;
  let remaining: bigint;
  try {
    remaining = await deps.remainingCents(safeAddress);
  } catch (err) {
    logCapReadFailure(err);
    throw new UserFacingError("I couldn't check your account's daily ceiling just now, so nothing was sent. Please try again in a moment.", 503);
  }
  return !exceedsRemaining(valueUsd, remaining);
}
