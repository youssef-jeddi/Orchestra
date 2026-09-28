// ─── Uniswap v3 liquidity — math, price guard and calldata (no network) ───
// Run with `npm run test:liquidity`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { setPrices } from "../../policy";
import { USDC_SEPOLIA, WETH_SEPOLIA } from "./types";
import {
  fullRangeTicks, orderSides, poolPrice, lpPriceProblem, resolveMaxLpDeviation,
  expectedDeposit, planMint, buildMintBatch, POSITION_MANAGER_SEPOLIA, NPM_ABI, type LpSide,
} from "./liquidity";

const SAFE = "0x933f48ed12e2de3da82cc69c7a4f95c2adece3d1";
const npm = new ethers.Interface(NPM_ABI);
const erc20 = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)"]);

/** sqrtPriceX96 for a tick (float precision is plenty for these checks). */
const sqrtAt = (tick: number) => BigInt(Math.round(Math.sqrt(1.0001 ** tick) * 2 ** 96));
const usdc = (amount: bigint): LpSide => ({ address: USDC_SEPOLIA, symbol: "USDC", decimals: 6, native: false, amount });
const weth = (amount: bigint, native = false): LpSide => ({ address: WETH_SEPOLIA, symbol: native ? "ETH" : "WETH", decimals: 18, native, amount });

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log("liquidity");

test("fullRangeTicks: widest range per tick spacing", () => {
  assert.deepEqual(fullRangeTicks(3000), { tickLower: -887220, tickUpper: 887220 });
  assert.deepEqual(fullRangeTicks(500), { tickLower: -887270, tickUpper: 887270 });
  assert.deepEqual(fullRangeTicks(10000), { tickLower: -887200, tickUpper: 887200 });
  assert.throws(() => fullRangeTicks(42), /Unsupported fee tier/);
});

test("orderSides: token0 is the lower address (USDC before WETH on Sepolia)", () => {
  const [t0, t1] = orderSides(weth(1n), usdc(1n));
  assert.equal(t0.symbol, "USDC");
  assert.equal(t1.symbol, "WETH");
});

test("poolPrice: the Sepolia 0.3% pool (tick 172795) prices WETH ≈ 31,330 USDC", () => {
  const p = poolPrice(sqrtAt(172795), usdc(0n), weth(0n));
  assert.ok(Math.abs(p - 31332) < 5, String(p));
});

test("lpPriceProblem: refuses the mispriced Sepolia pool, accepts a fair one, can be turned off", () => {
  setPrices({ ETH: 2689, WETH: 2689, USDC: 1 });
  const msg = lpPriceProblem(sqrtAt(172795), usdc(0n), weth(0n), 0.05);
  assert.match(msg!, /pool prices 1 WETH at 31,33\d USDC, but the market price is 2,689 USDC/);
  const fairTick = Math.round(Math.log(1e12 / 2689) / Math.log(1.0001)); // WETH ≈ 2,689 USDC
  assert.equal(lpPriceProblem(sqrtAt(fairTick), usdc(0n), weth(0n), 0.05), null);
  assert.equal(resolveMaxLpDeviation("off"), Infinity);
  assert.equal(lpPriceProblem(sqrtAt(172795), usdc(0n), weth(0n), resolveMaxLpDeviation("off")), null);
  assert.equal(resolveMaxLpDeviation(undefined), 0.05);
});

test("expectedDeposit: the scarcer side is used in full, the other at the pool's ratio", () => {
  const fairTick = Math.round(Math.log(1e12 / 2500) / Math.log(1.0001)); // WETH ≈ 2,500 USDC
  // 25 USDC vs 1 WETH: USDC is scarce → all 25 USDC, ≈0.01 WETH.
  const { used0, used1 } = expectedDeposit(sqrtAt(fairTick), 25_000_000n, 10n ** 18n);
  assert.equal(used0, 25_000_000n);
  assert.ok(Math.abs(Number(used1) / 1e18 - 0.01) < 0.0002, String(used1));
  // 1000 USDC vs 0.01 WETH: WETH is scarce → all of it, ≈25 USDC.
  const r = expectedDeposit(sqrtAt(fairTick), 1_000_000_000n, 10n ** 16n);
  assert.equal(r.used1, 10n ** 16n);
  assert.ok(Math.abs(Number(r.used0) / 1e6 - 25) < 0.5, String(r.used0));
});

test("planMint: minimums are 99% of the expected deposit", () => {
  const plan = planMint(usdc(25_000_000n), weth(10n ** 16n), 3000, sqrtAt(Math.round(Math.log(1e12 / 2500) / Math.log(1.0001))));
  assert.equal(plan.token0.symbol, "USDC");
  assert.equal(plan.amount0Min, (plan.used0 * 9900n) / 10000n);
  assert.equal(plan.amount1Min, (plan.used1 * 9900n) / 10000n);
});

test("buildMintBatch (USDC + WETH): approve both, mint to the Safe, reset both approvals", () => {
  const plan = planMint(weth(10n ** 16n), usdc(25_000_000n), 3000, sqrtAt(Math.round(Math.log(1e12 / 2500) / Math.log(1.0001))));
  const batch = buildMintBatch(plan, SAFE, 1_900_000_000);
  assert.deepEqual(batch.map((op) => op.to), [USDC_SEPOLIA, WETH_SEPOLIA, POSITION_MANAGER_SEPOLIA, USDC_SEPOLIA, WETH_SEPOLIA]);
  assert.deepEqual(erc20.decodeFunctionData("approve", batch[0].data).map(String), [POSITION_MANAGER_SEPOLIA, "25000000"]);
  assert.deepEqual(erc20.decodeFunctionData("approve", batch[3].data).map(String), [POSITION_MANAGER_SEPOLIA, "0"]);
  const [p] = npm.decodeFunctionData("mint", batch[2].data);
  assert.equal(p.token0, USDC_SEPOLIA);
  assert.equal(p.token1, WETH_SEPOLIA);
  assert.equal(Number(p.fee), 3000);
  assert.equal(Number(p.tickLower), -887220);
  assert.equal(Number(p.tickUpper), 887220);
  assert.equal(p.amount0Desired, 25_000_000n);
  assert.equal(p.amount1Desired, 10n ** 16n);
  assert.equal(p.recipient.toLowerCase(), SAFE);
  assert.equal(batch[2].value, "0");
});

test("buildMintBatch (USDC + native ETH): ETH sent as value, multicall(mint, refundETH), only USDC approved", () => {
  const plan = planMint(weth(10n ** 16n, true), usdc(25_000_000n), 3000, sqrtAt(Math.round(Math.log(1e12 / 2500) / Math.log(1.0001))));
  const batch = buildMintBatch(plan, SAFE, 1_900_000_000);
  assert.deepEqual(batch.map((op) => op.to), [USDC_SEPOLIA, POSITION_MANAGER_SEPOLIA, USDC_SEPOLIA]);
  assert.equal(batch[1].value, (10n ** 16n).toString());
  const [calls] = npm.decodeFunctionData("multicall", batch[1].data);
  assert.equal(calls.length, 2);
  assert.equal(npm.parseTransaction({ data: calls[0] })!.name, "mint");
  assert.equal(npm.parseTransaction({ data: calls[1] })!.name, "refundETH");
});

console.log(`\n${passed} passed`);
