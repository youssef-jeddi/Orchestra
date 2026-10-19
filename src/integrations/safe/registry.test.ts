// ─── Safe — registering finished accounts on the policy registry (no network) ───
// Run with `npm run test:registry`. ORC-73: the registry is keyed by account, so an account set up
// before the fix registers once on the new registry at its next sign-in. It stays ready meanwhile
// (the registry doesn't gate spending), and nothing changes when no registry is configured.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { OnboardingQueue, OnboardingLimiter, accountReady } from "./onboarding";
import { inspectWith, registerAccount, type AccountReads, type SetupRecord } from "./inspect";
import { POLICY_ABI, isPerAccountRegistry, policyAddress } from "./policyContract";

const OLD = "0x315aa01bd89621275ef91198e7f86bc7e48eeb12";
const NEW = "0x00000000000000000000000000000000000000a1";
const SAFE = "0x62E5AB8e1af31c40792627703654B135488505e7";

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A finished account, as the queue sees it, with a registration function that counts and can fail. */
function setup(opts: { policy: string | null; registeredOn?: string; fail?: () => boolean; hang?: boolean; oldStyle?: boolean }) {
  let record: SetupRecord = { safeAddress: SAFE, startedAt: "t", registeredAt: "t", completedAt: "t", ...(opts.registeredOn ? { registeredOn: opts.registeredOn } : {}) };
  const reads: AccountReads = {
    safeAddress: SAFE, policyAddress: opts.policy,
    setupRecord: async () => record, saveSetupRecord: async (r) => { record = r; },
    storedAccount: async () => null, profile: async () => null, hasCode: async () => { throw new Error("must not read the chain"); },
    registryIsCurrent: async () => !opts.oldStyle, registeredOnChain: async () => false, now: () => "t2",
  };
  const calls = { registered: 0, finished: 0, sent: 0 };
  const queue = new OnboardingQueue({
    inspect: () => inspectWith(reads),
    finish: async () => { calls.finished++; },
    registerFinished: async () => {
      calls.registered++;
      if (opts.hang) return new Promise<void>(() => {});
      if (opts.fail?.()) throw new Error("agent out of gas");
      await registerAccount(reads, async () => { calls.sent++; }); // the real rules; `sent` stands for the registerSafe transaction
    },
    limiter: new OnboardingLimiter(),
    timeoutMs: 30,
  });
  return { queue, calls, record: () => record };
}

test("a finished account on a newly configured registry stays ready and is registered at the next sign-in", async () => {
  const s = setup({ policy: NEW, registeredOn: OLD });
  assert.equal(await accountReady(s.queue, ethers.Wallet.createRandom().address), true, "ready before anything is registered");
  const wallet = ethers.Wallet.createRandom().address;
  const started = await s.queue.start(wallet, "ip");
  assert.equal(started.status, "ready", "sign-in reports ready, not 'deploying'");
  assert.equal(await accountReady(s.queue, wallet), true, "and stays ready while the registration runs");
  await tick();
  assert.equal(s.calls.registered, 1);
  assert.equal(s.calls.finished, 0, "no setup run, no deployment");
  assert.equal(s.record().registeredOn, NEW);
  await s.queue.start(wallet, "ip");
  await tick();
  assert.equal(s.calls.registered, 1, "registered on the current registry: nothing more to do");
});

test("an account set up before registry tracking (no registeredOn) is registered once too", async () => {
  const s = setup({ policy: OLD });
  await s.queue.start(ethers.Wallet.createRandom().address, "ip");
  await tick();
  assert.equal(s.calls.registered, 1);
});

test("attack: ORCHESTRA_POLICY_ADDRESS still the old per-sender registry — no registerSafe is sent, the account stays ready and unmarked", async () => {
  const s = setup({ policy: OLD, registeredOn: undefined, oldStyle: true });
  const w = ethers.Wallet.createRandom().address;
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.queue.start(w, "ip")).status, "ready", "sign-in still reports ready");
    await tick();
    assert.equal(await accountReady(s.queue, w), true);
  }
  assert.equal(s.calls.registered, 0, "no attempt at all: no budget spent, no error logged at every sign-in");
  assert.equal(s.calls.sent, 0, "and nothing was sent to the old contract");
  assert.equal(s.record().registeredOn, undefined, "never marked registered on it");
  assert.equal(s.calls.finished, 0);
});

test("no registry configured: nothing is registered and accounts stay ready", async () => {
  const s = setup({ policy: null });
  const w = ethers.Wallet.createRandom().address;
  for (let i = 0; i < 3; i++) assert.equal((await s.queue.start(w, "ip")).status, "ready");
  await tick();
  assert.equal(s.calls.registered, 0);
  assert.equal(s.calls.finished, 0);
});

test("a failing registration never blocks the account and is retried at the next sign-in, within the budget", async () => {
  let failing = true;
  const s = setup({ policy: NEW, fail: () => failing });
  const w = ethers.Wallet.createRandom().address;
  assert.equal((await s.queue.start(w, "ip")).status, "ready");
  await tick();
  assert.equal(s.calls.registered, 1);
  assert.equal(await accountReady(s.queue, w), true, "still ready after the failure");
  failing = false;
  await s.queue.start(w, "ip");
  await tick();
  assert.equal(s.calls.registered, 2);
  assert.equal(s.record().registeredOn, NEW);
  // The per-account budget caps a registration that keeps failing.
  failing = true;
  const s2 = setup({ policy: NEW, fail: () => true });
  const w2 = ethers.Wallet.createRandom().address;
  for (let i = 0; i < 10; i++) { await s2.queue.start(w2, "ip"); await tick(); }
  assert.ok(s2.calls.registered <= 4, `capped at the completion budget, ran ${s2.calls.registered}`);
});

test("concurrent sign-ins start one registration; a hanging one is given up on and doesn't block the account", async () => {
  const s = setup({ policy: NEW, hang: true });
  const w = ethers.Wallet.createRandom().address;
  await Promise.all([s.queue.start(w, "ip"), s.queue.start(w, "ip"), s.queue.start(w, "ip")]);
  await tick();
  assert.equal(s.calls.registered, 1);
  assert.equal(await accountReady(s.queue, w), true);
  await new Promise((r) => setTimeout(r, 60)); // past the timeout
  await s.queue.start(w, "ip");
  await tick();
  assert.equal(s.calls.registered, 2, "tried again once the first was given up on");
});

/** A contract runner that answers every call with `answer`, or fails like a revert. */
const runnerAnswering = (answer: () => string) => ({ provider: null, call: async () => answer() }) as unknown as ethers.ContractRunner;
const encodeAddress = (a: string) => ethers.AbiCoder.defaultAbiCoder().encode(["address"], [a]);

test("isPerAccountRegistry: only a contract whose agent() is ours counts (any case); a revert or another agent says no", async () => {
  const agent = ethers.Wallet.createRandom().address;
  const other = ethers.Wallet.createRandom().address;
  assert.equal(await isPerAccountRegistry(runnerAnswering(() => encodeAddress(agent)), OLD, agent), true);
  assert.equal(await isPerAccountRegistry(runnerAnswering(() => encodeAddress(agent)), OLD, agent.toLowerCase()), true, "case doesn't matter");
  assert.equal(await isPerAccountRegistry(runnerAnswering(() => encodeAddress(agent.toLowerCase())), OLD, agent.toUpperCase().replace("0X", "0x")), true);
  assert.equal(await isPerAccountRegistry(runnerAnswering(() => encodeAddress(other)), OLD, agent), false, "another agent");
  assert.equal(await isPerAccountRegistry(runnerAnswering(() => { throw new Error("execution reverted"); }), OLD, agent), false, "the old contract has no agent()");
  assert.equal(await isPerAccountRegistry(runnerAnswering(() => "0x"), OLD, agent), false, "an empty answer (no such function / no contract)");
});

test("the registry ABI is per account and the configured address is lowercased", async () => {
  const iface = new ethers.Interface(POLICY_ABI);
  assert.deepEqual(iface.getFunction("registerSafe")!.inputs.map((i) => i.name), ["safeAddress", "owner", "spendingLimitUSD"]);
  assert.deepEqual(iface.getFunction("updateSpendingLimit")!.inputs.map((i) => i.name), ["safeAddress", "newLimitUSD"]);
  assert.deepEqual(iface.getFunction("hasPolicy")!.inputs.map((i) => i.name), ["safeAddress"]);
  const saved = process.env.ORCHESTRA_POLICY_ADDRESS;
  process.env.ORCHESTRA_POLICY_ADDRESS = "  0xABCDEF0000000000000000000000000000000001 ";
  assert.equal(policyAddress(), "0xabcdef0000000000000000000000000000000001");
  process.env.ORCHESTRA_POLICY_ADDRESS = "";
  assert.equal(policyAddress(), null);
  if (saved === undefined) delete process.env.ORCHESTRA_POLICY_ADDRESS; else process.env.ORCHESTRA_POLICY_ADDRESS = saved;
});

(async () => {
  console.log("registry");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
