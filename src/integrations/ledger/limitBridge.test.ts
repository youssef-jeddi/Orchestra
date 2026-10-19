// ─── Bridge — limits when storage fails, and errors without internals (ORC-93, 95, 99) ───
// The pure error mapper, then the real bridge (serve.ts on a free port, language model replayed,
// storage faults injected with ORCHESTRA_FAULT_INJECT): a send or swap does nothing when the
// profile or the day's activity can't be read, a chat answer still works, GET /policy is an error
// and not an empty sheet, and no response carries the internal text of an error.
// Run with `npm run test:limit-bridge`.

import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import { issueToken } from "../../auth";
import { PasskeyError } from "../passkey";
import { OnboardingError } from "../safe/onboarding";
import { ApprovalError } from "../../approvals";
import { AuthError } from "../../auth";
import { LimitsError } from "../../policy/limits";
import { INTENT_FALLBACK_ERROR, LIMITS_UNREADABLE_REASON } from "../../intent/messages";
import { errorResponse, isUserFacing, UNEXPECTED_ERROR } from "./errors";
import { UserFacingError } from "../../utils/userFacing";
import { safeGasLimit, WOULD_FAIL_TEXT } from "../safe/transaction";
import { startBridge, post, replay, wait } from "../../utils/testBridge";

const WALLET = ethers.Wallet.createRandom().address;
const RECIPIENT = ethers.Wallet.createRandom().address;
const SEND = `send 5 USDC to ${RECIPIENT}`;
const CHAT = "hello, who are you today?";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

function call(port: number, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data || "{}"), text: data }));
    });
    req.on("error", reject); if (method !== "GET") req.write(JSON.stringify(body ?? {})); req.end();
  });
}

// ── The error mapper (pure) ──

test("errors raised on purpose keep their status and sentence", () => {
  assert.deepEqual(errorResponse(new LimitsError(403, "Raising a limit needs your passkey.", "confirmation_required", { method: "passkey" })),
    { status: 403, body: { error: "Raising a limit needs your passkey.", code: "confirmation_required", method: "passkey" } });
  assert.deepEqual(errorResponse(new PasskeyError(409, "No passkey yet", "passkey_required")), { status: 409, body: { error: "No passkey yet", code: "passkey_required" } });
  assert.equal(errorResponse(new OnboardingError(429, "Try later", "busy")).status, 429);
  assert.deepEqual(errorResponse(new ApprovalError(404, "Gone")), { status: 404, body: { error: "Gone" } });
  assert.deepEqual(errorResponse(new AuthError(401, "Sign in")), { status: 401, body: { error: "Sign in" } });
  for (const e of [new LimitsError(400, "x"), new PasskeyError(400, "x"), new OnboardingError(400, "x"), new ApprovalError(400, "x"), new AuthError(400, "x")]) assert.equal(isUserFacing(e), true);
});

test("attack: an unexpected error with a secret in it answers one fixed sentence", () => {
  const secret = "https://rpc.example/v2/SECRET-KEY-123 0x" + "ab".repeat(32);
  for (const err of [new Error(secret), Object.assign(new Error("x"), { shortMessage: secret }), secret, null, undefined, { message: secret }]) {
    const r = errorResponse(err);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: UNEXPECTED_ERROR });
    assert.ok(!JSON.stringify(r).includes("SECRET-KEY"));
    assert.equal(isUserFacing(err), false);
  }
  assert.equal(UNEXPECTED_ERROR, INTENT_FALLBACK_ERROR);
});

test("guard errors on the execution paths keep their message through the mapper; an unknown error beside them doesn't", async () => {
  // A real guard: the gas estimate reverts, so nothing is sent.
  const reverted = await safeGasLimit(async () => { throw Object.assign(new Error("execution reverted: GS013 secret-detail"), { code: "CALL_EXCEPTION" }); }).catch((e) => e);
  assert.ok(reverted instanceof UserFacingError);
  assert.deepEqual(errorResponse(reverted), { status: 500, body: { error: WOULD_FAIL_TEXT } });
  // Quote drift / pool price / changed position are thrown the same way.
  for (const msg of ["Not swapping: the price is more than 5% below the market.", "Position #12 no longer matches what you approved.", "The trading pool no longer exists."]) {
    assert.deepEqual(errorResponse(new UserFacingError(msg)), { status: 500, body: { error: msg } });
  }
  assert.deepEqual(errorResponse(new UserFacingError("Try again", 409)), { status: 409, body: { error: "Try again" } });
  // The same route failing for an unknown reason shows the fixed sentence only.
  const unknown = errorResponse(new Error("Uniswap API /quote failed (401): key=SECRET-API-KEY-999"));
  assert.deepEqual(unknown, { status: 500, body: { error: UNEXPECTED_ERROR } });
});

// ── The real bridge ──

test("profile can't be read: a send does nothing and says so; chat still works; GET /policy is a plain error", async () => {
  replay(SEND, { type: "actions", steps: [{ action: "send", token: "USDC", amount: "5", unit: "token", to: RECIPIENT }] });
  replay(CHAT, { type: "reply", text: "I'm Orchestra." });
  const bridge = await startBridge({ ORCHESTRA_FAULT_INJECT: "profile-read,activity-read" });
  try {
    const token = issueToken(WALLET).token;
    const send = await post(bridge.port, { message: SEND, walletAddress: WALLET }, token);
    assert.equal(send.body.status, "unsupported", JSON.stringify(send.body));
    assert.equal(send.body.reason, LIMITS_UNREADABLE_REASON);
    assert.equal(LIMITS_UNREADABLE_REASON, "I can't check your limits right now, so nothing was done. Please try again in a moment.");
    assert.ok(!send.body.txHash && !send.body.autoExecuted && !send.body.approval && !send.body.unsignedTx, "nothing built, run or held");

    const chat = await post(bridge.port, { message: CHAT, walletAddress: WALLET }, token);
    assert.equal(chat.body.status, "reply", "chat doesn't depend on the limits");

    const policy = await call(bridge.port, "GET", "/policy", token);
    assert.equal(policy.status, 500, policy.text);
    assert.deepEqual(policy.body, { error: UNEXPECTED_ERROR }, "an error, not an empty sheet");
    assert.ok(!policy.text.includes("injected"), policy.text);

    await wait(300);
    const habit = await call(bridge.port, "GET", `/habit?wallet=${WALLET}`, token);
    assert.equal(habit.status, 500, habit.text);
    assert.deepEqual(habit.body, { error: UNEXPECTED_ERROR });

    await wait(300);
    assert.match(bridge.log(), /injected fault: profile-read/, "the cause is in the server log");
    assert.match(bridge.log(), /fault injection ON/);
  } finally { bridge.child.kill(); }
});

test("the day's activity hangs: a send does nothing once the 2s timeout passes", async () => {
  replay(SEND, { type: "actions", steps: [{ action: "send", token: "USDC", amount: "5", unit: "token", to: RECIPIENT }] });
  const bridge = await startBridge({ ORCHESTRA_FAULT_INJECT: "activity-timeout" });
  try {
    const token = issueToken(WALLET).token;
    const t0 = Date.now();
    const send = await post(bridge.port, { message: SEND, walletAddress: WALLET }, token);
    assert.equal(send.body.status, "unsupported", JSON.stringify(send.body));
    assert.equal(send.body.reason, LIMITS_UNREADABLE_REASON);
    assert.ok(!send.body.txHash && !send.body.autoExecuted && !send.body.approval);
    assert.ok(Date.now() - t0 < 30_000, "the request ended instead of hanging");
  } finally { bridge.child.kill(); }
});

test("the limit endpoints refuse bad input in plain words, and an unfinished account, without internals", async () => {
  const bridge = await startBridge({});
  try {
    const token = issueToken(WALLET).token;
    for (const newLimitUSD of ["1e6", 5000, -3, 12.5, null]) {
      const r = await call(bridge.port, "POST", "/prepare-limit-update", token, { newLimitUSD });
      assert.equal(r.status, 400, JSON.stringify(newLimitUSD));
      assert.match(r.body.error, /whole number of dollars from \$0 to \$1,000/);
    }
    const noAccount = await call(bridge.port, "POST", "/prepare-limit-update", token, { newLimitUSD: 50 });
    assert.equal(noAccount.status, 409);
    assert.match(noAccount.body.error, /isn't fully set up yet/);
    const fin = await call(bridge.port, "POST", "/finalize-limit-update", token, { newLimitUSD: 50, txHash: "0x" + "ab".repeat(32) });
    assert.equal(fin.status, 409);
    const noSession = await call(bridge.port, "POST", "/finalize-limit-update", "not-a-token", { newLimitUSD: 50 });
    assert.equal(noSession.status, 401);
  } finally { bridge.child.kill(); }
});

(async () => {
  console.log("limit bridge");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
