// ─── Safe — the on-chain $1000/day cap (SpendingLimitModule) ───
// When SPENDING_MODULE_ADDRESS is set, the agent is not an owner of new accounts: it moves funds
// only through SpendingLimitModule.exec(safe, calls[]), Call-only (no MultiSend / DelegateCall).
// Unset, nothing here is used and the owner path runs as before.
// Owner-sign fallback for an over-cap request is in ownerSign.ts (owner may still use MultiSend).

import { ethers } from "ethers";
import Safe from "@safe-global/protocol-kit";
import { UserFacingError, OverCapError } from "../../utils/userFacing";
import { makeSepoliaProvider, sepoliaRpcUrl } from "../../utils/rpc";
import { safeErr } from "../../utils/redact";
import { safeGasLimit } from "./transaction";
import { faultOn } from "../../utils/faultInject";

export const SPENDING_MODULE_ABI = [
  "function exec(address safe, (address to, uint256 value, bytes data)[] calls)",
  "function remainingToday(address safe) view returns (uint256)",
  "function spentToday(address safe) view returns (uint256)",
  "function DAILY_LIMIT_CENTS() view returns (uint256)",
  "error DailyLimitExceeded(uint256 spentCents, uint256 wouldSpendCents, uint256 limitCents)",
  "error ExecFailed()",
  "error TargetNotAllowed()",
  "error SelectorNotAllowed()",
  "error BadSpender()",
  "error BadRecipient()",
  "error BadToken()",
  "error BlockedTarget()",
  "error StalePrice()",
  "error BadPrice()",
  "error EmptyBatch()",
];

/** The module's fixed daily ceiling, for wording only; the contract is what enforces it. */
export const DAILY_CAP_USD = 1000;

/** Safe operation codes (owner-sign path only; the module never DelegateCalls). */
export const OPERATION = { Call: 0, DelegateCall: 1 } as const;

/** The configured module (checksummed), or null when unset or not a valid address. */
export function spendingModuleAddress(): string | null {
  const raw = process.env.SPENDING_MODULE_ADDRESS?.trim();
  if (!raw || !ethers.isAddress(raw)) return null;
  return ethers.getAddress(raw);
}

/** Does this server run the on-chain cap? Unset or malformed means no: behaviour is unchanged. */
export function isSpendingModuleEnabled(): boolean {
  return spendingModuleAddress() !== null;
}

/** What the user reads when a request would go past the on-chain daily ceiling. */
export const OVER_CAP_TEXT =
  `Your account's on-chain daily ceiling is $${DAILY_CAP_USD}, and this would go over what's left today. ` +
  "You can sign this yourself with your wallet as the account owner, or try again after the daily reset.";

/** Same limit, when signing it yourself isn't available for this session. */
export const OVER_CAP_NO_OWNER_TEXT =
  `Your account's on-chain daily ceiling is $${DAILY_CAP_USD}, and this would go over what's left today. ` +
  "Try a smaller amount, or try again after the daily reset.";

export { OverCapError };

/** The module reverted with DailyLimitExceeded (the real spend went past the ceiling). */
export class DailyCapRevert extends Error {}

/** Tolerance on the USD estimate: the contract measures the real outflow, this is only the early check. */
const ESTIMATE_TOLERANCE_PERCENT = 1n;

/**
 * Would a request worth `valueUsd` go past what's left of today's ceiling (`remainingCents`)?
 * Pure; an unreadable amount fails closed (counts as over).
 */
export function exceedsRemaining(valueUsd: number, remainingCents: bigint): boolean {
  if (!Number.isFinite(valueUsd) || valueUsd < 0) return true;
  const cents = BigInt(Math.ceil(valueUsd * 100));
  const allowed = remainingCents + (remainingCents * ESTIMATE_TOLERANCE_PERCENT) / 100n;
  return cents > allowed;
}

/** Cents the account can still spend today through the module. */
export async function remainingToday(safeAddress: string, provider: ethers.ContractRunner = makeSepoliaProvider()): Promise<bigint> {
  // Dev-only: pretend nothing is left today so the over-cap path can be exercised without funding.
  if (faultOn("remaining-zero")) return 0n;
  const module = new ethers.Contract(spendingModuleAddress()!, SPENDING_MODULE_ABI, provider);
  return BigInt(await module.remainingToday(safeAddress));
}

export interface SafeCall {
  to: string;
  value: string;
  data: string;
  operation: number;
}

/**
 * Encode a batch the way the Safe owner path would (including MultiSend for several steps).
 * Used only for the owner-sign fallback — the module path never DelegateCalls.
 */
export async function safeCallFor(safeAddress: string, transactions: Array<{ to: string; value: string; data: string }>): Promise<SafeCall & { nonce: number }> {
  const safe = await Safe.init({ provider: sepoliaRpcUrl(), safeAddress });
  const tx = await safe.createTransaction({ transactions });
  const d = tx.data;
  return { to: d.to, value: String(d.value), data: d.data, operation: Number(d.operation), nonce: Number(d.nonce) };
}

/** Did this error come from the module's DailyLimitExceeded revert? */
export function isDailyCapRevert(err: any): boolean {
  return err?.revert?.name === "DailyLimitExceeded" || err?.errorName === "DailyLimitExceeded";
}

/**
 * Run a batch through SpendingLimitModule.exec(safe, calls[]) with the agent key.
 * Each step is a Call checked by the module; no MultiSend. A DailyLimitExceeded revert
 * throws DailyCapRevert.
 */
export async function execViaModule(
  safeAddress: string,
  agentPrivateKey: string,
  transactions: Array<{ to: string; value: string; data: string }>,
  fallbackGasLimit?: string,
): Promise<string> {
  const calls = transactions.map((t) => ({
    to: t.to,
    value: t.value ?? "0",
    data: t.data && t.data !== "" ? t.data : "0x",
  }));
  const wallet = new ethers.Wallet(agentPrivateKey, makeSepoliaProvider());
  const module = new ethers.Contract(spendingModuleAddress()!, SPENDING_MODULE_ABI, wallet);
  const args = [safeAddress, calls] as const;

  let capRevert = false;
  let gasLimit: string | undefined;
  try {
    gasLimit = await safeGasLimit(async () => {
      try {
        return await module.exec.estimateGas(...args);
      } catch (err: any) {
        if (isDailyCapRevert(err)) capRevert = true;
        throw err;
      }
    }, fallbackGasLimit);
  } catch (err) {
    if (capRevert) throw new DailyCapRevert("DailyLimitExceeded");
    throw err;
  }

  const tx = await module.exec(...args, gasLimit ? { gasLimit } : {});
  const receipt = await tx.wait();
  if (receipt && Number(receipt.status) === 0) {
    console.error(`[safe] module transaction reverted on-chain: ${tx.hash}`);
    throw new UserFacingError(`This didn't go through, so your funds were not moved. You can see what happened here: https://sepolia.etherscan.io/tx/${tx.hash}`);
  }
  return tx.hash;
}

/** Log a read failure without its detail reaching the user. */
export function logCapReadFailure(err: unknown): void {
  console.warn(`[safe] couldn't read today's remaining ceiling: ${safeErr(err)}`);
}
