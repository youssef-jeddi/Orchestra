// ─── Policy — network fee budget tests (ORC-31): what the relayer paid, and refusing past the cap ───
// No network: receipts are plain objects, the chain senders are injected, storage is in memory.
// Run with `npm run test:gas-budget`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  DAILY_GAS_BUDGET, GAS_OVER_BUDGET_TEXT, GAS_UNREADABLE_TEXT, gasDay, gasDayKey, gasRowFromReceipt, gasBudgetStatus,
  parseGasDay, sumGas, type GasRow,
} from "./gasBudget";
import {
  assertGasBudget, gasStatusToday, recordGasRow, noteRelayerGas, readGasHistory, gasView, _resetGasStore, _gasSaved,
} from "./gasStore";
import * as storage from "../integrations/zero-g/storage";
import { executeForAccount, type AccountExecDeps } from "../integrations/safe/accountExec";
import { holdOwnerSign, submitOwnerSignature, clearOwnerSignRecords, SAFE_TX_TYPES } from "../integrations/safe/ownerSign";
import { faultOn, faultInjectProblem } from "../utils/faultInject";
import { UserFacingError } from "../utils/userFacing";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { gasLine, formatEthAmount, GAS_USED_UP } from "../../frontend/src/lib/gas.js";

let passed = 0;
const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const SAFE = "0x00000000000000000000000000000000000000d4";
const OTHER = "0x00000000000000000000000000000000000000d5";
const owner = ethers.Wallet.createRandom();
let n = 0;
const hash = () => "0x" + (++n).toString(16).padStart(64, "0");
const GWEI = 10n ** 9n;

/** A row as a receipt would give it, at `at` (default now). */
function row(gasUsed: bigint, priceWei: bigint, kind: GasRow["kind"] = "action", at?: string): GasRow {
  return gasRowFromReceipt({ gasUsed, gasPrice: priceWei }, { txHash: hash(), kind, at })!;
}
const env = (vars: Record<string, string>) => ({ STORAGE_BACKEND: "memory", ...vars }) as NodeJS.ProcessEnv;

// ─── The pure part ───

test("a receipt's cost is gasUsed × effectiveGasPrice, kept as decimal strings", () => {
  const r = gasRowFromReceipt({ gasUsed: 120_000n, effectiveGasPrice: 3n * GWEI, gasPrice: 99n }, { txHash: "0x1", kind: "action", wallet: owner.address })!;
  assert.equal(r.gasUsed, "120000");
  assert.equal(r.effectiveGasPrice, String(3n * GWEI));
  assert.equal(r.costWei, String(360_000n * GWEI));
  assert.equal(r.wallet, owner.address.toLowerCase());
  // ethers v6 receipts call it gasPrice
  assert.equal(gasRowFromReceipt({ gasUsed: "10", gasPrice: "5" }, { txHash: "0x2", kind: "setup" })!.costWei, "50");
});

test("a receipt without the numbers gives no row (nothing is guessed)", () => {
  assert.equal(gasRowFromReceipt(null, { txHash: "0x1", kind: "action" }), null);
  assert.equal(gasRowFromReceipt({ gasUsed: 1n }, { txHash: "0x1", kind: "action" }), null);
  assert.equal(gasRowFromReceipt({ gasUsed: "abc", gasPrice: 1n }, { txHash: "0x1", kind: "action" }), null);
});

test("under both caps is fine; reaching either one is over budget", () => {
  assert.equal(gasBudgetStatus([row(300_000n, GWEI)]).overBudget, false);
  assert.equal(gasBudgetStatus([row(DAILY_GAS_BUDGET.gasUnits, 1n)]).overBudget, true, "gas units cap");
  assert.equal(gasBudgetStatus([row(1_000_000n, DAILY_GAS_BUDGET.wei / 1_000_000n)]).overBudget, true, "ETH cap during a price spike");
  assert.equal(gasBudgetStatus([row(1_000_000n, 1n)], { gasUnits: 2_000_000n, wei: 10n ** 18n }).overBudget, false);
});

test("account setup is shown as covered but never counts toward the budget", () => {
  const s = gasBudgetStatus([row(DAILY_GAS_BUDGET.gasUnits * 2n, GWEI, "setup"), row(100_000n, GWEI)]);
  assert.equal(s.overBudget, false);
  assert.equal(s.usedGasUnits, 100_000n);
  assert.equal(s.coveredWei, (DAILY_GAS_BUDGET.gasUnits * 2n + 100_000n) * GWEI);
  assert.equal(s.coveredTxs, 2);
});

test("relayed owner-signed transactions count toward the budget like actions", () => {
  assert.equal(gasBudgetStatus([row(DAILY_GAS_BUDGET.gasUnits, 1n, "owner-sign")]).overBudget, true);
  assert.equal(sumGas([row(5n, 2n, "owner-sign"), row(1n, 1n, "setup")]).wei, 11n);
});

test("the defaults cover normal daily use: 10 swaps or 30 sends at 10 gwei fit; far more is over", () => {
  const day = [...Array(10)].map(() => row(450_000n, 10n * GWEI)).concat([...Array(20)].map(() => row(150_000n, 10n * GWEI)));
  // 4.5M + 3M = 7.5M > 5M: that is far past normal use, and is over. 10 swaps alone (4.5M) fit.
  assert.equal(gasBudgetStatus(day).overBudget, true);
  assert.equal(gasBudgetStatus(day.slice(0, 10)).overBudget, false);
  assert.equal(gasBudgetStatus([...Array(30)].map(() => row(150_000n, 10n * GWEI))).overBudget, false, "30 sends fit");
});

test("a stored day that looks damaged throws instead of reading as nothing spent", () => {
  assert.deepEqual(parseGasDay(null, SAFE, "2026-10-27").rows, []);
  assert.throws(() => parseGasDay({ v: 1, rows: [{ txHash: "0x1" }] }, SAFE, "2026-10-27"), /damaged/);
  assert.throws(() => parseGasDay("nonsense", SAFE, "2026-10-27"), /damaged/);
  assert.throws(() => parseGasDay({ v: 2, rows: [] }, SAFE, "2026-10-27"), /damaged/);
});

test("days are UTC calendar days and keys sit under gas/ (one record per account and day)", () => {
  assert.equal(gasDay(Date.parse("2026-10-27T23:30:00Z")), "2026-10-27");
  assert.equal(gasDay(Date.parse("2026-10-28T00:00:01Z")), "2026-10-28");
  assert.equal(gasDayKey("0xABCdef0000000000000000000000000000000000", "2026-10-27"), "gas/0xabcdef0000000000000000000000000000000000/2026-10-27");
});

// ─── The store ───

test("recorded fees are saved under the day's key and count at once", async () => {
  const r = row(200_000n, 2n * GWEI);
  await recordGasRow(SAFE, r);
  assert.equal((await gasStatusToday(SAFE)).usedGasUnits, 200_000n);
  await _gasSaved();
  const stored = (await storage.read(gasDayKey(SAFE, gasDay()))) as any;
  assert.equal(stored.v, 1);
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].costWei, String(400_000n * GWEI));
  // Survives a restart (memory cache gone, storage still there)
  _resetGasStore();
  assert.equal((await gasStatusToday(SAFE)).usedWei, 400_000n * GWEI);
});

test("the same receipt recorded twice counts once", async () => {
  const r = row(100_000n, GWEI);
  await recordGasRow(SAFE, r);
  await recordGasRow(SAFE, { ...r });
  assert.equal((await gasStatusToday(SAFE)).coveredTxs, 1);
});

test("receipts landing together are all kept (one update of a day at a time)", async () => {
  await Promise.all([...Array(8)].map(() => recordGasRow(SAFE, row(10_000n, GWEI))));
  await _gasSaved();
  _resetGasStore();
  assert.equal((await gasStatusToday(SAFE)).coveredTxs, 8);
});

test("yesterday's fees don't count today", async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await recordGasRow(SAFE, row(DAILY_GAS_BUDGET.gasUnits, GWEI, "action", yesterday));
  assert.equal((await gasStatusToday(SAFE)).overBudget, false);
  await assertGasBudget(SAFE);
});

test("one account's fees don't touch another's budget", async () => {
  await recordGasRow(SAFE, row(DAILY_GAS_BUDGET.gasUnits, 1n));
  await assert.rejects(assertGasBudget(SAFE), (e: any) => e instanceof UserFacingError && e.message === GAS_OVER_BUDGET_TEXT && e.status === 429);
  await assertGasBudget(OTHER);
});

test("fail closed: an unreadable day refuses with a plain sentence", async () => {
  process.env.ORCHESTRA_FAULT_INJECT = "gas-read";
  try {
    await assert.rejects(assertGasBudget(SAFE), (e: any) => e.message === GAS_UNREADABLE_TEXT && e.status === 503);
  } finally { delete process.env.ORCHESTRA_FAULT_INJECT; }
});

test("fail closed: a damaged stored day refuses (it isn't read as zero)", async () => {
  await storage.write(gasDayKey(SAFE, gasDay()), { v: 1, rows: [{ junk: true }] });
  await assert.rejects(assertGasBudget(SAFE), (e: any) => e.message === GAS_UNREADABLE_TEXT);
  await storage.deleteKey(gasDayKey(SAFE, gasDay()));
});

test("a fee recorded while the day can't be read still counts once it can", async () => {
  process.env.ORCHESTRA_FAULT_INJECT = "gas-read";
  try { await recordGasRow(SAFE, row(DAILY_GAS_BUDGET.gasUnits, 1n)); } finally { delete process.env.ORCHESTRA_FAULT_INJECT; }
  assert.equal((await gasStatusToday(SAFE)).overBudget, true);
});

test("noteRelayerGas fetches the receipt when the sender's has no numbers, and never throws", async () => {
  const fetched: string[] = [];
  const h = hash();
  await noteRelayerGas({ account: SAFE, kind: "action", txHash: h, receipt: { gasUsed: null } as any }, async (x) => { fetched.push(x); return { gasUsed: 50_000n, gasPrice: GWEI }; });
  assert.deepEqual(fetched, [h]);
  assert.equal((await gasStatusToday(SAFE)).usedGasUnits, 50_000n);
  await noteRelayerGas({ account: SAFE, kind: "action", txHash: hash() }, async () => { throw new Error("rpc down"); });
  await noteRelayerGas({ account: SAFE, kind: "action", txHash: hash() }, async () => null);
  assert.equal((await gasStatusToday(SAFE)).coveredTxs, 1);
});

test("readGasHistory gives every stored day (all accounts, or one) for cost tracking", async () => {
  await recordGasRow(SAFE, row(1n, 1n));
  await recordGasRow(SAFE, row(1n, 1n, "action", "2026-01-02T10:00:00.000Z"));
  await recordGasRow(OTHER, row(1n, 1n, "setup"));
  await _gasSaved();
  const all = await readGasHistory();
  assert.equal(all.length, 3);
  assert.deepEqual((await readGasHistory(SAFE)).map((d) => d.day), ["2026-01-02", gasDay()]);
});

test("GET /gas's view: today's covered fees as wei strings; no account means nothing", async () => {
  await recordGasRow(SAFE, row(100n, 3n, "setup"));
  const v = await gasView(SAFE);
  assert.deepEqual(v, { day: gasDay(), coveredWei: "300", coveredTxs: 1, overBudget: false });
  assert.deepEqual(await gasView(null), { day: gasDay(), coveredWei: "0", coveredTxs: 0, overBudget: false });
});

// ─── Every relayer path for a user's action asks first ───

function fakeDeps(calls: string[], gasBudget: AccountExecDeps["gasBudget"]): AccountExecDeps {
  return {
    gasBudget,
    enabled: () => true,
    remainingCents: async () => { calls.push("remaining"); return 100_000n; },
    viaModule: async () => { calls.push("module"); return "0xmodule"; },
    viaOwner: async () => { calls.push("owner"); return "0xowner"; },
    offer: async () => { calls.push("offer"); return { kind: "safe-owner", id: "x" }; },
  };
}
const batch = [{ to: OTHER, value: "1", data: "0x" }];

test("attack: an account over today's fees can't get anything sent, read or offered", async () => {
  await recordGasRow(SAFE, row(DAILY_GAS_BUDGET.gasUnits, 1n));
  for (const enabled of [true, false]) {
    const calls: string[] = [];
    const deps = { ...fakeDeps(calls, assertGasBudget), enabled: () => enabled };
    await assert.rejects(executeForAccount({ safeAddress: SAFE, agentKey: "0x" + "1".repeat(64), batch, valueUsd: 5000, wallet: owner.address }, deps), new RegExp("daily allowance"));
    assert.deepEqual(calls, [], "nothing ran (module, owner path, cap read and owner-sign offer)");
  }
});

test("under budget, executeForAccount runs as before", async () => {
  const calls: string[] = [];
  assert.equal(await executeForAccount({ safeAddress: SAFE, agentKey: "0x" + "1".repeat(64), batch, valueUsd: 1, wallet: owner.address }, fakeDeps(calls, assertGasBudget)), "0xmodule");
  assert.deepEqual(calls, ["remaining", "module"]);
});

test("the dev switch gas-over-budget refuses without spending, and can't turn on in production", async () => {
  process.env.ORCHESTRA_FAULT_INJECT = "gas-over-budget";
  try {
    const calls: string[] = [];
    await assert.rejects(executeForAccount({ safeAddress: OTHER, agentKey: "0x" + "1".repeat(64), batch, valueUsd: 1, wallet: owner.address }, fakeDeps(calls, assertGasBudget)), (e: any) => e.message === GAS_OVER_BUDGET_TEXT);
    assert.deepEqual(calls, []);
    assert.equal((await gasView(OTHER)).overBudget, true);
  } finally { delete process.env.ORCHESTRA_FAULT_INJECT; }
  assert.equal(faultOn("gas-over-budget", env({ ORCHESTRA_FAULT_INJECT: "gas-over-budget", NODE_ENV: "production" })), false);
  assert.equal(faultOn("gas-over-budget", env({ ORCHESTRA_FAULT_INJECT: "gas-over-budget", STORAGE_BACKEND: "0g" })), false);
  assert.equal(faultOn("gas-over-budget", env({ ORCHESTRA_FAULT_INJECT: "gas-over-budget" })), true);
  assert.match(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "gas-over-budget", NODE_ENV: "production" }))!, /production/);
  assert.equal(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "gas-over-budget,gas-read" })), null);
});

const call = { to: OTHER, value: "1000", data: "0x", operation: 0, nonce: 3 };
const hold = () => holdOwnerSign({ wallet: owner.address, safeAddress: SAFE, summary: "Send 1500 USDC", call });
const sign = (r: ReturnType<typeof hold>) => owner.signTypedData(r.domain, SAFE_TX_TYPES, r.message);

test("attack: over today's fees, an owner-signed transaction isn't relayed and stays pending", async () => {
  clearOwnerSignRecords();
  await recordGasRow(SAFE, row(DAILY_GAS_BUDGET.gasUnits, 1n));
  const r = hold();
  const sent: string[] = [];
  await assert.rejects(submitOwnerSignature(owner.address, r.id, await sign(r), { relay: async () => { sent.push("x"); return "0xabc"; } }), (e: any) => e.message === GAS_OVER_BUDGET_TEXT);
  assert.deepEqual(sent, []);
  assert.equal(r.status, "pending");
});

test("an owner-signed transaction under budget is relayed once, even with two submits at once", async () => {
  clearOwnerSignRecords();
  const r = hold();
  const sig = await sign(r);
  const sent: string[] = [];
  const deps = { relay: async () => { sent.push("x"); return "0xabc"; } };
  const results = await Promise.allSettled([submitOwnerSignature(owner.address, r.id, sig, deps), submitOwnerSignature(owner.address, r.id, sig, deps)]);
  assert.equal(sent.length, 1);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
});

// ─── The line on /simple ───

test("/simple's line: plain words, small amounts readable, nothing when nothing was paid", () => {
  assert.equal(gasLine(null), null);
  assert.equal(gasLine({ coveredWei: "0", overBudget: false }), null);
  assert.equal(gasLine({ coveredWei: String(12n * 10n ** 13n), overBudget: false }), "Network fees covered by Orchestra today: 0.00012 ETH.");
  assert.equal(gasLine({ coveredWei: "5400000", overBudget: false }), "Network fees covered by Orchestra today: less than 0.000001 ETH.");
  assert.equal(gasLine({ coveredWei: "0", overBudget: true }), GAS_USED_UP);
  assert.match(gasLine({ coveredWei: String(10n ** 18n + 5n * 10n ** 17n), overBudget: true }), /^Network fees covered by Orchestra today: 1\.5 ETH\. Today's free network fees are used up/);
  assert.equal(formatEthAmount("0"), "0 ETH");
  assert.equal(formatEthAmount("junk"), null);
  for (const s of [GAS_USED_UP, GAS_OVER_BUDGET_TEXT, GAS_UNREADABLE_TEXT]) assert.doesNotMatch(s, /\bgas\b|relayer|paymaster|wei|gwei/i, "no jargon for newcomers");
});

(async () => {
  console.log("gas budget");
  for (const [name, fn] of tests) {
    _resetGasStore();
    await storage.clear();
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
