// ─── Safe — account detection is read-only (no network) ───
// Run with `npm run test:detect`. ORC-85: finding a deployed account never writes `safe:<wallet>`
// (that is the last setup step's job), never reads a limit from the registry, and an account that
// is deployed but not finished is detected yet not ready.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { detectWith, _resetDetectCache, type DetectReads } from "./detect";
import { inspectWith, finishWith, type AccountReads, type SetupRecord } from "./inspect";
import { OnboardingQueue, OnboardingLimiter, accountReady } from "./onboarding";
import { isSetupComplete, type SetupStep } from "./setupSteps";
import * as storage from "../zero-g/storage";

const POLICY = "0x315aa01bd89621275ef91198e7f86bc7e48eeb12";
const SAFE_A = "0x62E5AB8e1af31c40792627703654B135488505e7";
const SAFE_B = "0x00000000000000000000000000000000000000B2";

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

/** Detection reads over real (in-memory) storage and a counted fake chain. */
function detectWorld(init: { code?: string[] } = {}) {
  const calls = { predict: 0, hasCode: 0 };
  const code = new Set((init.code ?? []).map((a) => a.toLowerCase()));
  const reads: DetectReads = {
    storedAccount: async (w) => ((await storage.read(`safe:${w}`)) as any)?.safeAddress ?? null,
    predict: async () => { calls.predict++; return SAFE_A; },
    hasCode: async (a) => { calls.hasCode++; return code.has(a.toLowerCase()); },
  };
  return { reads, calls, code };
}

test("a deployed but unfinished account is detected without writing safe:<wallet>, and is not ready", async () => {
  await storage.clear();
  _resetDetectCache();
  const user = ethers.Wallet.createRandom().address;
  const { reads } = detectWorld({ code: [SAFE_A] });
  assert.equal(await detectWith(reads, user), SAFE_A);
  assert.equal(await storage.read(`safe:${user.toLowerCase()}`), null, "detection wrote nothing");

  // The same account, seen by the setup: deployed, not registered yet, nothing recorded.
  let record: SetupRecord | null = { safeAddress: SAFE_A, startedAt: "t" };
  const reads2: AccountReads = {
    safeAddress: SAFE_A, policyAddress: POLICY,
    setupRecord: async () => record, saveSetupRecord: async (r) => { record = r; },
    storedAccount: async () => (await storage.read(`safe:${user.toLowerCase()}`)) as any, profile: async () => null,
    hasCode: async () => true, registryIsCurrent: async () => true, registeredOnChain: async () => false, now: () => "t",
  };
  const queue = new OnboardingQueue({ inspect: () => inspectWith(reads2), finish: async () => {}, limiter: new OnboardingLimiter() });
  const status = await queue.status(user);
  assert.equal(status.status, "not_started");
  assert.equal(await accountReady(queue, user), false);
  assert.ok(!isSetupComplete((await inspectWith(reads2)).steps));
  assert.equal(await storage.read(`safe:${user.toLowerCase()}`), null, "still nothing recorded");
});

test("only the last setup step records the account; the record then makes it ready", async () => {
  await storage.clear();
  const user = ethers.Wallet.createRandom().address;
  const key = `safe:${user.toLowerCase()}`;
  const w = { registered: false, code: true };
  let record: SetupRecord | null = null;
  const reads: AccountReads = {
    safeAddress: SAFE_A, policyAddress: POLICY,
    setupRecord: async () => record, saveSetupRecord: async (r) => { record = r; },
    storedAccount: async () => (await storage.read(key)) as any,
    profile: async () => (await storage.read(key)) as any,
    hasCode: async () => w.code, registryIsCurrent: async () => true, registeredOnChain: async () => w.registered, now: () => "t",
  };
  const seenAtStep: Record<string, unknown> = {};
  const step = (name: SetupStep, fn: () => void) => async () => { seenAtStep[name] = await storage.read(key); fn(); };
  await finishWith(reads, {
    deploy: step("deploy", () => {}),
    register: step("register", () => { w.registered = true; }),
    record: async () => { seenAtStep.record = await storage.read(key); await storage.write(key, { safeAddress: SAFE_A }); },
  }, () => false);
  for (const s of ["register", "record"]) assert.equal(seenAtStep[s], null, `nothing recorded before/at '${s}'`);
  assert.deepEqual(await storage.read(key), { safeAddress: SAFE_A });
});

test("detection never reads the registry or writes storage", async () => {
  const src = fs.readFileSync(path.join(__dirname, "detect.ts"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
  assert.ok(!/ORCHESTRA_POLICY|getPolicy|hasPolicy|spendingLimit|policyContract/i.test(code), "no registry or limit in detect.ts");
  assert.ok(!/\bwrite\b|deleteKey/.test(code), "detect.ts doesn't write");
  assert.ok(!/import .*\bwrite\b/.test(code));
});

test("detection returns the stored account first; without code and without a record it finds nothing", async () => {
  await storage.clear();
  _resetDetectCache();
  const user = ethers.Wallet.createRandom().address;
  const { reads, calls } = detectWorld();
  assert.equal(await detectWith(reads, user), null, "no code, no record: a new user");
  await storage.write(`safe:${user.toLowerCase()}`, { safeAddress: SAFE_B });
  assert.equal(await detectWith(reads, user), SAFE_B);
  assert.equal(calls.predict, 1, "the stored record answered without a chain read");
});

test("a positive answer is remembered briefly; 'not found' is asked again", async () => {
  await storage.clear();
  _resetDetectCache();
  const user = ethers.Wallet.createRandom().address;
  const { reads, calls, code } = detectWorld();
  const t0 = 1_000_000;
  assert.equal(await detectWith(reads, user, t0), null);
  assert.equal(await detectWith(reads, user, t0 + 1), null);
  assert.equal(calls.predict, 2, "'not found' isn't remembered");
  code.add(SAFE_A.toLowerCase());
  assert.equal(await detectWith(reads, user, t0 + 2), SAFE_A, "a deployment is noticed at once");
  const before = calls.predict;
  assert.equal(await detectWith(reads, user, t0 + 1000), SAFE_A);
  assert.equal(calls.predict, before, "answered from memory");
  assert.equal(await detectWith(reads, user, t0 + 10 * 60_000), SAFE_A);
  assert.equal(calls.predict, before + 1, "asked again after the cache expired");
});

test("attack: account B never takes account A's address or limit through detection", async () => {
  await storage.clear();
  _resetDetectCache();
  const a = ethers.Wallet.createRandom().address;
  const b = ethers.Wallet.createRandom().address;
  await storage.write(`safe:${a.toLowerCase()}`, { safeAddress: SAFE_A, spendingLimitUSD: 900 });
  const { reads } = detectWorld({ code: [SAFE_B] });
  const reads2: DetectReads = { ...reads, predict: async () => SAFE_B };
  assert.equal(await detectWith(reads2, b), SAFE_B);
  assert.equal(await storage.read(`safe:${b.toLowerCase()}`), null, "no record, so no inherited limit");
  assert.equal(((await storage.read(`safe:${a.toLowerCase()}`)) as any).spendingLimitUSD, 900, "A's record is untouched");
});

(async () => {
  console.log("detect");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
