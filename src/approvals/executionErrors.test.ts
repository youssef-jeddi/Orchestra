// ─── Approvals — what a failed execution shows the user (no network) ───
// An approved action that fails in an unexpected way (an RPC error with a URL and key in it) used to
// be saved raw on the approval record, which the app, the phone page and Telegram all display. Now
// only errors raised on purpose keep their message; the rest become one fixed sentence and the
// detail goes to the server log. Run with `npm run test:execution-errors`.

import assert from "node:assert/strict";
import { createApproval, claim, approvalView, type PendingApproval } from "./index";
import { executeApprovalFlow, ownerSignLink } from "./flows";
import { OverCapError } from "../utils/userFacing";
import { describeOutcome } from "./describe";
import { EXECUTION_FAILED_REASON } from "../intent/messages";
import { WOULD_FAIL_TEXT } from "../integrations/safe/transaction";
import { UserFacingError } from "../utils/userFacing";
import { executionErrorMessage } from "../integrations/ledger/errors";
import { LimitsError } from "../policy/limits";
import { getRecentActivity, _resetPolicyStoreCache } from "../policy/store";

// All lowercase on purpose: a wrong mixed-case checksum makes ethers.getAddress throw, which would
// silently drop the recipient from the recorded activity.
const WALLET = "0xabc0000000000000000000000000000000000001";
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


test("a successful approval records activity once (same shape as auto-exec)", async () => {
  _resetPolicyStoreCache();
  const a = await newApproval();
  const result = await executeApprovalFlow(a, async () => ({ txHash: "0xabc", explorerUrl: "https://sepolia.etherscan.io/tx/0xabc" }));
  assert.equal(result.txHash, "0xabc");
  assert.equal(a.status, "executed");
  const rows = (await getRecentActivity(WALLET)).filter((r) => r.txHash === "0xabc");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].valueUsd, 5);
  assert.equal(rows[0].to?.toLowerCase(), WALLET);
  assert.equal(rows[0].token, "ETH");
  assert.equal(rows[0].source, "approved");
  assert.equal(rows[0].explorerUrl, "https://sepolia.etherscan.io/tx/0xabc");
  assert.ok(typeof rows[0].at === "string" && !Number.isNaN(Date.parse(rows[0].at)));
});

test("a failed approval does not record activity", async () => {
  _resetPolicyStoreCache();
  const before = (await getRecentActivity(WALLET)).length; // storage may hold earlier tests' rows
  const a = await newApproval();
  await assert.rejects(executeApprovalFlow(a, async () => { throw new UserFacingError(WOULD_FAIL_TEXT); }));
  assert.equal(a.status, "failed");
  assert.equal((await getRecentActivity(WALLET)).length, before, "a failure must not add a row");
});

test("activity is recorded only after success, not before run returns", async () => {
  _resetPolicyStoreCache();
  const before = (await getRecentActivity(WALLET)).length;
  const a = await newApproval();
  let mid: number | undefined;
  await executeApprovalFlow(a, async () => {
    mid = (await getRecentActivity(WALLET)).length;
    return { txHash: "0xdef", explorerUrl: "https://sepolia.etherscan.io/tx/0xdef" };
  });
  assert.equal(mid, before, "nothing recorded while still running");
  assert.equal((await getRecentActivity(WALLET)).filter((r) => r.txHash === "0xdef").length, 1);
});

// ─── Over the daily ceiling, approved in Telegram: a link to sign it as the owner ───

const overCap = () => new OverCapError("over", { kind: "safe-owner", id: "11111111-2222-3333-4444-555555555555" });
const recorder = () => {
  const sent: string[][] = [];
  const notifier = {
    link: async (chat: number, text: string, button: string, url: string) => { sent.push(["link", String(chat), text, button, url]); },
    text: async (chat: number, text: string) => { sent.push(["text", String(chat), text]); },
  };
  return { sent, notifier };
};
const withAppUrl = async (url: string | undefined, fn: () => Promise<void>) => {
  const before = process.env.PUBLIC_APP_URL;
  if (url === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = url;
  try { await fn(); } finally { if (before === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = before; }
};

test("the owner-sign link is the app's /simple page with the request id", async () => {
  assert.equal(ownerSignLink("abc-123", "https://orchestra.example.com/"), "https://orchestra.example.com/simple?ownerSign=abc-123");
  assert.equal(ownerSignLink("abc-123", "https://orchestra.example.com/some/path"), "https://orchestra.example.com/simple?ownerSign=abc-123");
  assert.equal(ownerSignLink("abc-123", undefined), null);
  assert.equal(ownerSignLink("abc-123", "not a url"), null);
});

test("a Telegram approval stopped by the ceiling still fails, and the chat gets the sign-as-owner link", async () => {
  await withAppUrl("https://orchestra.example.com", async () => {
    const a = await newApproval();
    a.channel = "telegram";
    a.telegram = { chatId: 42, messageId: 1 };
    const { sent, notifier } = recorder();
    const before = (await getRecentActivity(WALLET)).length;
    await assert.rejects(executeApprovalFlow(a, async () => { throw overCap(); }, notifier));
    assert.equal(a.status, "failed");
    assert.equal((await getRecentActivity(WALLET)).length, before, "nothing recorded");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].slice(0, 2), ["link", "42"]);
    assert.match(sent[0][2], /sign it yourself|daily reset/);
    assert.equal(sent[0][3], "Open Orchestra to sign as owner");
    assert.equal(sent[0][4], "https://orchestra.example.com/simple?ownerSign=11111111-2222-3333-4444-555555555555");
  });
});

test("without PUBLIC_APP_URL the chat gets a plain sentence, no link", async () => {
  await withAppUrl(undefined, async () => {
    const a = await newApproval();
    a.channel = "telegram";
    a.telegram = { chatId: 42, messageId: 1 };
    const { sent, notifier } = recorder();
    await assert.rejects(executeApprovalFlow(a, async () => { throw overCap(); }, notifier));
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], "text");
    assert.match(sent[0][2], /daily reset/);
  });
});

test("no follow-up for an in-app approval, another failure, or an over-ceiling error without an offer", async () => {
  await withAppUrl("https://orchestra.example.com", async () => {
    const { sent, notifier } = recorder();
    const inApp = await newApproval();
    await assert.rejects(executeApprovalFlow(inApp, async () => { throw overCap(); }, notifier));
    const tg = await newApproval();
    tg.channel = "telegram";
    tg.telegram = { chatId: 42, messageId: 1 };
    await assert.rejects(executeApprovalFlow(tg, async () => { throw new UserFacingError(WOULD_FAIL_TEXT); }, notifier));
    const tg2 = await newApproval();
    tg2.channel = "telegram";
    tg2.telegram = { chatId: 42, messageId: 1 };
    await assert.rejects(executeApprovalFlow(tg2, async () => { throw new OverCapError("over"); }, notifier));
    assert.deepEqual(sent, []);
  });
});

test("a Telegram send that fails to deliver the follow-up doesn't change the approval's outcome", async () => {
  await withAppUrl("https://orchestra.example.com", async () => {
    const a = await newApproval();
    a.channel = "telegram";
    a.telegram = { chatId: 42, messageId: 1 };
    const notifier = { link: async () => { throw new Error("telegram down"); }, text: async () => {} };
    await assert.rejects(executeApprovalFlow(a, async () => { throw overCap(); }, notifier), /over/);
    assert.equal(a.status, "failed");
  });
});

(async () => {
  console.log("execution errors");
  for (const [name, fn] of tests) {
    _resetPolicyStoreCache();
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.log(String(err && (err as any).stack || err));
  process.exit(1);
});
