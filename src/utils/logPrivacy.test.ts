// ─── Logging — the server log holds no user data ───
// Starts the real bridge (serve.ts on a free port) with the language model replayed from a cache
// (no network, no API key) and sends /intent requests whose message holds a distinctive word, an
// ENS name and two addresses. The captured log must carry a request id, the outcome and timings,
// and none of the message, the recipient or the full wallet. Plus the pure helpers, and
// LOG_USER_MESSAGES (local debugging only, never in production). Run with `npm run test:log-privacy`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { shortAddr, redactAddrs, safeErr, shortKey, userMessageLoggingOn, intentSummaryLine, intentOutcome } from "./redact";
import { issueToken } from "../auth";
import { startBridge, post, replay, wait, MODEL } from "./testBridge";
const WALLET = ethers.Wallet.createRandom().address;
const RECIPIENT = ethers.Wallet.createRandom().address;
const TX = "0x" + "ab".repeat(32);

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ── Helpers (pure) ──

test("shortAddr / redactAddrs / shortKey keep 4 characters at each end and nothing more", () => {
  assert.equal(shortAddr(WALLET), `${WALLET.slice(0, 6)}…${WALLET.slice(-4)}`);
  assert.equal(shortAddr(undefined), "none");
  assert.equal(shortAddr("not an address"), "?");
  const text = redactAddrs(`from ${WALLET} to ${RECIPIENT.toLowerCase()} tx ${TX}`);
  assert.ok(!text.includes(WALLET) && !text.toLowerCase().includes(RECIPIENT.toLowerCase()), text);
  assert.ok(text.includes(TX), "a transaction hash is public and stays whole");
  assert.equal(shortKey(`passkey:${WALLET.toLowerCase()}`), `passkey:${shortAddr(WALLET.toLowerCase())}`);
});

test("safeErr shortens addresses and hides a Telegram bot token", () => {
  const out = safeErr(new Error(`call to ${WALLET} failed: https://api.telegram.org/bot123456:AAE-secret_tok/sendMessage`));
  assert.ok(!out.includes(WALLET) && !out.includes("AAE-secret_tok"), out);
});

test("the summary line has the id, kind, outcome, risk and timings", () => {
  const line = intentSummaryLine({ rid: "a1b2c3", kind: "action", intentType: "send", outcome: "NEEDS_APPROVAL", riskScore: 40, plannerMs: 812, totalMs: 1500, model: MODEL });
  assert.equal(line, "[intent a1b2c3] kind=action type=send outcome=NEEDS_APPROVAL risk=40 planner=812ms total=1500ms model=test-model");
  assert.equal(intentOutcome(200, { status: "ok", autoExecuted: true }), "AUTO_EXECUTE");
  assert.equal(intentOutcome(200, { status: "ok", assessment: { verdict: "BLOCKED" } }), "BLOCKED");
  assert.equal(intentOutcome(200, { status: "reply" }), "answered");
  assert.equal(intentOutcome(500, { error: "x" }), "failed(500)");
});

test("LOG_USER_MESSAGES=1 turns message logging on only outside production", () => {
  assert.equal(userMessageLoggingOn({}), false, "off by default");
  assert.equal(userMessageLoggingOn({ LOG_USER_MESSAGES: "1" } as any), true);
  assert.equal(userMessageLoggingOn({ LOG_USER_MESSAGES: "true" } as any), false, "only the exact value 1");
  assert.equal(userMessageLoggingOn({ LOG_USER_MESSAGES: "1", NODE_ENV: "production" } as any), false, "never in production");
  assert.equal(userMessageLoggingOn({ LOG_USER_MESSAGES: "1", NODE_ENV: "development" } as any), true);
});

const SEND_MESSAGE = `send 5 USDC to xyzzyrent-landlord.eth, the old address was ${RECIPIENT}`;
const CHAT_MESSAGE = "hello plumbfrobnicate, who are you?";

test("real /intent requests log an id, outcome and timing, and none of the message, recipient or wallet", async () => {
  replay(SEND_MESSAGE, { type: "actions", steps: [{ action: "send", token: "USDC", amount: "5", unit: "token", to: RECIPIENT }] });
  replay(CHAT_MESSAGE, { type: "reply", text: "I'm Orchestra." });
  const bridge = await startBridge({});
  try {
    const token = issueToken(WALLET).token;
    const chat = await post(bridge.port, { message: CHAT_MESSAGE }, token);
    assert.equal(chat.body.status, "reply");
    const send = await post(bridge.port, { message: SEND_MESSAGE, walletAddress: WALLET }, token);
    assert.ok(send.status > 0);
    await wait(500);
    const log = bridge.log();
    for (const secret of ["xyzzyrent", "landlord", "plumbfrobnicate", "who are you", SEND_MESSAGE, WALLET, WALLET.toLowerCase(), RECIPIENT, RECIPIENT.toLowerCase()]) {
      assert.ok(!log.includes(secret), `the log leaked ${JSON.stringify(secret)}:\n${log}`);
    }
    if (process.env.SHOW_LOG) console.log(log);
    const lines = log.split("\n").filter((l) => /^\[intent [0-9a-f]{6}\]/.test(l));
    assert.ok(lines.some((l) => /kind=reply outcome=answered .*planner=\d+ms total=\d+ms model=test-model/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /kind=\w+ .*outcome=\S+ .*total=\d+ms/.test(l) && /type=send|kind=(clarify|unsupported)/.test(l)), lines.join("\n"));
    assert.ok(new Set(lines.map((l) => l.slice(0, 15))).size >= 2, "each request has its own id");
  } finally { bridge.child.kill(); }
});

test("LOG_USER_MESSAGES=1 logs the message in development", async () => {
  replay(CHAT_MESSAGE, { type: "reply", text: "I'm Orchestra." });
  const bridge = await startBridge({ LOG_USER_MESSAGES: "1", NODE_ENV: "development" });
  try {
    await post(bridge.port, { message: CHAT_MESSAGE });
    await wait(300);
    assert.match(bridge.log(), /\[intent [0-9a-f]{6}\] message: "hello plumbfrobnicate, who are you\?"/);
  } finally { bridge.child.kill(); }
});

test("LOG_USER_MESSAGES=1 is ignored when NODE_ENV=production", async () => {
  replay(CHAT_MESSAGE, { type: "reply", text: "I'm Orchestra." });
  const bridge = await startBridge({ LOG_USER_MESSAGES: "1", NODE_ENV: "production" });
  try {
    await post(bridge.port, { message: CHAT_MESSAGE });
    await wait(300);
    assert.ok(!bridge.log().includes("plumbfrobnicate"), bridge.log());
  } finally { bridge.child.kill(); }
});

(async () => {
  console.log("log privacy");
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
