// ─── Policy — changing the daily limit with the owner's on-chain transaction ───
// Library behind POST /prepare-limit-update and /finalize-limit-update (the older page and the
// Ledger UI). The owner signs a Safe transaction; once the chain shows it, the enforced limit
// (`policy.dailyLimitUsd`, what the policy engine reads) is changed through the same rules as
// POST /policy (limits.ts): lowering applies at once; raising needs the wallet's passkey if it has
// one (the owner's own transaction stands in for the wallet signature when it has none) and sends
// the Telegram notice. Everything outside the library (chain reads, storage, the registry) comes
// in through `deps`, so the rules are tested without a network.

import { parseWholeDollarLimit, MAX_DAILY_LIMIT } from "./index";
import { applyChange, classifyChange, parseChange, proofToRaise, requestConfirmation, LimitsError } from "./limits";
import { readUserProfile } from "./store";
import { formatUsd } from "./money";
import { limitTxProblem, limitTxTooOld, type LimitTxInput } from "../integrations/safe/verifyLimitTx";
import { ACCOUNT_NOT_READY_REASON } from "../integrations/safe/onboarding";
import type { RelyingParty } from "../integrations/passkey";
import { safeErr } from "../utils/redact";

export interface LimitUpdateDeps {
  /** Is the wallet's account fully set up? Fails closed. */
  isReady(wallet: string): Promise<boolean>;
  /** The stored account record (`safe:<wallet>`), or null. */
  account(wallet: string): Promise<(Record<string, any> & { safeAddress?: string }) | null>;
  saveAccount(wallet: string, record: Record<string, any>): Promise<void>;
  /** The transaction the owner must send for this limit (also the calldata the chain tx is compared with). */
  buildTx(safeAddress: string, wallet: string, limitUsd: number): { to: string; data: string; value: string; gasLimit: number };
  fetchTx(txHash: string): Promise<{ tx: LimitTxInput["tx"]; receipt: LimitTxInput["receipt"]; minedAtMs: number | null }>;
  /** A raise may use each owner transaction once. */
  txUsed(txHash: string): Promise<boolean>;
  markTxUsed(txHash: string, wallet: string): Promise<void>;
  /** Write the limit to the registry; throws when it can't. Nothing to do when there is no registry. */
  updateRegistry(safeAddress: string, limitUsd: number): Promise<void>;
  notify?: (wallet: string, text: string) => Promise<void>;
  rp: RelyingParty;
  now?: () => number;
}

export const LIMIT_NOT_SAVED = "I couldn't save your new limit. Please try again in a moment.";
export const REGISTRY_NOT_UPDATED = "Your limit is lowered. The public record of it couldn't be updated this time, which doesn't make anything less safe.";
export const LIMIT_TX_UNREADABLE = "I couldn't check the network for your transaction right now, so your limit wasn't changed. Please try again in a moment.";
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The chain reads behind `fetchTx`. A read that fails or times out is a 503 of its own: it must
 * not look like "the transaction isn't mined yet" (the node answered null) or "too old" (no block time).
 */
export async function readLimitTx(reads: {
  tx(): Promise<LimitTxInput["tx"]>;
  receipt(): Promise<{ status: number | null; blockNumber: number } | null>;
  blockTimeMs(blockNumber: number): Promise<number | null>;
}): Promise<{ tx: LimitTxInput["tx"]; receipt: LimitTxInput["receipt"]; minedAtMs: number | null }> {
  try {
    const [tx, receipt] = await Promise.all([reads.tx(), reads.receipt()]);
    const minedAtMs = receipt ? await reads.blockTimeMs(receipt.blockNumber) : null;
    if (receipt && minedAtMs === null) throw new Error("the block of the receipt is not available");
    return { tx, receipt, minedAtMs };
  } catch (err) {
    console.error(`[limit-update] couldn't read the transaction: ${safeErr(err)}`);
    throw new LimitsError(503, LIMIT_TX_UNREADABLE, "chain_unreadable");
  }
}

/** The requested limit as whole dollars, or a plain refusal. */
export function requireLimit(value: unknown): number {
  const limit = parseWholeDollarLimit(value);
  if (limit === null) throw new LimitsError(400, `Choose a whole number of dollars from $0 to ${formatUsd(MAX_DAILY_LIMIT)}.`);
  return limit;
}

/** The wallet's account record, once its setup is finished; otherwise a plain refusal. */
async function readyAccount(wallet: string, deps: LimitUpdateDeps): Promise<{ record: Record<string, any>; safeAddress: string }> {
  const record = await deps.account(wallet);
  if (!record?.safeAddress || !(await deps.isReady(wallet))) throw new LimitsError(409, ACCOUNT_NOT_READY_REASON, "account_not_ready");
  return { record, safeAddress: record.safeAddress };
}

export interface PreparedLimitUpdate {
  unsignedTx: { to: string; data: string; value: string; gasLimit: number };
  /** "passkey": after the transaction is sent, finalizing will ask for the passkey (a raise on a wallet that has one). */
  confirmation: "none" | "passkey";
}

/** Step 1: the transaction the owner signs, and whether finalizing will need a passkey. */
export async function prepareLimitUpdate(wallet: string, body: any, deps: LimitUpdateDeps): Promise<PreparedLimitUpdate> {
  const limit = requireLimit(body?.newLimitUSD);
  const { safeAddress } = await readyAccount(wallet, deps);
  // Refuse a raise that can't be finished (an email wallet with no passkey) before the owner pays gas for it.
  const confirmation = await proofToRaise(wallet, { policy: { dailyLimitUsd: limit } });
  return { unsignedTx: deps.buildTx(safeAddress, wallet, limit), confirmation };
}

export interface FinalizedLimitUpdate {
  success: true;
  limitUsd: number;
  raised: boolean;
  /** Something the user should know although the limit is saved. */
  notice?: string;
}

/**
 * Step 2, after the owner's transaction is mined. Only the exact transaction from this wallet to
 * its own account counts, and only a recent one; a raise may use each transaction once.
 * Raising: passkey proof (if any), then the registry, then the limit; a failed registry write saves
 * nothing, and the same call can be repeated with the same transaction. Lowering: saved first, since
 * stricter is always safe; a failed registry write is only logged and noted.
 */
export async function finalizeLimitUpdate(wallet: string, body: any, deps: LimitUpdateDeps): Promise<FinalizedLimitUpdate> {
  const now = deps.now?.() ?? Date.now();
  const limit = requireLimit(body?.newLimitUSD);
  const txHash = body?.txHash;
  if (typeof txHash !== "string" || !TX_HASH.test(txHash)) throw new LimitsError(400, "Send the transaction you signed to confirm the change.");
  const { record, safeAddress } = await readyAccount(wallet, deps);

  const { tx, receipt, minedAtMs } = await deps.fetchTx(txHash);
  const problem = limitTxProblem({ tx, receipt, wallet, safeAddress, expectedData: deps.buildTx(safeAddress, wallet, limit).data });
  if (problem) throw new LimitsError(400, `Limit not updated: ${problem}`);
  if (limitTxTooOld(minedAtMs, now)) throw new LimitsError(400, "Limit not updated: that transaction is too old to use. Start the change again.");

  const change = { policy: { dailyLimitUsd: limit } };
  const stored = (await readUserProfile(wallet)).policy ?? {};
  const raising = classifyChange(stored, parseChange(change)) === "loosening";
  const saveRecord = () => deps.saveAccount(wallet, { ...record, spendingLimitUSD: limit });

  if (!raising) {
    await applyChange(wallet, change, deps.rp, deps.notify, now, { ownerTx: true });
    await saveRecord();
    let notice: string | undefined;
    try {
      await deps.updateRegistry(safeAddress, limit);
    } catch (err) {
      console.error(`[limit-update] limit lowered, but the registry wasn't updated: ${safeErr(err)}`);
      notice = REGISTRY_NOT_UPDATED;
    }
    return { success: true, limitUsd: limit, raised: false, ...(notice ? { notice } : {}) };
  }

  if (await deps.txUsed(txHash)) throw new LimitsError(409, "That transaction was already used to change your limit. Start the change again.");
  if (!body?.confirmation) {
    // A wallet with a passkey answers a challenge for these exact values; the retry carries the answer.
    const ask = await requestConfirmation(wallet, change, deps.rp, now, { ownerTx: true });
    if (ask.required && ask.method === "passkey") {
      throw new LimitsError(403, "Confirm with your passkey to raise your limit.", "confirmation_required", { method: "passkey", nonce: ask.nonce, options: ask.options });
    }
  }
  await applyChange(wallet, { ...change, confirmation: body?.confirmation }, deps.rp, deps.notify, now, {
    ownerTx: true,
    beforeSave: async () => {
      try {
        await deps.updateRegistry(safeAddress, limit);
      } catch (err) {
        console.error(`[limit-update] raise not saved, the registry wasn't updated: ${safeErr(err)}`);
        throw new LimitsError(503, LIMIT_NOT_SAVED, "limit_not_saved");
      }
    },
  });
  await saveRecord();
  await deps.markTxUsed(txHash, wallet);
  return { success: true, limitUsd: limit, raised: true };
}
