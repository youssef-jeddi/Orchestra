// ─── Policy — network fees Orchestra pays for each account: the daily budget (ORC-31) ───
// The relayer (AGENT_PRIVATE_KEY) pays the gas for every transaction it sends for a user: account
// setup, automatic and approved actions, and relaying owner-signed transactions. Without a cap, one
// account (a bug, a loop, someone abusing the free fees) could drain the relayer for everyone.
// This file is the pure part: what one transaction cost, what a day of them adds up to, and
// whether an account may have another one paid today. Storage lives in ./gasStore.ts.
// A day is a UTC calendar day, the same unit the stored records are grouped by.

import { ethers } from "ethers";

/** Why the relayer paid: setting up the account, an action it ran, or an owner-signed transaction it relayed. */
export type GasKind = "setup" | "action" | "owner-sign";
export const GAS_KINDS: readonly GasKind[] = ["setup", "action", "owner-sign"];

/** One transaction the relayer paid for. Amounts are decimal strings (bigint-safe JSON). */
export interface GasRow {
  at: string;
  txHash: string;
  kind: GasKind;
  gasUsed: string;
  /** Wei per gas the chain actually charged (the receipt's effectiveGasPrice). */
  effectiveGasPrice: string;
  /** gasUsed × effectiveGasPrice, in wei. */
  costWei: string;
  /** The signed-in wallet the transaction was for, when the sender knew it. */
  wallet?: string;
}

/** One account's paid transactions for one UTC day: the stored record `gas/<account>/<YYYY-MM-DD>`. */
export interface GasDay {
  v: 1;
  account: string;
  day: string;
  rows: GasRow[];
}

/**
 * Per account, per UTC day. Counted on actions and relayed owner-signed transactions; account
 * setup (deployment, registration) is recorded but never blocked or counted, since nothing works
 * without it and onboarding has its own limiter.
 *
 * Gas units: a send through the account is ~100–150k gas, a swap ~300–450k, a liquidity change
 * ~500–700k. 5M gas covers well over 10 swaps or 30 sends a day, far more than normal use, while
 * capping what one account can cost. The ETH cap catches gas-price spikes on Sepolia, where 5M gas
 * at 10 gwei is 0.05 ETH. Whichever is reached first stops further paid transactions that day.
 */
export const DAILY_GAS_BUDGET = {
  gasUnits: 5_000_000n,
  wei: ethers.parseEther("0.05"),
} as const;

export type GasBudget = { gasUnits: bigint; wei: bigint };

/** What the user reads when today's allowance is used up (nothing was sent). */
export const GAS_OVER_BUDGET_TEXT =
  "Orchestra pays the network fees for your account up to a daily allowance, and today's is used up. Nothing was sent and your funds are where they were. Please try again tomorrow.";

/** What the user reads when the allowance can't be checked (nothing was sent: fail closed). */
export const GAS_UNREADABLE_TEXT =
  "I couldn't check today's network fee allowance for your account just now, so nothing was sent. Please try again in a moment.";

/** The UTC day (`YYYY-MM-DD`) a time falls on. */
export function gasDay(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The storage key for one account's day of paid transactions; `gas/` prefixes all of them (readMany("gas")). */
export function gasDayKey(account: string, day: string): string {
  return `gas/${account.toLowerCase()}/${day}`;
}

const isUint = (s: unknown) => typeof s === "string" && /^\d+$/.test(s);

/** A row with valid fields. Anything else in a stored day means the record is damaged. */
export function isGasRow(r: any): r is GasRow {
  return !!r && typeof r === "object" && typeof r.at === "string" && typeof r.txHash === "string"
    && GAS_KINDS.includes(r.kind) && isUint(r.gasUsed) && isUint(r.effectiveGasPrice) && isUint(r.costWei);
}

/** A stored day, checked. A damaged one throws: reading it as "nothing spent" would lift the cap. */
export function parseGasDay(stored: unknown, account: string, day: string): GasDay {
  if (stored === null || stored === undefined) return { v: 1, account: account.toLowerCase(), day, rows: [] };
  const d = stored as any;
  if (!d || d.v !== 1 || !Array.isArray(d.rows) || !d.rows.every(isGasRow)) {
    throw new Error(`damaged gas record ${gasDayKey(account, day)}`);
  }
  return { v: 1, account: account.toLowerCase(), day, rows: d.rows };
}

/** A row from a mined transaction's receipt; null when the receipt lacks the numbers. */
export function gasRowFromReceipt(
  receipt: { gasUsed?: bigint | string | number | null; gasPrice?: bigint | string | number | null; effectiveGasPrice?: bigint | string | number | null } | null | undefined,
  meta: { txHash: string; kind: GasKind; wallet?: string; at?: string },
): GasRow | null {
  if (!receipt) return null;
  const price = receipt.effectiveGasPrice ?? receipt.gasPrice;
  if (receipt.gasUsed === undefined || receipt.gasUsed === null || price === undefined || price === null) return null;
  let gasUsed: bigint, effectiveGasPrice: bigint;
  try { gasUsed = BigInt(receipt.gasUsed); effectiveGasPrice = BigInt(price); } catch { return null; }
  if (gasUsed < 0n || effectiveGasPrice < 0n) return null;
  const row: GasRow = {
    at: meta.at ?? new Date().toISOString(),
    txHash: meta.txHash,
    kind: meta.kind,
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    costWei: (gasUsed * effectiveGasPrice).toString(),
  };
  if (meta.wallet) row.wallet = meta.wallet.toLowerCase();
  return row;
}

/** Totals over rows (all of them, or only those `count` keeps). */
export function sumGas(rows: GasRow[], count: (r: GasRow) => boolean = () => true): { gasUnits: bigint; wei: bigint; txs: number } {
  let gasUnits = 0n, wei = 0n, txs = 0;
  for (const r of rows) {
    if (!count(r)) continue;
    gasUnits += BigInt(r.gasUsed);
    wei += BigInt(r.costWei);
    txs++;
  }
  return { gasUnits, wei, txs };
}

/** Rows that count toward the budget: everything but account setup. */
export const countsTowardBudget = (r: GasRow) => r.kind !== "setup";

export interface GasBudgetStatus {
  overBudget: boolean;
  /** What counted toward today's budget. */
  usedGasUnits: bigint;
  usedWei: bigint;
  /** Everything Orchestra paid for the account today, setup included (what /simple shows). */
  coveredWei: bigint;
  coveredTxs: number;
}

/**
 * Where an account stands today. Over budget once either cap is reached: the check runs before a
 * transaction, so the last one allowed can go past the cap by at most its own gas.
 */
export function gasBudgetStatus(rows: GasRow[], budget: GasBudget = DAILY_GAS_BUDGET): GasBudgetStatus {
  const used = sumGas(rows, countsTowardBudget);
  const all = sumGas(rows);
  return {
    overBudget: used.gasUnits >= budget.gasUnits || used.wei >= budget.wei,
    usedGasUnits: used.gasUnits,
    usedWei: used.wei,
    coveredWei: all.wei,
    coveredTxs: all.txs,
  };
}
