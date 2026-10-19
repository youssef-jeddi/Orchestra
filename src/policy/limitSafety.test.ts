// ─── Policy — a storage error is not "no settings" (ORC-93, ORC-99) ───
// An unreadable profile used to mean "defaults" (a lowered $20 limit became $100) and the next save
// wrote the empty profile back; an unreadable history meant "$0 spent today". Both now fail the
// request: nothing runs, nothing is saved. Faults are injected with ORCHESTRA_FAULT_INJECT, which is
// inert in production. Run with `npm run test:limit-safety`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { spawnSync } from "node:child_process";
import { decide, parseWholeDollarLimit, resolveDailyLimit, MAX_DAILY_LIMIT } from "./index";
import { applyChange, dailyLimitFor, readLimits, requestConfirmation, _resetLimits } from "./limits";
import {
  readUserProfile, writeUserProfile, updateUserProfile, recordKnownRecipient, getKnownRecipients, getPolicyProfile,
  getRecentActivity, recordActivity, readPolicyInputs, _resetPolicyStoreCache,
} from "./store";
import { LocalStorage } from "../integrations/zero-g/memoryStorage";
import { TEST_RP as RP } from "../integrations/passkey/softPasskey";
import { faultOn, faultInjectProblem } from "../utils/faultInject";
import { interpretIntent } from "../intent/pipeline";
import { LIMITS_UNREADABLE_REASON } from "../intent/messages";

console.log = ((orig) => (...a: unknown[]) => { if (!/^\[(LocalStorage|Storage|policy)\]/.test(String(a[0]))) orig(...a); })(console.log);
console.error = () => {};

const FRIEND = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const withFault = async <T>(fault: string, fn: () => Promise<T>): Promise<T> => {
  process.env.ORCHESTRA_FAULT_INJECT = fault;
  try { return await fn(); } finally { delete process.env.ORCHESTRA_FAULT_INJECT; }
};
const seed = async () => {
  const w = ethers.Wallet.createRandom().address;
  await writeUserProfile(w, { policy: { dailyLimitUsd: 20, maxAutoTxPerDay: 3 }, knownRecipients: [FRIEND.toLowerCase()] });
  _resetPolicyStoreCache();
  return w;
};
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return String(e.message); } return null; };

test("storage: a key never written reads as null (no profile yet → defaults), not as an error", async () => {
  assert.equal(await new LocalStorage(null).read("nothing"), null);
  assert.deepEqual(await readUserProfile(ethers.Wallet.createRandom().address), {});
});

test("attack: a profile that can't be read fails every reader and saves nothing — limits and recipients stay", async () => {
  const w = await seed();
  await withFault("profile-read", async () => {
    assert.match((await rejects(readUserProfile(w)))!, /injected fault/);
    assert.match((await rejects(getPolicyProfile(w)))!, /injected fault/);
    assert.match((await rejects(getKnownRecipients(w)))!, /injected fault/);
    assert.match((await rejects(readLimits(w)))!, /injected fault/, "no empty sheet shown as if real");
    assert.ok(await rejects(updateUserProfile(w, (p) => ({ ...p, touched: true }))), "no save after a failed read");
    assert.ok(await rejects(recordKnownRecipient(w, "0x" + "ab".repeat(20))));
    assert.ok(await rejects(applyChange(w, { policy: { dailyLimitUsd: 5 } }, RP)));
    assert.ok(await rejects(requestConfirmation(w, { policy: { dailyLimitUsd: 900 } }, RP)));
  });
  const after = await readUserProfile(w);
  assert.deepEqual(after.policy, { dailyLimitUsd: 20, maxAutoTxPerDay: 3 }, "limits unchanged");
  assert.deepEqual(after.knownRecipients, [FRIEND.toLowerCase()], "recipients unchanged");
  assert.equal(after.touched, undefined);
});

test("attack: an unreadable profile never becomes the $100 default — /intent's inputs say 'not ok'", async () => {
  const w = await seed();
  const failed = await withFault("profile-read", () => readPolicyInputs(w));
  assert.deepEqual(failed, { ok: false });
  const ok = await readPolicyInputs(w);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.profile.dailyLimitUsd, 20, "with a readable profile the lowered limit applies");
});

test("the wallet's stored daily limit is the only limit: a send over it asks, one under it doesn't", async () => {
  const w = await seed(); // $20 a day
  const inputs = await readPolicyInputs(w);
  assert.ok(inputs.ok);
  if (!inputs.ok) return;
  const plan = { summary: "Send USDC", steps: [{ action: "send", params: { to: FRIEND } }] };
  const run = (valueUsd: number) => decide({ intentType: "send", valueUsd, dailyLimitUsd: resolveDailyLimit(inputs.profile.dailyLimitUsd), plan, profile: { knownAddresses: [FRIEND] }, history: [] }).verdict;
  assert.equal(run(50), "NEEDS_APPROVAL");
  assert.equal(run(10), "AUTO_EXECUTE");
});

test("the limit shown for an account is the policy's: a change to $30 shows as 30, an unreadable profile gives null", async () => {
  const w = ethers.Wallet.createRandom().address;
  assert.equal(await dailyLimitFor(w), 100, "no saved limit: the default");
  await applyChange(w, { policy: { dailyLimitUsd: 30 } }, RP);
  assert.equal(await dailyLimitFor(w), 30);
  assert.equal(await withFault("profile-read", () => dailyLimitFor(w)), null);
});

test("attack: a profile read that hangs hits the timeout and is 'not ok', not an empty profile", async () => {
  const w = await seed();
  const t0 = Date.now();
  const r = await withFault("profile-timeout", () => readPolicyInputs(w, 80));
  assert.deepEqual(r, { ok: false });
  assert.ok(Date.now() - t0 < 2000);
});

test("attack: an unreadable history is 'not ok' (it must not read as $0 spent today), for an error and for a timeout", async () => {
  const w = await seed();
  assert.deepEqual(await withFault("activity-read", () => readPolicyInputs(w)), { ok: false });
  assert.deepEqual(await withFault("activity-timeout", () => readPolicyInputs(w, 80)), { ok: false });
});

test("why it matters: $90 already spent, a $50 send is held — but with an empty history it would auto-run", async () => {
  const plan = { summary: "Send 50 USDC", steps: [{ action: "send", params: { to: FRIEND } }] };
  const base = { intentType: "send" as const, valueUsd: 50, dailyLimitUsd: 100, plan, profile: { knownAddresses: [FRIEND] } };
  const today = new Date().toISOString();
  assert.equal(decide({ ...base, history: [{ valueUsd: 90, at: today }] }).verdict, "NEEDS_APPROVAL");
  assert.equal(decide({ ...base, history: [] }).verdict, "AUTO_EXECUTE", "the fail-open this change removes");
});

test("a failed history load is not cached as empty: the next load returns the real rows", async () => {
  const w = ethers.Wallet.createRandom().address;
  await recordActivity(w, { valueUsd: 90, at: new Date().toISOString() });
  _resetPolicyStoreCache(); // a restart: the in-memory copy is gone, the stored rows stay
  assert.ok(await withFault("activity-read", () => rejects(getRecentActivity(w))), "the load failed");
  const rows = await getRecentActivity(w);
  assert.equal(rows.length, 1, "not cached as []");
  assert.equal(rows[0].valueUsd, 90);
});

test("a spend recorded while the history can't be read still counts afterwards, once", async () => {
  const w = ethers.Wallet.createRandom().address;
  const at = new Date().toISOString();
  await withFault("activity-read", () => recordActivity(w, { valueUsd: 40, at }));
  const rows = await getRecentActivity(w);
  assert.equal(rows.filter((r) => r.valueUsd === 40).length, 1);
});

test("ordering: with the limits unreadable, a send gets the limits answer even though the balance check would refuse it", async () => {
  const ok = (text: string) => ({ text, provider: "groq", model: "m", latencyMs: 1, waitedMs: 0 });
  const send = JSON.stringify({ type: "actions", steps: [{ action: "send", token: "USDC", amount: "5", unit: "token", to: FRIEND }] });
  const chat = JSON.stringify({ type: "reply", text: "Hi" });
  const empty = { eth: 0, usdc: 0, weth: 0 } as any;
  const ctx = (readable: boolean) => ({ connected: true, getBalances: async () => empty, resolveEns: async () => null, valueGate: async () => (readable ? null : LIMITS_UNREADABLE_REASON) });
  const run = (text: string, readable: boolean) => interpretIntent("x", [], ctx(readable), { provider: "groq", model: "m", log: () => {}, completeFn: async () => ok(text) as any });
  const blocked = await run(send, false);
  assert.deepEqual(blocked.outcome, { kind: "unsupported", reason: LIMITS_UNREADABLE_REASON });
  const readable = await run(send, true);
  assert.equal(readable.outcome.kind, "unsupported");
  assert.match((readable.outcome as any).reason, /Not enough USDC/, "with readable limits the balance answer comes as before");
  assert.equal((await run(chat, false)).outcome.kind, "reply", "chat doesn't depend on the limits");
});

test("the limit validator: whole dollars from 0 to the maximum, nothing else", async () => {
  for (const ok of [0, 1, 100, MAX_DAILY_LIMIT]) assert.equal(parseWholeDollarLimit(ok), ok);
  for (const bad of [-1, MAX_DAILY_LIMIT + 1, 1e9, 12.5, 0.1, NaN, Infinity, "100", "1e6", "", null, undefined, true, [100], {}]) {
    assert.equal(parseWholeDollarLimit(bad), null, String(JSON.stringify(bad)));
  }
});

test("fault injection is inert in production and on 0G storage, and the bridge refuses to start with it in production", async () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
  assert.equal(faultOn("profile-read", env({ ORCHESTRA_FAULT_INJECT: "profile-read", STORAGE_BACKEND: "memory" })), true);
  assert.equal(faultOn("profile-read", env({ ORCHESTRA_FAULT_INJECT: "profile-read" })), true, "local file storage is the default");
  assert.equal(faultOn("profile-read", env({ ORCHESTRA_FAULT_INJECT: "profile-read", NODE_ENV: "production" })), false);
  assert.equal(faultOn("profile-read", env({ ORCHESTRA_FAULT_INJECT: "profile-read", STORAGE_BACKEND: "0g" })), false);
  assert.equal(faultOn("activity-read", env({ ORCHESTRA_FAULT_INJECT: "profile-read" })), false, "only what was asked for");
  assert.equal(faultOn("profile-read", env({})), false);
  assert.match(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "profile-read", NODE_ENV: "production" }))!, /production/);
  assert.equal(faultInjectProblem(env({ NODE_ENV: "production" })), null);
  assert.match(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "typo" }))!, /unknown/);
  // The real bridge: exits with 1 and a clear error before it listens.
  const run = spawnSync(process.execPath, ["--import", "tsx", "src/integrations/ledger/serve.ts"], {
    env: { ...process.env, NODE_ENV: "production", ORCHESTRA_FAULT_INJECT: "profile-read", STORAGE_BACKEND: "memory", PORT: "0" },
    encoding: "utf-8", timeout: 60_000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ORCHESTRA_FAULT_INJECT is set while NODE_ENV=production/);
});

(async () => {
  console.log("limit safety");
  for (const [name, fn] of tests) {
    _resetLimits();
    _resetPolicyStoreCache();
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  }
  process.stdout.write(`\n${passed} passed\n`);
})().catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
