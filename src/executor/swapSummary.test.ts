// ─── Swap card summary wording (ORC-119) ───
// The USD figure is the input's market value: it must sit next to the input, not the pool output.

import assert from "node:assert/strict";
import { setPrices } from "../policy";
import { _resetPriceFeedForTests } from "../policy/priceFeed";
import { swapSummary } from "./adapters";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("USD sits next to the input, not the pool output", () => {
  _resetPriceFeedForTests();
  setPrices({ ETH: 2370, WETH: 2370, USDC: 1 });
  const s = swapSummary("0.001", "ETH", 44.64, "USDC", null);
  assert.equal(s, "Swap 0.001 ETH (~$2.37) for ~44.64 USDC");
  assert.ok(s.indexOf("(~$2.37)") < s.indexOf("for ~44.64"), "dollar before the pool output");
});

test("USDC input: no redundant dollar (it is already dollars)", () => {
  _resetPriceFeedForTests();
  setPrices({ ETH: 2500, WETH: 2500, USDC: 1 });
  const s = swapSummary("10", "USDC", 0.00398, "ETH", null);
  assert.equal(s, "Swap 10 USDC for ~0.00398 ETH");
  assert.doesNotMatch(s, /\$/);
});

test("shortfall line still follows the amounts", () => {
  _resetPriceFeedForTests();
  setPrices({ ETH: 2500, WETH: 2500, USDC: 1 });
  const check = { amountOut: 1, marketOut: 2.5, shortfall: 0.6, ok: false, reason: "x" };
  const s = swapSummary("0.001", "ETH", 1, "USDC", check as any);
  assert.equal(s, "Swap 0.001 ETH (~$2.50) for ~1 USDC, 60.0% below the market price");
});

for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}`); console.error(e); process.exitCode = 1; }
}
console.log(`${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
