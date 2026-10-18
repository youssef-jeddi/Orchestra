// ─── Safe — account inspection and finishing tests (storage and chain reads injected, no network) ───
// Run with `npm run test:inspect`. ORC-72.

import assert from "node:assert/strict";
import { type AccountReads, type SetupRecord, finishWith, inspectWith } from "./inspect";
import { SETUP_STEPS, type SetupStep, remainingSteps } from "./setupSteps";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const ACCOUNT = "0x62E5AB8e1af31c40792627703654B135488505e7";
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000D4";

/** A fake world: our storage and the chain, with the same rules the real reads follow. */
function world(init: { code?: boolean; module?: boolean; delegate?: boolean; allowancesMissing?: number; stored?: boolean; profile?: boolean; record?: SetupRecord | null; policyPointsAt?: string } = {}) {
  const w = {
    code: init.code ?? false, module: init.module ?? false, delegate: init.delegate ?? false, allowancesMissing: init.allowancesMissing ?? 3,
    stored: init.stored ? { safeAddress: ACCOUNT, spendingLimitUSD: 250, deployedAt: "2025-01-01T00:00:00.000Z" } as Record<string, unknown> | null : null,
    profile: init.profile ? { safeAddress: ACCOUNT } : null as { safeAddress?: string } | null,
    record: init.record ?? null as SetupRecord | null,
    policyPointsAt: init.policyPointsAt ?? "0x0000000000000000000000000000000000000000",
    txs: [] as string[],
  };
  let t = 0;
  const reads: AccountReads = {
    safeAddress: ACCOUNT,
    policyConfigured: true,
    setupRecord: async () => (w.record ? { ...w.record } : null),
    saveSetupRecord: async (r) => { w.record = { ...r }; },
    storedAccount: async () => w.stored,
    profile: async () => w.profile,
    hasCode: async () => w.code,
    moduleEnabled: async () => w.module,
    agentIsDelegate: async () => w.delegate,
    allowancesMissing: async () => w.allowancesMissing,
    registeredOnChain: async () => w.policyPointsAt.toLowerCase() === ACCOUNT.toLowerCase(),
    now: () => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`,
  };
  // The steps, as onboard.ts runs them: each transaction counted; the record step writes our storage.
  const run: Record<SetupStep, () => Promise<void>> = {
    deploy: async () => { w.txs.push("deploy"); w.code = true; },
    module: async () => { w.txs.push("module"); w.module = true; },
    delegate: async () => { w.txs.push("delegate"); w.delegate = true; },
    allowances: async () => { for (; w.allowancesMissing > 0; w.allowancesMissing--) w.txs.push("allowance"); },
    register: async () => {
      w.txs.push("registerSafe");
      w.policyPointsAt = ACCOUNT;
      w.record = { ...w.record!, registeredAt: reads.now() };
    },
    record: async () => {
      w.stored = { safeAddress: ACCOUNT, spendingLimitUSD: (w.stored?.spendingLimitUSD as number) ?? 100, deployedAt: (w.stored?.deployedAt as string) ?? reads.now() };
      w.profile = { safeAddress: ACCOUNT };
    },
  };
  return { w, reads, run, finish: () => finishWith(reads, run, () => false) };
}

test("(b) a brand-new account: every step once, then ready — not stuck on 'record'", async () => {
  const { w, reads, finish } = world();
  const ran = await finish();
  assert.deepEqual(ran, [...SETUP_STEPS]);
  assert.deepEqual(w.txs, ["deploy", "module", "delegate", "allowance", "allowance", "allowance", "registerSafe"]);
  assert.ok(w.record?.completedAt, "marked complete");
  assert.equal(w.record?.legacy, false);
  assert.deepEqual(remainingSteps((await inspectWith(reads)).steps), []);
  const again = await finish();
  assert.deepEqual(again, []);
  assert.equal(w.txs.length, 7, "a second run sends nothing");
});

test("(a) a legacy account missing its allowances: only the allowances are sent, no registration, ends ready", async () => {
  const { w, finish } = world({ code: true, module: true, delegate: true, allowancesMissing: 3, stored: true, profile: false, policyPointsAt: OTHER_ACCOUNT });
  const ran = await finish();
  assert.deepEqual(w.txs, ["allowance", "allowance", "allowance"]);
  assert.ok(!w.txs.includes("registerSafe"), "never overwrites another account's registration");
  assert.deepEqual(ran, ["allowances", "record"]);
  assert.ok(w.record?.completedAt);
  assert.equal(w.record?.legacy, true, "remembered on the setup record before any transaction");
  assert.equal(w.stored?.spendingLimitUSD, 250, "its stored limit and deploy date are kept");
  assert.equal(w.stored?.deployedAt, "2025-01-01T00:00:00.000Z");
});

test("a legacy account stays legacy once the setup record exists (no re-registration, even for a record written before the flag)", async () => {
  // The record finishAccount wrote on the real chain before this fix: no `legacy`, no `registeredAt`.
  const old: SetupRecord = { safeAddress: ACCOUNT, startedAt: "2026-01-01T00:00:00.000Z" };
  const { w, reads, finish } = world({ code: true, module: true, delegate: true, allowancesMissing: 0, stored: true, profile: true, record: old, policyPointsAt: OTHER_ACCOUNT });
  const seen = await inspectWith(reads);
  assert.equal(seen.legacy, true);
  assert.equal(seen.steps.register, true);
  await finish();
  assert.equal(w.txs.length, 0);
});

test("(c) the stuck state (record present, allowances done, no completedAt): ready with zero transactions", async () => {
  for (const profile of [true, false]) {
    const old: SetupRecord = { safeAddress: ACCOUNT, startedAt: "2026-01-01T00:00:00.000Z" };
    const { w, reads, finish } = world({ code: true, module: true, delegate: true, allowancesMissing: 0, stored: true, profile, record: old, policyPointsAt: OTHER_ACCOUNT });
    await finish();
    assert.deepEqual(w.txs, [], `profile=${profile}`);
    assert.ok(w.record?.completedAt);
    assert.deepEqual(remainingSteps((await inspectWith(reads)).steps), []);
  }
});

test("'recorded' means our stored account and profile are really written, whatever the legacy flag says", async () => {
  const base = { code: true, module: true, delegate: true, allowancesMissing: 0 };
  const rec = (legacy: boolean): SetupRecord => ({ safeAddress: ACCOUNT, startedAt: "t", registeredAt: "t", legacy });
  for (const legacy of [true, false]) {
    assert.equal((await inspectWith(world({ ...base, record: rec(legacy) }).reads)).steps.record, false, "nothing stored");
    assert.equal((await inspectWith(world({ ...base, record: rec(legacy), stored: true }).reads)).steps.record, false, "no profile yet");
    assert.equal((await inspectWith(world({ ...base, record: rec(legacy), stored: true, profile: true }).reads)).steps.record, true);
  }
  const w = world({ ...base, record: rec(false), stored: true, profile: true });
  w.w.stored = { safeAddress: OTHER_ACCOUNT };
  assert.equal((await inspectWith(w.reads)).steps.record, false, "stored for a different address doesn't count");
});

test("a failed read stops everything: unknown is never 'not deployed' or 'not registered'", async () => {
  const { reads, run } = world();
  const broken: AccountReads = { ...reads, hasCode: async () => { throw new Error("rpc down"); } };
  await assert.rejects(finishWith(broken, run, () => false), /rpc down/);
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
