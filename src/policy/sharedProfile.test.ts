// ─── Policy — the old shared settings record is never used (no network) ───
// Run with `npm run test:shared-profile`. ORC-76: `user:profile` once held one user's settings for
// everyone. A wallet without its own settings gets the safe defaults ($100/day, nothing else), and
// nothing is ever copied from the shared record into a wallet's own.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { TEST_RP as RP } from "../integrations/passkey/softPasskey";
import { resolveDailyLimit, DEFAULT_DAILY_LIMIT } from "./index";
import { applyChange, readLimits, _resetLimits } from "./limits";
import { getPolicyProfile, getKnownRecipients, readUserProfile, recordKnownRecipient, removeKnownRecipient, _resetPolicyStoreCache } from "./store";
import { writeAccountRecord } from "../integrations/safe/accountRecord";
import userProfileProvider from "../agents/planner/providers/userProfileProvider";
import * as storage from "../integrations/zero-g/storage";

const FRIEND = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SAFE = "0x62E5AB8e1af31c40792627703654B135488505e7";
const AGENT = "0x00000000000000000000000000000000000000A9";

/** What the old shared record held: a high limit, other overrides, and a recipient list. */
const SHARED = {
  address: "0x00000000000000000000000000000000000000AA",
  safeAddress: "0x00000000000000000000000000000000000000BB",
  policy: { dailyLimitUsd: 1000, maxAutoTxPerDay: 50, typicalMaxUsd: 900 },
  knownRecipients: [FRIEND],
  riskTolerance: "aggressive",
  preferredTokens: ["DOGE"],
  createdAt: "2024-01-01T00:00:00.000Z",
};
const seedShared = async () => { await storage.clear(); await storage.write("user:profile", SHARED); _resetPolicyStoreCache(); _resetLimits(); };
const sharedUntouched = async () => assert.deepEqual(await storage.read("user:profile"), SHARED);
const fresh = () => ethers.Wallet.createRandom().address;

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("a fresh wallet gets the safe defaults even when the shared record holds a higher limit", async () => {
  await seedShared();
  const w = fresh();
  const profile = await getPolicyProfile(w);
  assert.equal(resolveDailyLimit(profile.dailyLimitUsd), DEFAULT_DAILY_LIMIT);
  assert.equal(DEFAULT_DAILY_LIMIT, 100);
  assert.deepEqual(profile.knownAddresses, [], "the shared recipients aren't known to this wallet");
  assert.equal(profile.maxAutoTxPerDay, undefined);
  assert.equal(profile.typicalMaxUsd, undefined);
  assert.deepEqual(await readUserProfile(w), {});
  assert.deepEqual(await readLimits(w), { policy: {}, knownRecipients: [], paused: false });
  await sharedUntouched();
});

test("saving your own limit copies nothing from the shared record", async () => {
  await seedShared();
  const w = fresh();
  await applyChange(w, { policy: { dailyLimitUsd: 50 } }, RP);
  const own = await readUserProfile(w);
  assert.deepEqual(own.policy, { dailyLimitUsd: 50 }, "no maxAutoTxPerDay / typicalMaxUsd from the shared record");
  for (const k of ["address", "safeAddress", "riskTolerance", "preferredTokens", "createdAt", "knownRecipients"]) assert.equal(own[k], undefined, k);
  await sharedUntouched();
});

test("recording or removing a recipient copies nothing from the shared record", async () => {
  await seedShared();
  const w = fresh();
  const other = "0x000000000000000000000000000000000000dEaD";
  await recordKnownRecipient(w, other);
  const own = await readUserProfile(w);
  assert.deepEqual(own.knownRecipients, [other.toLowerCase()]);
  assert.equal(own.policy, undefined);
  assert.deepEqual(await getKnownRecipients(w), [other.toLowerCase()], "the shared FRIEND isn't there");
  const w2 = fresh();
  assert.deepEqual(await removeKnownRecipient(w2, FRIEND), []);
  assert.equal((await readUserProfile(w2)).policy, undefined);
  await sharedUntouched();
});

test("the account-record setup step copies nothing from the shared record and stores no limit", async () => {
  await seedShared();
  const w = fresh();
  await writeAccountRecord({ user: w, safeAddress: SAFE, agent: AGENT, now: () => "2026-01-01T00:00:00.000Z" });
  const own = await readUserProfile(w);
  assert.equal(own.policy, undefined);
  assert.equal(own.knownRecipients, undefined);
  assert.equal(own.riskTolerance, "moderate", "the default, not the shared 'aggressive'");
  assert.deepEqual(own.preferredTokens, ["USDC", "WETH", "ETH"]);
  assert.equal(own.safeAddress, SAFE, "its own account, not the shared record's");
  assert.equal(own.createdAt, "2026-01-01T00:00:00.000Z");
  const record = (await storage.read(`safe:${w.toLowerCase()}`)) as any;
  assert.equal(record.safeAddress, SAFE);
  assert.equal("spendingLimitUSD" in record, false, "the daily limit lives only in the policy");
  assert.equal(resolveDailyLimit((await getPolicyProfile(w)).dailyLimitUsd), 100);
  assert.equal("autoApproveLimit" in (await readUserProfile(w)), false, "the unenforced field is not written");
  await sharedUntouched();
});

test("a wallet's own settings are kept when its account record is written", async () => {
  await seedShared();
  const w = fresh();
  await applyChange(w, { policy: { dailyLimitUsd: 20 } }, RP);
  await writeAccountRecord({ user: w, safeAddress: SAFE, agent: AGENT });
  assert.equal((await readUserProfile(w)).policy.dailyLimitUsd, 20);
});

test("the old planner's profile provider ignores the shared record", async () => {
  await seedShared();
  const profile = JSON.parse(await userProfileProvider.handler());
  assert.equal("autoApproveLimit" in profile, false, "the planner is told no limit; the policy decides");
  assert.equal(Object.keys(profile).some((k) => /limit/i.test(k)), false);
  assert.deepEqual(profile.knownAddresses, []);
  assert.equal(JSON.stringify(profile).includes("1000"), false);
  assert.equal(JSON.stringify(profile).includes("aggressive"), false);
});

(async () => {
  console.log("shared profile");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
