// ─── Safe — account inspection and finishing tests (storage and chain reads injected, no network) ───
// Run with `npm run test:inspect`. ORC-72, ORC-73, ORC-85.

import assert from "node:assert/strict";
import { type AccountReads, type SetupRecord, finishWith, inspectWith, registerAccount } from "./inspect";
import { NOT_PER_ACCOUNT_REGISTRY } from "./policyContract";
import { SETUP_STEPS, type SetupStep, remainingSteps } from "./setupSteps";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const ACCOUNT = "0x62E5AB8e1af31c40792627703654B135488505e7";
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000D4";
const POLICY = "0x315aa01bd89621275ef91198e7f86bc7e48eeb12";
const NEW_POLICY = "0x00000000000000000000000000000000000000a1";

/** A fake world: our storage and the chain, with the same rules the real reads follow. The registry holds one entry per account. */
function world(init: {
  code?: boolean; stored?: boolean; profile?: boolean;
  record?: SetupRecord | null; registry?: string[]; policyAddress?: string | null;
  /** false: the configured contract is the old per-sender registry (or something else), not the per-account one. */
  registryCurrent?: boolean;
} = {}) {
  const w = {
    code: init.code ?? false,
    stored: init.stored ? { safeAddress: ACCOUNT, deployedAt: "2025-01-01T00:00:00.000Z" } as Record<string, unknown> | null : null,
    profile: init.profile ? { safeAddress: ACCOUNT } : null as { safeAddress?: string } | null,
    record: init.record ?? null as SetupRecord | null,
    registry: new Set((init.registry ?? []).map((a) => a.toLowerCase())),
    registryCurrent: init.registryCurrent ?? true,
    txs: [] as string[],
  };
  const policyAddress = init.policyAddress === undefined ? POLICY : init.policyAddress;
  let t = 0;
  const reads: AccountReads = {
    safeAddress: ACCOUNT,
    policyAddress,
    setupRecord: async () => (w.record ? { ...w.record } : null),
    saveSetupRecord: async (r) => { w.record = { ...r }; },
    storedAccount: async () => w.stored,
    profile: async () => w.profile,
    hasCode: async () => w.code,
    registryIsCurrent: async () => w.registryCurrent,
    registeredOnChain: async () => w.registry.has(ACCOUNT.toLowerCase()),
    now: () => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`,
  };
  // The steps, as onboard.ts runs them: each transaction counted; the record step writes our storage.
  const run: Record<SetupStep, () => Promise<void>> = {
    deploy: async () => { w.txs.push("deploy"); w.code = true; },
    // The real rules (onboard.ts runs the same registerAccount): no registry or not the per-account registry → nothing sent (warned), else the chain is asked first.
    register: () => registerAccount(reads, async () => {
      w.txs.push("registerSafe");
      w.registry.add(ACCOUNT.toLowerCase());
    }),
    record: async () => {
      w.stored = { safeAddress: ACCOUNT, deployedAt: (w.stored?.deployedAt as string) ?? reads.now() };
      w.profile = { safeAddress: ACCOUNT };
    },
  };
  return { w, reads, run, finish: () => finishWith(reads, run, () => false) };
}

test("a brand-new account: only deploy, register, record — no AllowanceModule step — then ready", async () => {
  const { w, reads, finish } = world();
  const ran = await finish();
  assert.deepEqual(ran, ["deploy", "register", "record"]);
  assert.deepEqual(w.txs, ["deploy", "registerSafe"]);
  assert.equal("spendingLimitUSD" in w.stored!, false, "no limit stored on the account record");
  assert.ok(w.record?.completedAt, "marked complete");
  assert.equal(w.record?.registeredOn, POLICY, "remembers which registry it registered on");
  assert.deepEqual(remainingSteps((await inspectWith(reads)).steps), []);
  const again = await finish();
  assert.deepEqual(again, []);
  assert.equal(w.txs.length, 2, "a second run sends nothing");
});

test("an account from before the registry fix: registered on the new registry once, whatever another account's entry says", async () => {
  // Set up under the old per-agent flow: stored, a `registeredAt` for the old registry, no `registeredOn`.
  const old: SetupRecord = { safeAddress: ACCOUNT, startedAt: "t", registeredAt: "t", legacy: true };
  const { w, run, reads, finish } = world({ code: true, stored: true, profile: true, record: old });
  assert.equal((await inspectWith(reads)).steps.register, false, "the old registration doesn't count on the new registry");
  await finish();
  assert.deepEqual(w.txs, ["registerSafe"], "only the registration is sent");
  assert.equal(w.record?.registeredOn, POLICY);
  assert.equal(w.record?.legacy, undefined, "the stale flag is dropped");
  assert.equal(w.stored?.deployedAt, "2025-01-01T00:00:00.000Z");
  await finish();
  assert.deepEqual(w.txs, ["registerSafe"], "and not again");
  void run;
});

test("a stale `legacy` flag changes nothing: a legacy-marked record still registers", async () => {
  const old: SetupRecord = { safeAddress: ACCOUNT, startedAt: "t", legacy: true };
  const { w, finish } = world({ code: true, stored: true, profile: true, record: old });
  await finish();
  assert.deepEqual(w.txs, ["registerSafe"]);
});

test("an entry for another account never counts: this account registers itself", async () => {
  const { w, finish } = world({ registry: [OTHER_ACCOUNT] });
  await finish();
  assert.ok(w.txs.includes("registerSafe"));
  assert.ok(w.registry.has(OTHER_ACCOUNT.toLowerCase()) && w.registry.has(ACCOUNT.toLowerCase()), "both keep their own entry");
});

test("already registered on the registry (record lost): no transaction, the record is mended", async () => {
  const { w, finish } = world({ code: true, stored: true, profile: true, registry: [ACCOUNT] });
  await finish();
  assert.deepEqual(w.txs, []);
  assert.equal(w.record?.registeredOn, POLICY);
  assert.ok(w.record?.registeredAt);
});

test("a registration recorded for another registry doesn't count; one for the current registry does", async () => {
  const base = { code: true, stored: true, profile: true };
  const other: SetupRecord = { safeAddress: ACCOUNT, startedAt: "t", registeredAt: "t", registeredOn: NEW_POLICY };
  assert.equal((await inspectWith(world({ ...base, record: other }).reads)).steps.register, false);
  const mine: SetupRecord = { safeAddress: ACCOUNT, startedAt: "t", registeredAt: "t", registeredOn: POLICY.toUpperCase().replace("0X", "0x") };
  assert.equal((await inspectWith(world({ ...base, record: mine }).reads)).steps.register, true, "address case doesn't matter");
});

test("a finished account stays ready when the registry changed: only 'registration pending' is reported", async () => {
  const done: SetupRecord = { safeAddress: ACCOUNT, startedAt: "t", registeredAt: "t", registeredOn: POLICY, completedAt: "t" };
  const { reads } = world({ record: done, policyAddress: NEW_POLICY });
  const seen = await inspectWith(reads);
  assert.deepEqual(remainingSteps(seen.steps), [], "still ready");
  assert.equal(seen.registrationPending, true);
  const current = await inspectWith(world({ record: done }).reads);
  assert.equal(current.registrationPending, undefined, "registered on the current registry: nothing pending");
});

test("no registry configured: nothing to register, finished accounts stay ready and nothing is pending", async () => {
  const done: SetupRecord = { safeAddress: ACCOUNT, startedAt: "t", registeredAt: "t", completedAt: "t" };
  const seen = await inspectWith(world({ record: done, policyAddress: null }).reads);
  assert.deepEqual(remainingSteps(seen.steps), []);
  assert.equal(seen.registrationPending, undefined);
  const fresh = world({ policyAddress: null });
  const ran = await fresh.finish();
  assert.ok(!fresh.w.txs.includes("registerSafe"));
  assert.deepEqual(ran, ["deploy", "register", "record"]);
  assert.equal(fresh.w.record?.registeredOn, undefined);
});

/** Runs `fn` and returns what it logged with console.warn. */
async function warnings(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => { seen.push(args.join(" ")); };
  try { await fn(); } finally { console.warn = real; }
  return seen;
}

test("attack: the old per-sender registry still configured — a NEW account is set up and ready, nothing sent or marked, one clear warning", async () => {
  const fresh = world({ registryCurrent: false });
  const warned = await warnings(() => fresh.finish());
  assert.deepEqual(fresh.w.txs, ["deploy"], "everything but a registerSafe");
  assert.ok(fresh.w.record?.completedAt, "setup finished");
  assert.equal(fresh.w.record?.registeredOn, undefined, "not marked registered on the wrong contract");
  assert.equal(fresh.w.record?.registeredAt, undefined);
  assert.deepEqual(remainingSteps((await inspectWith(fresh.reads)).steps), [], "ready");
  assert.equal(warned.filter((m) => m.includes(NOT_PER_ACCOUNT_REGISTRY)).length, 1, "warned once per run");

  // An entry on that contract doesn't count as registered either (mid-setup account).
  const midway = world({ code: true, stored: true, profile: true, registryCurrent: false, registry: [ACCOUNT], record: { safeAddress: ACCOUNT, startedAt: "t" } });
  await midway.finish();
  assert.deepEqual(midway.w.txs, []);
  assert.equal(midway.w.record?.registeredOn, undefined);
  assert.ok(midway.w.record?.completedAt);

  // Later a correct registry is configured: the finished account is pending and registers once.
  fresh.w.registryCurrent = true;
  assert.equal((await inspectWith(fresh.reads)).registrationPending, true);
  await registerAccount(fresh.reads, async () => { fresh.w.txs.push("registerSafe"); fresh.w.registry.add(ACCOUNT.toLowerCase()); });
  assert.equal(fresh.w.txs.filter((t) => t === "registerSafe").length, 1);
  assert.equal(fresh.w.record?.registeredOn, POLICY);
  assert.equal((await inspectWith(fresh.reads)).registrationPending, undefined);
});

test("attack: the old registry still configured — a finished account stays ready, nothing is pending, sent or marked", async () => {
  const done: SetupRecord = { safeAddress: ACCOUNT, startedAt: "t", registeredAt: "t", completedAt: "t" };
  const finished = world({ record: done, registryCurrent: false });
  const seen = await inspectWith(finished.reads);
  assert.deepEqual(remainingSteps(seen.steps), [], "still ready");
  assert.equal(seen.registrationPending, undefined, "not worth attempting: no background registration at every sign-in");
  await warnings(() => registerAccount(finished.reads, async () => { finished.w.txs.push("registerSafe"); }));
  assert.deepEqual(finished.w.txs, [], "no registerSafe sent to the old contract");
  assert.equal(finished.w.record?.registeredOn, undefined);
  assert.equal(finished.w.record?.registeredAt, "t", "record untouched");
});

test("the stuck state (record present, no completedAt): ready with the registration only", async () => {
  for (const profile of [true, false]) {
    const old: SetupRecord = { safeAddress: ACCOUNT, startedAt: "2026-01-01T00:00:00.000Z" };
    const { w, reads, finish } = world({ code: true, stored: true, profile, record: old, registry: [ACCOUNT] });
    await finish();
    assert.deepEqual(w.txs, [], `profile=${profile}`);
    assert.ok(w.record?.completedAt);
    assert.deepEqual(remainingSteps((await inspectWith(reads)).steps), []);
  }
});

test("'recorded' means our stored account and profile are really written", async () => {
  const base = { code: true };
  const rec: SetupRecord = { safeAddress: ACCOUNT, startedAt: "t", registeredAt: "t", registeredOn: POLICY };
  assert.equal((await inspectWith(world({ ...base, record: rec }).reads)).steps.record, false, "nothing stored");
  assert.equal((await inspectWith(world({ ...base, record: rec, stored: true }).reads)).steps.record, false, "no profile yet");
  assert.equal((await inspectWith(world({ ...base, record: rec, stored: true, profile: true }).reads)).steps.record, true);
  const w = world({ ...base, record: rec, stored: true, profile: true });
  w.w.stored = { safeAddress: OTHER_ACCOUNT };
  assert.equal((await inspectWith(w.reads)).steps.record, false, "stored for a different address doesn't count");
});

test("a failed read stops everything: unknown is never 'not deployed' or 'not registered'", async () => {
  const { reads, run } = world();
  const broken: AccountReads = { ...reads, hasCode: async () => { throw new Error("rpc down"); } };
  await assert.rejects(finishWith(broken, run, () => false), /rpc down/);
  const w = world({ code: true, stored: true, profile: true });
  const brokenRegistry: AccountReads = { ...w.reads, registeredOnChain: async () => { throw new Error("rpc down"); } };
  await assert.rejects(inspectWith(brokenRegistry), /rpc down/);
});

test("a setup that ends incomplete says which step, and is not marked complete", async () => {
  const { w, reads, run } = world();
  const noRecord = { ...run, record: async () => {} }; // the record step silently does nothing
  await assert.rejects(finishWith(reads, noRecord, () => false), /setup incomplete: record/);
  assert.equal(w.record?.completedAt, undefined);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e: any) { console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed${passed === tests.length ? "" : `, ${tests.length - passed} failed`}`);
})();
