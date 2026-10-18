// ─── Safe — onboarding tests (no network: deploy and chain reads are injected) ───
// Run with `npm run test:safe`.

import assert from "node:assert/strict";
import { predictedSafeConfig } from "./deploy";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { safeStatusFor, shouldPoll, pollAction, onboardingErrorMessage, shortAddress } from "../../../frontend/src/lib/onboarding.js";
import { OnboardingLimiter, OnboardingQueue, OnboardingError } from "./onboarding";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const AGENT = "0x00000000000000000000000000000000000000A1";
const USER = "0x00000000000000000000000000000000000000B2";
const LIMITS = { globalPerWindow: 4, perIpPerWindow: 2, windowMs: 3_600_000 };

function setup(over: Partial<ConstructorParameters<typeof OnboardingQueue>[0]> = {}, limits = LIMITS) {
  let clock = 1_000_000;
  const deployed = new Set<string>();
  const log: string[] = [];
  const gates: (() => void)[] = [];
  const queue = new OnboardingQueue({
    existing: async (w) => (deployed.has(w.toLowerCase()) ? `acct-${w}` : null),
    predict: async (w) => `acct-${w}`,
    deploy: async (w) => {
      log.push(`start ${w}`);
      await new Promise<void>((r) => gates.push(r));
      deployed.add(w.toLowerCase());
      log.push(`end ${w}`);
    },
    limiter: new OnboardingLimiter(limits, () => clock),
    ...over,
  });
  const release = async () => { await new Promise((r) => setImmediate(r)); gates.shift()?.(); await new Promise((r) => setImmediate(r)); };
  return { queue, deployed, log, release, tick: (ms: number) => { clock += ms; } };
}

test("the predicted-address config is pinned: owners [agent, user], threshold 1, no salt", () => {
  // Changing any of this moves every user's account address. Do not "fix" this test.
  assert.deepEqual(predictedSafeConfig(USER, AGENT), { safeAccountConfig: { owners: [AGENT, USER], threshold: 1 } });
  assert.deepEqual(Object.keys(predictedSafeConfig(USER, AGENT)), ["safeAccountConfig"]); // no saltNonce / safeDeploymentConfig
});

test("concurrent starts for one wallet share a single deployment", async () => {
  const { queue, log, release } = setup();
  const [a, b, c] = await Promise.all([queue.start(USER, "1.1.1.1"), queue.start(USER, "1.1.1.1"), queue.start(USER, "2.2.2.2")]);
  assert.equal(a.status, "deploying");
  assert.equal(b.safeAddress, a.safeAddress);
  assert.equal(c.safeAddress, a.safeAddress);
  assert.equal([a, b, c].filter((r) => r.started).length, 1);
  await release();
  assert.deepEqual(log, [`start ${USER}`, `end ${USER}`]);
});

test("a wallet that already has an account is never deployed again", async () => {
  const { queue, log, release, deployed } = setup();
  await queue.start(USER, "1.1.1.1");
  await release();
  const again = await queue.start(USER, "1.1.1.1");
  assert.equal(again.status, "ready");
  deployed.add("0xother");
  assert.equal((await queue.start("0xOTHER", "1.1.1.1")).status, "ready");
  assert.equal(log.filter((l) => l.startsWith("start")).length, 1);
});

test("an existing account does not use up the rate limit", async () => {
  const { queue, deployed } = setup({}, { ...LIMITS, perIpPerWindow: 1 });
  deployed.add(USER.toLowerCase());
  for (let i = 0; i < 5; i++) assert.equal((await queue.start(USER, "1.1.1.1")).status, "ready");
});

test("agent transactions for different wallets run one after another", async () => {
  const { queue, log, release } = setup();
  const w2 = "0x00000000000000000000000000000000000000C3";
  await queue.start(USER, "1.1.1.1");
  await queue.start(w2, "2.2.2.2");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, [`start ${USER}`]); // the second waits for the first
  await release();
  await release();
  assert.deepEqual(log, [`start ${USER}`, `end ${USER}`, `start ${w2}`, `end ${w2}`]);
});

test("status reports not_started, deploying, then ready", async () => {
  const { queue, release } = setup();
  assert.equal((await queue.status(USER)).status, "not_started");
  const started = await queue.start(USER, "1.1.1.1");
  assert.deepEqual(await queue.status(USER), { status: "deploying", safeAddress: started.safeAddress });
  await release();
  assert.equal((await queue.status(USER)).status, "ready");
});

test("a failed deployment is reported plainly and can be retried", async () => {
  let fail = true;
  const { queue, deployed } = setup({
    deploy: async (w) => { if (fail) throw new Error("estimate reverted: 0xdeadbeef secret detail"); deployed.add(w.toLowerCase()); },
  });
  await queue.start(USER, "1.1.1.1");
  await new Promise((r) => setImmediate(r));
  const failed = await queue.status(USER);
  assert.equal(failed.status, "failed");
  assert.ok(!failed.error!.includes("0xdeadbeef")); // internals are not shown to the user
  fail = false;
  assert.equal((await queue.start(USER, "1.1.1.1")).started, true);
  await new Promise((r) => setImmediate(r));
  assert.equal((await queue.status(USER)).status, "ready");
});

test("a retry finds the account if the failed attempt did deploy it", async () => {
  const { queue, deployed } = setup({ deploy: async (w) => { deployed.add(w.toLowerCase()); throw new Error("later step failed"); } });
  await queue.start(USER, "1.1.1.1");
  await new Promise((r) => setImmediate(r));
  assert.equal((await queue.start(USER, "1.1.1.1")).status, "ready"); // not deployed a second time
});

test("a deployment that never finishes times out, fails its job and lets the next one run", async () => {
  const log: string[] = [];
  const { queue } = setup({
    timeoutMs: 20,
    deploy: async (w) => { log.push(`start ${w}`); if (w === USER) await new Promise(() => {}); log.push(`end ${w}`); },
  });
  const w2 = "0x00000000000000000000000000000000000000C3";
  await queue.start(USER, "1.1.1.1");
  await queue.start(w2, "2.2.2.2");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await queue.status(USER)).status, "failed");
  assert.deepEqual(log, [`start ${USER}`, `start ${w2}`, `end ${w2}`]);
  assert.equal((await queue.start(USER, "1.1.1.1")).started, true); // the user can retry
});

test("a timed-out deployment is told to stop before its next transaction", async () => {
  let cancelled: (() => boolean) | undefined;
  const { queue } = setup({ timeoutMs: 10, deploy: async (_w, isCancelled) => { cancelled = isCancelled; await new Promise(() => {}); } });
  await queue.start(USER, "1.1.1.1");
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled!(), false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cancelled!(), true);
});

test("attack: one IP creating many wallets is refused with 429 and a code", async () => {
  const { queue, log } = setup();
  await queue.start("0x01", "9.9.9.9");
  await queue.start("0x02", "9.9.9.9");
  await assert.rejects(queue.start("0x03", "9.9.9.9"), (e: any) =>
    e instanceof OnboardingError && e.status === 429 && e.code === "onboarding_rate_limited" && /minute/.test(e.message));
  assert.equal(log.length <= 1, true); // nothing was started for the third
  await queue.start("0x04", "8.8.8.8"); // another IP is still fine
});

test("attack: many IPs creating many wallets hit the global cap", async () => {
  const { queue } = setup();
  for (let i = 0; i < 4; i++) await queue.start(`0x1${i}`, `10.0.0.${i}`);
  await assert.rejects(queue.start("0x99", "10.0.0.99"), (e: any) => e.status === 429 && e.code === "onboarding_rate_limited");
});

test("the limit lifts once the window has passed", async () => {
  const { queue, tick } = setup({}, { ...LIMITS, perIpPerWindow: 1 });
  await queue.start("0x01", "9.9.9.9");
  await assert.rejects(queue.start("0x02", "9.9.9.9"), (e: any) => e.status === 429);
  tick(3_600_001);
  assert.equal((await queue.start("0x02", "9.9.9.9")).status, "deploying");
});

test("UI: server status maps to the account states and polling stops at the end", () => {
  assert.equal(safeStatusFor("ready"), "deployed");
  assert.equal(safeStatusFor("deploying"), "deploying");
  assert.equal(safeStatusFor("not_started"), "deploying");
  assert.equal(safeStatusFor("failed"), "error");
  assert.deepEqual(["ready", "failed", "deploying", "not_started"].map(shouldPoll), [false, false, true, true]);
});

test("UI: a poll that finds the setup forgotten (not_started) starts it again", () => {
  assert.deepEqual(["deploying", "ready", "failed", "not_started"].map(pollAction), ["wait", "done", "done", "restart"]);
});

test("UI: errors are plain sentences, never raw text", () => {
  assert.match(onboardingErrorMessage(Object.assign(new Error("Try again in 5 minutes."), { code: "onboarding_rate_limited" })), /5 minutes/);
  assert.equal(onboardingErrorMessage(new Error("execution reverted: 0xabc")), "We couldn't set up your account. Please try again.");
  assert.equal(shortAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234…5678");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e: any) { console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed${passed === tests.length ? "" : `, ${tests.length - passed} failed`}`);
})();
