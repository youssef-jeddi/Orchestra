// ─── Safe — account setup recovery tests (no network: a fake chain and fake agent transactions) ───
// A failure, a timeout with the transaction still pending, and a timeout with it mined, at each
// step: the retry must finish setup with every transaction sent exactly once.
// Run with `npm run test:setup-recovery`.

import assert from "node:assert/strict";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { setupProgressText, onboardingErrorMessage, firstCheck, safeStatusFor } from "../../../frontend/src/lib/onboarding.js";
import { OnboardingLimiter, OnboardingQueue, OnboardingError, accountReady, type OnboardingStatus } from "./onboarding";
import { SETUP_STEPS, type SetupStep, type SetupSteps, finishSetup } from "./setupSteps";
import {
  type ChainProbes, type InflightRecord, type InflightStore, INFLIGHT_GRACE_MS, INFLIGHT_MIN_DROP_MS,
  SetupPendingError, judgeInflight, makeTracker,
} from "./inflight";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const USER = "0x00000000000000000000000000000000000000B2";
const ADDRESS = "0xSAFE-of-B2"; // the same on every inspect: the account's address never changes
const TX_STEPS = SETUP_STEPS.filter((s) => s !== "record"); // "record" is our own storage, no transaction
const none = (): SetupSteps => ({ deploy: false, module: false, delegate: false, allowances: false, register: false, record: false });

/** The agent's account on a fake chain: transactions it sent, which are mined, which setup steps hold. */
class FakeChain {
  steps = none();
  sends: string[] = [];
  txs = new Map<string, { step: SetupStep; nonce: number; mined: boolean; known: boolean }>();
  pending = 0;
  latest = 0;
  broadcast(step: SetupStep): string {
    const hash = `0xhash${this.sends.length}`;
    this.txs.set(hash, { step, nonce: this.pending++, mined: false, known: true });
    this.sends.push(step);
    return hash;
  }
  mine(hash: string) {
    const tx = this.txs.get(hash)!;
    tx.mined = true;
    this.latest = Math.max(this.latest, tx.nonce + 1);
    this.steps[tx.step] = true;
  }
  /** The network forgot it, and the agent's next transaction took its nonce. */
  drop(hash: string) {
    const tx = this.txs.get(hash)!;
    tx.known = false;
    this.latest = Math.max(this.latest, tx.nonce + 1);
  }
  probes: ChainProbes = {
    receipt: async (h) => { const t = this.txs.get(h); return t?.mined ? { ok: true } : null; },
    known: async (h) => !!this.txs.get(h)?.known,
    pendingNonce: async () => this.pending,
    latestNonce: async () => this.latest,
  };
}

type Mode = "ok" | "fail_before_send" | "hang_after_send";

function rig(opts: { timeoutMs?: number; completion?: { globalPerWindow: number; perIpPerWindow: number; windowMs: number } } = {}) {
  const chain = new FakeChain();
  let clock = 5_000_000;
  const modes = new Map<SetupStep, Mode>(); // what the next attempt at a step does
  let record: InflightRecord | null = null;
  const store: InflightStore = { load: async () => record && { ...record }, save: async (r) => { record = { ...r }; }, clear: async () => { record = null; } };
  const inspect = async () => ({ safeAddress: ADDRESS, steps: { ...chain.steps } });

  // The same protocol the real steps follow: check the chain, begin, send, record the hash, wait, settle.
  const doer = (step: SetupStep, isCancelled: () => boolean) => async () => {
    if (chain.steps[step]) return;
    if (step === "record") { chain.steps.record = true; return; }
    const mode = modes.get(step) ?? "ok";
    modes.delete(step); // only the first attempt misbehaves
    if (mode === "fail_before_send") throw new Error("estimate reverted: 0xdeadbeef");
    const tracker = makeTracker(step, { store, probes: chain.probes, isCancelled, now: () => clock });
    await tracker.begin();
    const hash = chain.broadcast(step);
    await tracker.sent(hash);
    if (mode === "hang_after_send") await new Promise(() => {}); // the receipt never arrives before the timeout
    chain.mine(hash);
    await tracker.settled();
  };
  const queue = new OnboardingQueue({
    inspect,
    finish: async (_w, isCancelled) => {
      await finishSetup(inspect, Object.fromEntries(SETUP_STEPS.map((s) => [s, doer(s, isCancelled)])) as Record<SetupStep, () => Promise<void>>, isCancelled);
    },
    limiter: new OnboardingLimiter({ globalPerWindow: 100, perIpPerWindow: 100, windowMs: 3_600_000 }, () => clock),
    completionLimiter: new OnboardingLimiter(opts.completion ?? { globalPerWindow: 100, perIpPerWindow: 50, windowMs: 3_600_000 }, () => clock, () => "wait"),
    timeoutMs: opts.timeoutMs ?? 30,
  });
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  return { chain, queue, modes, store, settle, advance: (ms: number) => { clock += ms; }, record: () => record };
}

const sendsOf = (c: FakeChain, step: SetupStep) => c.sends.filter((s) => s === step).length;
const allOnce = (c: FakeChain) => TX_STEPS.every((s) => sendsOf(c, s) === 1);

for (const step of TX_STEPS) {
  test(`${step}: fails before sending → not ready; the retry sends it once and finishes`, async () => {
    const r = rig();
    r.modes.set(step, "fail_before_send");
    const first = await r.queue.start(USER, "1.1.1.1");
    await r.settle();
    const failed = await r.queue.status(USER);
    assert.equal(failed.status, "failed");
    assert.notEqual(failed.status, "ready");
    assert.ok(failed.remaining!.includes(step));
    assert.ok(!failed.error!.includes("0xdeadbeef"));
    await r.queue.start(USER, "1.1.1.1");
    await r.settle();
    const done = await r.queue.status(USER);
    assert.equal(done.status, "ready");
    assert.equal(done.safeAddress, first.safeAddress);
    assert.ok(allOnce(r.chain), `each transaction exactly once: ${r.chain.sends}`);
    assert.equal(r.record(), null, "no in-flight record is left behind");
  });

  test(`${step}: timeout with the transaction still pending → the retry sends nothing, then finishes once it confirms`, async () => {
    const r = rig();
    r.modes.set(step, "hang_after_send");
    await r.queue.start(USER, "1.1.1.1");
    await r.settle();
    assert.equal((await r.queue.status(USER)).status, "failed");
    assert.equal(sendsOf(r.chain, step), 1);

    for (let i = 0; i < 3; i++) { // asking again while it is unconfirmed
      await r.queue.start(USER, "1.1.1.1");
      await r.settle();
      const st = await r.queue.status(USER);
      assert.equal(st.status, "failed");
      assert.equal(st.errorCode, "setup_pending");
      assert.match(st.error!, /still finishing/);
      assert.equal(sendsOf(r.chain, step), 1, "nothing was sent again");
    }

    r.chain.mine("0xhash" + (r.chain.sends.length - 1)); // it confirms after all
    await r.queue.start(USER, "1.1.1.1");
    await r.settle();
    assert.equal((await r.queue.status(USER)).status, "ready");
    assert.ok(allOnce(r.chain), `each transaction exactly once: ${r.chain.sends}`);
    assert.equal(sendsOf(r.chain, "deploy"), 1, "never a second deploy");
  });

  test(`${step}: timeout but the transaction was mined → the retry finishes only what is missing`, async () => {
    const r = rig();
    r.modes.set(step, "hang_after_send");
    const first = await r.queue.start(USER, "1.1.1.1");
    await r.settle();
    r.chain.mine("0xhash" + (r.chain.sends.length - 1)); // mined; the process never recorded it
    const before = r.chain.sends.length;
    const retry = await r.queue.start(USER, "1.1.1.1");
    assert.equal(retry.safeAddress, first.safeAddress);
    await r.settle();
    assert.equal((await r.queue.status(USER)).status, "ready");
    assert.ok(allOnce(r.chain));
    const later = r.chain.sends.slice(before);
    assert.deepEqual(later, TX_STEPS.slice(TX_STEPS.indexOf(step) + 1), "only the steps after it were sent");
  });
}

test("record (our own storage) fails → not ready; the retry runs only that step", async () => {
  const r = rig();
  const real = r.chain.steps;
  let failRecord = true;
  const q = new OnboardingQueue({
    inspect: async () => ({ safeAddress: ADDRESS, steps: { ...real } }),
    finish: async () => {
      for (const s of SETUP_STEPS) {
        if (real[s]) continue;
        if (s === "record" && failRecord) { failRecord = false; throw new Error("disk full"); }
        if (s !== "record") r.chain.sends.push(s);
        real[s] = true;
      }
    },
    limiter: new OnboardingLimiter({ globalPerWindow: 9, perIpPerWindow: 9, windowMs: 1e6 }),
  });
  await q.start(USER, "1.1.1.1");
  await r.settle();
  const st = await q.status(USER);
  assert.equal(st.status, "failed");
  assert.deepEqual(st.remaining, ["record"]);
  await q.start(USER, "1.1.1.1");
  await r.settle();
  assert.equal((await q.status(USER)).status, "ready");
  assert.ok(allOnce(r.chain));
});

test("a dropped transaction is re-sent, but only after the wait", async () => {
  const r = rig();
  r.modes.set("module", "hang_after_send");
  await r.queue.start(USER, "1.1.1.1");
  await r.settle();
  r.chain.drop("0xhash1"); // deploy was hash0, module hash1; the network forgot it
  r.advance(INFLIGHT_MIN_DROP_MS - 1);
  await r.queue.start(USER, "1.1.1.1");
  await r.settle();
  assert.equal(sendsOf(r.chain, "module"), 1, "too soon to be sure it was dropped");
  r.advance(2);
  await r.queue.start(USER, "1.1.1.1");
  await r.settle();
  assert.equal((await r.queue.status(USER)).status, "ready");
  assert.equal(sendsOf(r.chain, "module"), 2, "re-sent once it can no longer confirm");
  assert.equal(sendsOf(r.chain, "deploy"), 1);
});

test("two retries at once share one run: one set of transactions", async () => {
  const r = rig();
  r.modes.set("delegate", "fail_before_send");
  await r.queue.start(USER, "1.1.1.1");
  await r.settle();
  const results = await Promise.all(["1.1.1.1", "2.2.2.2", "3.3.3.3", "1.1.1.1", "4.4.4.4"].map((ip) => r.queue.start(USER, ip)));
  assert.equal(results.filter((x) => x.started).length, 1);
  await r.settle();
  assert.equal((await r.queue.status(USER)).status, "ready");
  assert.ok(allOnce(r.chain), `${r.chain.sends}`);
});

test("a timed-out run cannot send its next transaction while the retry runs", async () => {
  const r = rig();
  let cancelled = false;
  const t = makeTracker("allowances", { store: r.store, probes: r.chain.probes, isCancelled: () => cancelled });
  cancelled = true; // the job timed out
  await assert.rejects(t.begin(), /timed out/);
  assert.equal(r.record(), null);
  assert.equal(r.chain.sends.length, 0);
});

test("attack: asking again and again while a transaction is unconfirmed is capped and sends nothing", async () => {
  const r = rig({ completion: { globalPerWindow: 50, perIpPerWindow: 3, windowMs: 3_600_000 } });
  r.modes.set("module", "hang_after_send");
  await r.queue.start(USER, "1.1.1.1");
  await r.settle();
  let refused: unknown;
  for (let i = 0; i < 6 && !refused; i++) {
    try { await r.queue.start(USER, `9.9.9.${i}`); await r.settle(); } catch (e) { refused = e; }
  }
  assert.ok(refused instanceof OnboardingError && refused.status === 429 && refused.code === "onboarding_rate_limited");
  assert.equal(r.chain.sends.length, 2, "deploy and the one module transaction, nothing more");
});

test("judgeInflight: mined, pending, replaced, dropped, never sent", async () => {
  const now = 1_000_000;
  const probes = (o: Partial<{ receipt: boolean; known: boolean; pending: number; latest: number }>): ChainProbes => ({
    receipt: async () => (o.receipt ? { ok: true } : null), known: async () => !!o.known,
    pendingNonce: async () => o.pending ?? 0, latestNonce: async () => o.latest ?? 0,
  });
  const rec = (over: Partial<InflightRecord> = {}): InflightRecord => ({ step: "module", agentNonce: 5, startedAt: now, hash: "0xh", ...over });
  assert.equal(await judgeInflight(rec(), probes({ receipt: true }), now + 1), "settled");
  assert.equal(await judgeInflight(rec(), probes({ known: true, latest: 9 }), now + INFLIGHT_GRACE_MS * 5), "pending", "a transaction the network still holds is always waited for");
  assert.equal(await judgeInflight(rec(), probes({ latest: 6 }), now + 1000), "pending", "an RPC that doesn't show it yet proves nothing");
  assert.equal(await judgeInflight(rec(), probes({ latest: 6 }), now + INFLIGHT_MIN_DROP_MS), "clear", "replaced: the agent's nonce moved on");
  assert.equal(await judgeInflight(rec(), probes({ latest: 5 }), now + INFLIGHT_MIN_DROP_MS), "pending");
  assert.equal(await judgeInflight(rec(), probes({ latest: 5 }), now + INFLIGHT_GRACE_MS), "clear");
  assert.equal(await judgeInflight(rec({ hash: undefined }), probes({ pending: 5 }), now + 1), "clear", "intent only, nothing left the agent");
  assert.equal(await judgeInflight(rec({ hash: undefined }), probes({ pending: 6 }), now + 1), "pending", "intent only, a send may have happened");
  assert.equal(await judgeInflight(rec({ hash: undefined }), probes({ pending: 6 }), now + INFLIGHT_GRACE_MS), "clear");
  const broken: ChainProbes = { ...probes({}), receipt: async () => { throw new Error("rpc down"); } };
  await assert.rejects(judgeInflight(rec(), broken, now), /rpc down/, "not knowing is not 'nothing in flight'");
});

test("a crash between recording the intent and the send: the next run waits, then sends once", async () => {
  const r = rig();
  const t = makeTracker("module", { store: r.store, probes: r.chain.probes, isCancelled: () => false, now: () => 5_000_000 });
  await t.begin(); // recorded; then the process died (maybe after broadcasting)
  r.chain.pending++; // a transaction did leave the agent
  const next = makeTracker("module", { store: r.store, probes: r.chain.probes, isCancelled: () => false, now: () => 5_000_000 + 1000 });
  await assert.rejects(next.begin(), (e: unknown) => e instanceof SetupPendingError && e.status === 409 && e.code === "setup_pending");
});

test("account readiness: only a finished setup lets the agent act; errors and unfinished setups say no", async () => {
  const q = (s: () => Promise<OnboardingStatus>) => ({ status: s });
  const st = (status: OnboardingStatus["status"]) => async (): Promise<OnboardingStatus> => ({ status, safeAddress: ADDRESS });
  assert.equal(await accountReady(q(st("ready")), USER), true);
  for (const s of ["deploying", "failed", "not_started"] as const) assert.equal(await accountReady(q(st(s)), USER), false);
  assert.equal(await accountReady(q(async () => { throw new Error("rpc down"); }), USER), false);
});

test("UI: finishing and failed states are plain; the signed-in check goes to the setup status, not the address lookup", () => {
  assert.equal(setupProgressText(false), "Setting up your account…");
  assert.equal(setupProgressText(true), "Finishing setting up your account…");
  assert.equal(firstCheck(true), "setup");
  assert.equal(firstCheck(false), "lookup");
  assert.equal(safeStatusFor("failed"), "error");
  const pending = new SetupPendingError();
  const texts = [
    setupProgressText(true), setupProgressText(false), onboardingErrorMessage(), onboardingErrorMessage({ code: "setup_pending", message: pending.message }),
    "Try again", pending.message,
  ];
  assert.match(texts[3], /still finishing/);
  assert.equal(onboardingErrorMessage(new Error("execution reverted: 0xabc")), "We couldn't finish setting up your account. Please try again.");
  for (const t of texts) assert.doesNotMatch(t, /safe|module|delegate|allowance|nonce|revert|0x/i, t);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e: any) { console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed${passed === tests.length ? "" : `, ${tests.length - passed} failed`}`);
})();
