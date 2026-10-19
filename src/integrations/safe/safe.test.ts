// ─── Safe — onboarding tests (no network: deploy and chain reads are injected) ───
// Run with `npm run test:safe`.

import assert from "node:assert/strict";
import { predictedSafeConfig } from "./deploy";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { safeStatusFor, shouldPoll, pollAction, onboardingErrorMessage, shortAddress } from "../../../frontend/src/lib/onboarding.js";
import { OnboardingLimiter, OnboardingQueue, OnboardingError, type OnboardingLimits } from "./onboarding";
import { SETUP_STEPS, type SetupStep, type SetupSteps, allStepsDone, deriveSteps, finishSetup, remainingSteps } from "./setupSteps";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const AGENT = "0x00000000000000000000000000000000000000A1";
const USER = "0x00000000000000000000000000000000000000B2";
const COMPLETION = { globalPerWindow: 10, perIpPerWindow: 2, windowMs: 3_600_000 };
const LIMITS = { globalPerWindow: 4, perIpPerWindow: 2, windowMs: 3_600_000 };

type Deps = ConstructorParameters<typeof OnboardingQueue>[0];
const noSteps = (): SetupSteps => ({ deploy: false, register: false, record: false });

/** A fake chain: per wallet, which steps are done. Only the "deploy" step waits for release(). */
function setup(over: Partial<Deps> = {}, limits = LIMITS, opts: { failAt?: SetupStep; completion?: OnboardingLimits } = {}) {
  let clock = 1_000_000;
  const chain = new Map<string, SetupSteps>();
  const log: string[] = [];
  const gates: (() => void)[] = [];
  const stepsOf = (w: string) => chain.get(w.toLowerCase()) ?? noSteps();
  const complete = (w: string) => chain.set(w.toLowerCase(), allStepsDone());
  const inspect = async (w: string) => ({ safeAddress: `acct-${w}`, steps: { ...stepsOf(w) } });
  const doer = (w: string, step: SetupStep) => async () => {
    log.push(`${step} ${w}`);
    if (step === "deploy") await new Promise<void>((r) => gates.push(r));
    if (opts.failAt === step) throw new Error(`${step} reverted: 0xdeadbeef secret detail`);
    chain.set(w.toLowerCase(), { ...stepsOf(w), [step]: true });
  };
  const queue = new OnboardingQueue({
    inspect,
    finish: (w, isCancelled) => finishSetup(() => inspect(w), Object.fromEntries(SETUP_STEPS.map((st) => [st, doer(w, st)])) as Record<SetupStep, () => Promise<void>>, isCancelled).then(() => {}),
    limiter: new OnboardingLimiter(limits, () => clock),
    completionLimiter: new OnboardingLimiter(opts.completion ?? COMPLETION, () => clock, () => "wait"),
    ...over,
  });
  const release = async () => { await new Promise((r) => setImmediate(r)); gates.shift()?.(); await new Promise((r) => setImmediate(r)); };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { queue, chain, complete, stepsOf, log, release, settle, tick: (ms: number) => { clock += ms; } };
}

test("the predicted-address config is pinned: owners [agent, user], threshold 1, no salt", () => {
  // Changing any of this moves every user's account address. Do not "fix" this test.
  assert.deepEqual(predictedSafeConfig(USER, AGENT), { safeAccountConfig: { owners: [AGENT, USER], threshold: 1 } });
  assert.deepEqual(Object.keys(predictedSafeConfig(USER, AGENT)), ["safeAccountConfig"]); // no saltNonce / safeDeploymentConfig
});

test("concurrent starts for one wallet share a single deployment", async () => {
  const { queue, log, release, settle } = setup();
  const [a, b, c] = await Promise.all([queue.start(USER, "1.1.1.1"), queue.start(USER, "1.1.1.1"), queue.start(USER, "2.2.2.2")]);
  assert.equal(a.status, "deploying");
  assert.equal(b.safeAddress, a.safeAddress);
  assert.equal(c.safeAddress, a.safeAddress);
  assert.equal([a, b, c].filter((r) => r.started).length, 1);
  await release();
  await settle();
  assert.deepEqual(log.filter((l) => l.startsWith("deploy")), [`deploy ${USER}`]);
  assert.equal(log.length, SETUP_STEPS.length); // each step once
});

test("a wallet whose account is fully set up is never touched again", async () => {
  const { queue, log, release, settle, complete } = setup();
  await queue.start(USER, "1.1.1.1");
  await release();
  await settle();
  const before = log.length;
  const again = await queue.start(USER, "1.1.1.1");
  assert.equal(again.status, "ready");
  complete("0xother");
  assert.equal((await queue.start("0xOTHER", "1.1.1.1")).status, "ready");
  assert.equal(log.length, before);
});

test("an existing account does not use up the rate limit", async () => {
  const { queue, complete } = setup({}, { ...LIMITS, perIpPerWindow: 1 });
  complete(USER);
  for (let i = 0; i < 5; i++) assert.equal((await queue.start(USER, "1.1.1.1")).status, "ready");
});

test("agent transactions for different wallets run one after another", async () => {
  const { queue, log, release, settle } = setup();
  const w2 = "0x00000000000000000000000000000000000000C3";
  await queue.start(USER, "1.1.1.1");
  await queue.start(w2, "2.2.2.2");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, [`deploy ${USER}`]); // the second waits for the first
  await release();
  await settle();
  await release();
  await settle();
  assert.deepEqual(log.filter((l) => l.startsWith("deploy")), [`deploy ${USER}`, `deploy ${w2}`]);
  assert.ok(log.indexOf(`record ${USER}`) < log.indexOf(`deploy ${w2}`));
});

test("status reports not_started, deploying, then ready, with the steps", async () => {
  const { queue, release, settle } = setup();
  const first = await queue.status(USER);
  assert.equal(first.status, "not_started");
  assert.deepEqual(first.remaining, [...SETUP_STEPS]);
  const started = await queue.start(USER, "1.1.1.1");
  assert.deepEqual(await queue.status(USER), { status: "deploying", safeAddress: started.safeAddress });
  await release();
  await settle();
  const done = await queue.status(USER);
  assert.equal(done.status, "ready");
  assert.deepEqual(done.remaining, []);
});

test("a failed deployment is reported plainly and can be retried", async () => {
  const { queue, release, settle } = setup({}, LIMITS, { failAt: "deploy" });
  await queue.start(USER, "1.1.1.1");
  await release();
  await settle();
  const failed = await queue.status(USER);
  assert.equal(failed.status, "failed");
  assert.ok(!failed.error!.includes("0xdeadbeef")); // internals are not shown to the user
});

test("failure after the deploy leaves the account NOT ready, and says what is missing", async () => {
  const { queue, release, settle, stepsOf } = setup({}, LIMITS, { failAt: "register" });
  await queue.start(USER, "1.1.1.1");
  await release();
  await settle();
  const st = await queue.status(USER);
  assert.equal(st.status, "failed");
  assert.deepEqual(st.remaining, ["register", "record"]);
  assert.equal(stepsOf(USER).deploy, true);
  assert.equal(stepsOf(USER).record, false);
});

test("a retry runs only the missing steps: no second deploy, same address", async () => {
  const { queue, log, chain, release, settle, stepsOf } = setup();
  const first = await queue.start(USER, "1.1.1.1");
  chain.set(USER.toLowerCase(), { ...allStepsDone(), register: false, record: false }); // as if it stopped after "deploy"
  await release();
  await settle();
  log.length = 0;
  chain.set(USER.toLowerCase(), { ...allStepsDone(), register: false, record: false });
  const retry = await queue.start(USER, "1.1.1.1");
  assert.equal(retry.status, "deploying");
  assert.equal(retry.resumed, true);
  assert.equal(retry.safeAddress, first.safeAddress);
  await settle();
  assert.deepEqual(log, [`register ${USER}`, `record ${USER}`]);
  assert.equal((await queue.status(USER)).status, "ready");
  assert.equal(Object.values(stepsOf(USER)).every(Boolean), true);
});

test("a retry after a timed-out deploy (the code is already there) sends no second deploy", async () => {
  const { queue, log, chain, settle } = setup({ timeoutMs: 20 });
  await queue.start(USER, "1.1.1.1"); // the deploy step hangs on its gate: the job times out
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await queue.status(USER)).status, "failed");
  log.length = 0;
  chain.set(USER.toLowerCase(), { ...noSteps(), deploy: true }); // the transaction confirmed after all
  await queue.start(USER, "1.1.1.1");
  await settle();
  assert.equal(log.some((l) => l.startsWith("deploy")), false);
  assert.deepEqual(log.map((l) => l.split(" ")[0]), ["register", "record"]);
});

test("finishing an account does not use the deployment budget", async () => {
  const { queue, chain, settle, release } = setup({}, { ...LIMITS, perIpPerWindow: 1 });
  await queue.start("0x01", "9.9.9.9"); // takes the IP's only deployment slot
  await assert.rejects(queue.start("0x02", "9.9.9.9"), (e: any) => e.status === 429);
  chain.set(USER.toLowerCase(), { ...allStepsDone(), register: false, record: false });
  const r = await queue.start(USER, "9.9.9.9"); // same IP, but only finishing
  assert.equal(r.resumed, true);
  await release(); // the first wallet's deployment ends; the queue then finishes this account
  await settle();
  assert.equal((await queue.status(USER)).status, "ready");
});

test("attack: asking over and over to finish one account is capped per account, and across accounts", async () => {
  const stuck = { ...allStepsDone(), record: false };
  const a = setup({}, LIMITS, { failAt: "record" });
  a.chain.set(USER.toLowerCase(), stuck);
  for (let i = 0; i < 2; i++) { await a.queue.start(USER, "1.1.1.1"); await a.settle(); }
  await assert.rejects(a.queue.start(USER, "1.1.1.1"), (e: any) => e instanceof OnboardingError && e.status === 429 && e.code === "onboarding_rate_limited");
  assert.equal(a.log.filter((l) => l.startsWith("record")).length, 2, "the third attempt sent nothing");

  const b = setup({}, LIMITS, { completion: { globalPerWindow: 3, perIpPerWindow: 2, windowMs: 3_600_000 } });
  for (let i = 0; i < 3; i++) b.chain.set(`0x2${i}`, stuck);
  for (let i = 0; i < 3; i++) await b.queue.start(`0x2${i}`, "2.2.2.2");
  b.chain.set("0x29", stuck);
  await assert.rejects(b.queue.start("0x29", "3.3.3.3"), (e: any) => e.status === 429);
  assert.equal(b.log.some((l) => l.startsWith("deploy")), false, "finishing never deploys");
});

test("deriveSteps: the chain decides; nothing after deploy counts without code", () => {
  const all = { hasCode: true, policyConfigured: true, registered: true, recorded: true };
  assert.deepEqual(remainingSteps(deriveSteps(all)), []);
  assert.deepEqual(remainingSteps(deriveSteps({ ...all, hasCode: false })), [...SETUP_STEPS], "local flags can't make an undeployed account ready");
  assert.deepEqual([...SETUP_STEPS], ["deploy", "register", "record"], "no AllowanceModule step: the server's daily limit is the only limit");
  assert.deepEqual(remainingSteps(deriveSteps({ ...all, registered: false, recorded: false })), ["register", "record"]);
  assert.deepEqual(remainingSteps(deriveSteps({ ...all, policyConfigured: false, registered: false })), [], "nothing to register without a policy contract");
});

test("a fully set-up account does nothing on retry (finishSetup runs no step)", async () => {
  const ran: string[] = [];
  const doers = Object.fromEntries(SETUP_STEPS.map((st) => [st, async () => { ran.push(st); }])) as Record<SetupStep, () => Promise<void>>;
  assert.deepEqual(await finishSetup(async () => ({ safeAddress: "a", steps: allStepsDone() }), doers, () => false), []);
  assert.deepEqual(ran, []);
  await assert.rejects(finishSetup(async () => ({ safeAddress: "a", steps: noSteps() }), doers, () => true), /timed out/);
  assert.deepEqual(ran, [], "a cancelled run stops before its next transaction");
});

test("a deployment that never finishes times out, fails its job and lets the next one run", async () => {
  const log: string[] = [];
  const { queue } = setup({
    timeoutMs: 20,
    finish: async (w) => { log.push(`start ${w}`); if (w === USER) await new Promise(() => {}); log.push(`end ${w}`); },
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
  const { queue } = setup({ timeoutMs: 10, finish: async (_w, isCancelled) => { cancelled = isCancelled; await new Promise(() => {}); } });
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
  assert.equal(onboardingErrorMessage(new Error("execution reverted: 0xabc")), "We couldn't finish setting up your account. Please try again.");
  assert.equal(shortAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234…5678");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e: any) { console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed${passed === tests.length ? "" : `, ${tests.length - passed} failed`}`);
})();
