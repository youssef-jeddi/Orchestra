// ─── Safe transactions — gas limit tests (no network: estimates are faked) ───
// Run with `npm run test:safe`.

import assert from "node:assert/strict";
import { gasLimitFromEstimate, safeGasLimit, WOULD_FAIL_TEXT } from "./transaction";

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

  test("an estimate that reverts means the transaction would fail: nothing is sent, in plain words, detail only in the log", async () => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
    try {
      for (const reason of ["GS013", "GS026", undefined]) {
        await assert.rejects(safeGasLimit(async () => { throw revert(reason); }, "600000"), (e: Error) => {
          assert.equal(e.message, WOULD_FAIL_TEXT);
          assert.match(e.message, /nothing was sent and your funds were not moved/);
          assert.ok(!/GS0|revert|inner call|nonce|gas|estimate/i.test(e.message), e.message);
          return true;
        });
      }
    } finally { console.error = orig; }
    assert.equal(logged.length, 3);
    assert.match(logged[0], /GS013/);
    assert.match(logged[1], /GS026/);
    assert.ok(logged.every((l) => /not sent/.test(l)));
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
