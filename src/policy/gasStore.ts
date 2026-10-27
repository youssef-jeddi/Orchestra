// ─── Policy — network fees store: what the relayer paid per account, and the budget check (ORC-31) ───
// Impure companion to ./gasBudget.ts. Every path where the relayer sends a transaction records its
// receipt here (`noteRelayerGas`), and every path that sends one for a user's action asks first
// (`assertGasBudget`). One record per account per UTC day under `gas/<account>/<YYYY-MM-DD>`, so the
// check reads one record, and cost tracking (ORC-48) can read them all with `readGasHistory`.
//
// Fails closed: a day that can't be read, or reads as damaged, refuses the action (nothing is sent).
// Recording never fails the user's action (the transaction is already mined): a failed save keeps
// the row in memory, so it still counts, and the next save of that day writes it too. Like the
// activity store, memory is authoritative for one bridge process.

import { read, write, readMany } from "../integrations/zero-g/storage";
import { injectFault, faultOn } from "../utils/faultInject";
import { UserFacingError } from "../utils/userFacing";
import { safeErr, shortAddr } from "../utils/redact";
import {
  type GasDay, type GasKind, type GasRow, type GasBudgetStatus,
  gasDay, gasDayKey, parseGasDay, gasRowFromReceipt, gasBudgetStatus, DAILY_GAS_BUDGET,
  GAS_OVER_BUDGET_TEXT, GAS_UNREADABLE_TEXT,
} from "./gasBudget";

const dayCache = new Map<string, GasDay>();
/** Rows recorded while their day couldn't be loaded; merged in when it next loads. */
const pending = new Map<string, GasRow[]>();
const locks = new Map<string, Promise<unknown>>();

/** One update of a day at a time, so two receipts landing together can't overwrite each other. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  return run;
}

async function loadDay(account: string, day: string): Promise<GasDay> {
  const key = gasDayKey(account, day);
  const cached = dayCache.get(key);
  if (cached) return cached;
  await injectFault("gas-read");
  const doc = parseGasDay(await read(key), account, day); // a read error or a damaged record throws
  for (const p of pending.get(key) ?? []) if (!doc.rows.some((r) => r.txHash === p.txHash)) doc.rows.push(p);
  pending.delete(key);
  dayCache.set(key, doc);
  return doc;
}

/** Where an account stands today. Throws when today's record can't be read. */
export async function gasStatusToday(account: string, now: number = Date.now()): Promise<GasBudgetStatus> {
  const day = gasDay(now);
  const doc = await withLock(gasDayKey(account, day), () => loadDay(account, day));
  const status = gasBudgetStatus(doc.rows, DAILY_GAS_BUDGET);
  // Dev-only: read as used up, to see the refusal without spending gas. Never on in production.
  if (faultOn("gas-over-budget")) return { ...status, overBudget: true };
  return status;
}

/**
 * Refuse before sending when the account's network fees for today are used up, or can't be read.
 * Called by every path that has the relayer send for a user's action (not by account setup).
 */
export async function assertGasBudget(account: string): Promise<void> {
  let status: GasBudgetStatus;
  try {
    status = await gasStatusToday(account);
  } catch (err) {
    console.error(`[gas] couldn't read today's network fees for ${shortAddr(account)} (${safeErr(err)}); nothing sent`);
    throw new UserFacingError(GAS_UNREADABLE_TEXT, 503);
  }
  if (status.overBudget) {
    console.warn(`[gas] ${shortAddr(account)} is over today's network fee budget; nothing sent`);
    throw new UserFacingError(GAS_OVER_BUDGET_TEXT, 429);
  }
}

/** Add one paid transaction to its account's day. Never throws. */
export async function recordGasRow(account: string, row: GasRow): Promise<void> {
  const day = gasDay(Date.parse(row.at) || Date.now());
  const key = gasDayKey(account, day);
  await withLock(key, async () => {
    let doc: GasDay;
    try {
      doc = await loadDay(account, day);
    } catch (err) {
      console.error(`[gas] couldn't load ${shortAddr(account)}'s day to record a fee (${safeErr(err)}); kept in memory`);
      pending.set(key, [...(pending.get(key) ?? []), row]);
      return;
    }
    if (doc.rows.some((r) => r.txHash === row.txHash)) return; // the same receipt twice counts once
    doc.rows.push(row); // counts from now on, whatever the save does
    saveSoon(key, account);
  });
}

const saving = new Map<string, Promise<void>>();

/**
 * Save the day in the background (0G writes can take seconds; the user's answer shouldn't wait).
 * Saves run one after another and each writes the latest copy, so an older one can't land last.
 */
function saveSoon(key: string, account: string): Promise<void> {
  const run = (saving.get(key) ?? Promise.resolve()).then(async () => {
    const doc = dayCache.get(key);
    if (!doc) return;
    try {
      await write(key, { ...doc, rows: [...doc.rows] });
    } catch (err) {
      console.error(`[gas] couldn't save a fee record for ${shortAddr(account)} (${safeErr(err)}); it still counts, saved with the next one`);
    }
  });
  saving.set(key, run);
  return run;
}

/** Test hook: wait for background saves. */
export async function _gasSaved(): Promise<void> {
  await Promise.all([...saving.values()]);
}

type ReceiptLike = { gasUsed?: bigint | string | number | null; gasPrice?: bigint | string | number | null; effectiveGasPrice?: bigint | string | number | null } | null | undefined;

/** Fetches a receipt by hash when the sender's own receipt lacks the numbers (e.g. the Safe SDK's). */
export type ReceiptFetcher = (txHash: string) => Promise<ReceiptLike>;

let defaultFetcher: ReceiptFetcher = async (txHash) => {
  const { makeSepoliaProvider } = await import("../utils/rpc");
  return makeSepoliaProvider().getTransactionReceipt(txHash);
};

/**
 * Record what the relayer paid for a mined transaction (reverted ones too: the gas is spent
 * either way). Never throws, so a bookkeeping problem can't turn a sent transaction into an error.
 */
export async function noteRelayerGas(input: {
  account: string; kind: GasKind; txHash: string; receipt?: ReceiptLike; wallet?: string;
}, fetchReceipt: ReceiptFetcher = defaultFetcher): Promise<void> {
  try {
    if (!input.account || !input.txHash) return;
    let row = gasRowFromReceipt(input.receipt, input);
    if (!row) row = gasRowFromReceipt(await fetchReceipt(input.txHash), input);
    if (!row) { console.warn(`[gas] no receipt numbers for ${input.txHash}; fee not recorded`); return; }
    await recordGasRow(input.account, row);
  } catch (err) {
    console.error(`[gas] couldn't record a fee (${safeErr(err)})`);
  }
}

/**
 * Every stored day (all accounts, or one), oldest first: the raw data for cost tracking (ORC-48).
 * A record that can't be read throws, like readMany.
 */
export async function readGasHistory(account?: string): Promise<GasDay[]> {
  const rows = (await readMany(account ? `gas/${account.toLowerCase()}` : "gas")) as any[];
  return rows
    .filter((d) => d && d.v === 1 && typeof d.account === "string" && typeof d.day === "string")
    .map((d) => parseGasDay(d, d.account, d.day))
    .sort((a, b) => a.day.localeCompare(b.day) || a.account.localeCompare(b.account));
}

/** What GET /gas returns for /simple: today's fees paid for the account, as decimal wei strings. */
export async function gasView(account: string | null | undefined): Promise<{ day: string; coveredWei: string; coveredTxs: number; overBudget: boolean }> {
  const day = gasDay();
  if (!account) return { day, coveredWei: "0", coveredTxs: 0, overBudget: false };
  const s = await gasStatusToday(account);
  return { day, coveredWei: s.coveredWei.toString(), coveredTxs: s.coveredTxs, overBudget: s.overBudget };
}

/** Test hooks. */
export function _resetGasStore(): void {
  dayCache.clear();
  pending.clear();
  locks.clear();
  saving.clear();
}
export function _setReceiptFetcher(f: ReceiptFetcher): void {
  defaultFetcher = f;
}
