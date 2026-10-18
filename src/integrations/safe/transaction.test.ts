// ─── Safe transactions — gas limit tests (no network: estimates are faked) ───
// Run with `npm run test:safe`.

import assert from "node:assert/strict";
import { gasLimitFromEstimate, safeGasLimit } from "./transaction";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

/** An ethers-style revert from eth_estimateGas. */
const revert = (reason?: string) => Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", reason });

(async () => {
  test("the limit is the whole Safe transaction's estimate plus 20%", async () => {
    assert.equal(gasLimitFromEstimate(427_675n), 513_210n);
    // The swap that failed with 247,000: the quote's 97,000 + 150,000 was far below what it needed.
    assert.equal(await safeGasLimit(async () => 427_675n, "247000"), "513210");
  });

  test("an estimate that reverts means the transaction would fail: nothing is sent", async () => {
    await assert.rejects(safeGasLimit(async () => { throw revert("GS013"); }, "600000"), /would fail \(GS013 — the inner call failed\), so it wasn't sent/);
    await assert.rejects(safeGasLimit(async () => { throw revert("GS026"); }), /would fail \(GS026\)/);
    await assert.rejects(safeGasLimit(async () => { throw revert(); }), /would fail, so it wasn't sent/);
  });

  test("an RPC that can't estimate falls back to the fixed limit, or to the SDK's own", async () => {
    const down = async (): Promise<bigint> => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "UNKNOWN_ERROR" }); };
    assert.equal(await safeGasLimit(down, "600000"), "600000");
    assert.equal(await safeGasLimit(down), undefined);
  });

  console.log("safe transaction");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
