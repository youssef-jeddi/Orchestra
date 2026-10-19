// ─── Approvals — what a failed execution shows the user (no network) ───
// An approved action that fails in an unexpected way (an RPC error with a URL and key in it) used to
// be saved raw on the approval record, which the app, the phone page and Telegram all display. Now
// only errors raised on purpose keep their message; the rest become one fixed sentence and the
// detail goes to the server log. Run with `npm run test:execution-errors`.

import assert from "node:assert/strict";
import { createApproval, claim, approvalView, type PendingApproval } from "./index";
import { executeApprovalFlow } from "./flows";
import { describeOutcome } from "./describe";
import { EXECUTION_FAILED_REASON } from "../intent/messages";
import { WOULD_FAIL_TEXT } from "../integrations/safe/transaction";
import { UserFacingError } from "../utils/userFacing";
import { executionErrorMessage } from "../integrations/ledger/errors";
import { LimitsError } from "../policy/limits";

const WALLET = "0xAbC0000000000000000000000000000000000001";
const SECRET = "https://rpc.internal.example/v3/SECRETKEY";

console.error = () => {};

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const newApproval = async (): Promise<PendingApproval> => {
  const a = await createApproval({
    wallet: WALLET, safeAddress: "0x933f48ed12e2de3da82cc69c7a4f95c2adece3d1", intentType: "send",
    summary: "s", valueUsd: 5, reason: "r", triggered: [], execution: { sendData: { unsignedTx: { to: WALLET, value: "1", data: "0x" } } },
  });
  await claim(a.id, WALLET);
  return a;
};

test("attack: an unexpected error with an RPC URL and key in it never reaches the record, the view or Telegram", async () => {
  const a = await newApproval();
  await assert.rejects(executeApprovalFlow(a, async () => { throw new Error(`503 from ${SECRET}`); }), /SECRETKEY/, "the caller still gets the error to log");
  assert.equal(a.status, "failed");
  assert.equal(a.error, EXECUTION_FAILED_REASON);
  for (const text of [JSON.stringify(approvalView(a)), describeOutcome(a)]) {
    assert.ok(!/SECRETKEY|rpc\.internal/.test(text), text);
  }
  assert.match(describeOutcome(a), /Something went wrong on our side/);
});

test("the fixed sentence doesn't claim nothing was sent, and doesn't invite a blind retry", async () => {
  assert.doesNotMatch(EXECUTION_FAILED_REASON, /nothing (was|will)|try again now|retry/i);
  assert.match(EXECUTION_FAILED_REASON, /can't confirm this went through/);
  assert.match(EXECUTION_FAILED_REASON, /Check your balance/);
});

test("a guard's own message is kept", async () => {
  const a = await newApproval();
  await assert.rejects(executeApprovalFlow(a, async () => { throw new UserFacingError(WOULD_FAIL_TEXT); }));
  assert.equal(a.error, WOULD_FAIL_TEXT);
  assert.equal(approvalView(a).error, WOULD_FAIL_TEXT);
});

test("the /intent auto-execute answer uses the same mapping: guards keep their sentence, anything else is the fixed one", async () => {
  assert.equal(executionErrorMessage(new Error(`injected fault: execute (rpc ${SECRET})`)), EXECUTION_FAILED_REASON);
  assert.equal(executionErrorMessage({ message: SECRET }), EXECUTION_FAILED_REASON);
  assert.equal(executionErrorMessage(new UserFacingError(WOULD_FAIL_TEXT)), WOULD_FAIL_TEXT);
  assert.equal(executionErrorMessage(new LimitsError(503, "I can't check your limits right now")), "I can't check your limits right now");
});

test("an action that gives no result is still explained in its own words", async () => {
  const a = await newApproval();
  await assert.rejects(executeApprovalFlow(a, async () => null), /no result/);
  assert.match(a.error!, /gave no result/);
});

(async () => {
  console.log("execution errors");
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
