// ─── Policy — changing limits (no network) ───
// Run with `npm run test:limits`. ORC-69: tightening is instant; raising a limit needs proof
// (passkey, or a wallet signature when there is no passkey); a session alone can't loosen anything.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { softPasskey, TEST_RP as RP } from "../integrations/passkey/softPasskey";
import * as pk from "../integrations/passkey";
import { markEmailWallet, _resetEmailGate } from "../integrations/passkey/emailGate";
import { resolveDailyLimit, decide } from "./index";
import { parseChange, classifyChange, requestConfirmation, applyChange, readLimits, describeLoosening, _resetLimits, LimitsError } from "./limits";
import { writeUserProfile, readUserProfile, recordKnownRecipient, getKnownRecipients, getPolicyProfile, _resetPolicyStoreCache } from "./store";
import * as storage from "../integrations/zero-g/storage";

const FRIEND = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e instanceof LimitsError ? e.code ?? e.status : e.message; } return "no error"; };
const status = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.status; } return 0; };
const sign = (w: ethers.BaseWallet, td: any) => { const { EIP712Domain, ...types } = td.types; return w.signTypedData(td.domain, types, td.message); };

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const notices: string[] = [];
const notify = async (_w: string, text: string) => { notices.push(text); };
const setup = async (policy: Record<string, unknown> = {}) => {
  const owner = ethers.Wallet.createRandom();
  await writeUserProfile(owner.address, { policy });
  return owner;
};
const addPasskey = async (wallet: string) => {
  const key = softPasskey();
  const o = await pk.registrationOptions(wallet, RP);
  await pk.verifyRegistration(wallet, key.register(o.challenge), { rp: RP });
  return key;
};
const raise = (policy: Record<string, unknown>) => ({ policy });

test("validation: unknown fields, types and ranges are refused in plain words", async () => {
  for (const policy of [{ knownAddresses: [FRIEND] }, { verifiedTokens: [] }, { hardwareThresholdUsd: 5 }]) {
    assert.throws(() => parseChange({ policy }), /Only your daily limit/);
  }
  const refused = [{ dailyLimitUsd: 1001 }, { dailyLimitUsd: -1 }, { dailyLimitUsd: "5" }, { dailyLimitUsd: NaN }, { dailyLimitUsd: Infinity },
    { maxAutoTxPerDay: 1.5 }, { maxAutoTxPerDay: 101 }, { maxAutoTxPerDay: -1 }, { typicalMaxUsd: 0 }, { typicalMaxUsd: -3 }];
  for (const policy of refused) assert.throws(() => parseChange({ policy }), LimitsError, JSON.stringify(policy));
  assert.throws(() => parseChange({}), /nothing to change/);
  assert.throws(() => parseChange({ removeAddress: "vitalik.eth" }), /valid address/);
  assert.deepEqual(parseChange({ policy: { dailyLimitUsd: 0, maxAutoTxPerDay: null, typicalMaxUsd: 20 } }).set, { dailyLimitUsd: 0, maxAutoTxPerDay: null, typicalMaxUsd: 20 });
  assert.equal(parseChange({ policy: { dailyLimitUsd: 1000 } }).set.dailyLimitUsd, 1000);
});

test("classification: lowering is tightening; raising, clearing a cap or going above the $100 default is loosening", async () => {
  const c = (stored: any, set: any) => classifyChange(stored, { set });
  assert.equal(c({ dailyLimitUsd: 200 }, { dailyLimitUsd: 50 }), "tightening");
  assert.equal(c({ dailyLimitUsd: 200 }, { dailyLimitUsd: 0 }), "tightening");
  assert.equal(c({ dailyLimitUsd: 200 }, { dailyLimitUsd: 300 }), "loosening");
  assert.equal(c({}, { dailyLimitUsd: 500 }), "loosening", "unset means the $100 default");
  assert.equal(c({}, { dailyLimitUsd: 100 }), "tightening");
  assert.equal(c({ dailyLimitUsd: 50 }, { dailyLimitUsd: null }), "loosening", "clearing goes back up to $100");
  assert.equal(c({}, { maxAutoTxPerDay: 5 }), "tightening", "adding a cap");
  assert.equal(c({ maxAutoTxPerDay: 5 }, { maxAutoTxPerDay: 3 }), "tightening");
  assert.equal(c({ maxAutoTxPerDay: 5 }, { maxAutoTxPerDay: 9 }), "loosening");
  assert.equal(c({ maxAutoTxPerDay: 5 }, { maxAutoTxPerDay: null }), "loosening", "removing the cap");
  assert.equal(c({}, { typicalMaxUsd: 30 }), "tightening");
  assert.equal(c({ typicalMaxUsd: 30 }, { typicalMaxUsd: 90 }), "loosening");
  assert.equal(c({ typicalMaxUsd: 30 }, { typicalMaxUsd: null }), "loosening");
  assert.equal(c({ dailyLimitUsd: 50, maxAutoTxPerDay: 5 }, { dailyLimitUsd: 20, maxAutoTxPerDay: null }), "loosening", "one loosening part makes the whole change need proof");
  assert.equal(classifyChange({}, { set: {}, removeAddress: FRIEND.toLowerCase() }), "tightening");
});

test("a limit of 0 is honoured: every value-bearing action needs approval", async () => {
  assert.equal(resolveDailyLimit(0), 0);
  const d = decide({ intentType: "swap", valueUsd: 0.5, dailyLimitUsd: resolveDailyLimit(0), plan: { summary: "s", steps: [{ action: "swap", params: {} }] } });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
});

test("lowering and removing apply at once with the session alone; no Telegram notice", async () => {
  notices.length = 0;
  const w = await setup({ dailyLimitUsd: 200, maxAutoTxPerDay: 5 });
  await recordKnownRecipient(w.address, FRIEND);
  assert.deepEqual(await requestConfirmation(w.address, raise({ dailyLimitUsd: 50 }), RP), { required: false });
  const r = await applyChange(w.address, { policy: { dailyLimitUsd: 50, maxAutoTxPerDay: 2, typicalMaxUsd: 10 }, removeAddress: FRIEND }, RP, notify);
  assert.deepEqual(r.policy, { dailyLimitUsd: 50, maxAutoTxPerDay: 2, typicalMaxUsd: 10 });
  assert.deepEqual(r.knownRecipients, []);
  assert.equal(r.loosened, false);
  assert.deepEqual(notices, []);
  // …and the next send to the removed address asks again.
  _resetPolicyStoreCache();
  assert.deepEqual((await getPolicyProfile(w.address)).knownAddresses, []);
});

test("attack: a session alone can't raise the limit or remove the cap (403 confirmation_required, nothing changes)", async () => {
  const w = await setup({ dailyLimitUsd: 50, maxAutoTxPerDay: 3 });
  for (const policy of [{ dailyLimitUsd: 1000 }, { maxAutoTxPerDay: null }, { maxAutoTxPerDay: 50 }, { dailyLimitUsd: null }]) {
    assert.equal(await code(applyChange(w.address, { policy }, RP, notify)), "confirmation_required", JSON.stringify(policy));
  }
  assert.equal((await readLimits(w.address)).policy.dailyLimitUsd, 50);
  assert.equal((await readLimits(w.address)).policy.maxAutoTxPerDay, 3);
});

test("attack: POST /policy can't add an address, or write any other field", async () => {
  const w = await setup();
  await assert.rejects(applyChange(w.address, { policy: { knownAddresses: [FRIEND] } }, RP, notify), /Only your daily limit/);
  await applyChange(w.address, { policy: { dailyLimitUsd: 10 }, knownRecipients: [FRIEND], addAddress: FRIEND }, RP, notify);
  assert.deepEqual(await getKnownRecipients(w.address), [], "an extra top-level field adds nothing");
});

test("a wallet without a passkey raises a limit with an EIP-712 signature over the exact new values", async () => {
  notices.length = 0;
  const w = await setup({ dailyLimitUsd: 50 });
  const body = raise({ dailyLimitUsd: 500 });
  const c: any = await requestConfirmation(w.address, body, RP);
  assert.equal(c.method, "wallet");
  assert.equal(c.typedData.message.dailyLimit, "$500");
  assert.ok(Date.parse(c.typedData.message.expiresAt) - Date.now() <= 5 * 60_000 + 1000, "expires within 5 minutes");
  const signature = await sign(w, c.typedData);
  const r = await applyChange(w.address, { ...body, confirmation: { nonce: c.nonce, signature } }, RP, notify);
  assert.equal(r.loosened, true);
  assert.equal(r.policy.dailyLimitUsd, 500);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /\$50 → \$500/);
  assert.match(notices[0], /If this wasn't you, lower it in Orchestra \(Limits\)/);
});

test("attack: signature replay, other values, another wallet's signature, expiry and a failing Telegram are all handled", async () => {
  const w = await setup({ dailyLimitUsd: 50 });
  const body = raise({ dailyLimitUsd: 500 });
  const c: any = await requestConfirmation(w.address, body, RP);
  const good = await sign(w, c.typedData);
  // wrong values: signed for $500, submitted for $900
  assert.equal(await code(applyChange(w.address, { ...raise({ dailyLimitUsd: 900 }), confirmation: { nonce: c.nonce, signature: good } }, RP, notify)), "confirmation_required");
  // the nonce was spent by the failed try: even the right values can't reuse it
  assert.equal(await code(applyChange(w.address, { ...body, confirmation: { nonce: c.nonce, signature: good } }, RP, notify)), "confirmation_required");
  // wrong signer
  const c2: any = await requestConfirmation(w.address, body, RP);
  const stranger = ethers.Wallet.createRandom();
  assert.equal(await status(applyChange(w.address, { ...body, confirmation: { nonce: c2.nonce, signature: await sign(stranger, c2.typedData) } }, RP, notify)), 401);
  // signature for another wallet's request
  const other = await setup({ dailyLimitUsd: 50 });
  const c3: any = await requestConfirmation(other.address, body, RP);
  assert.equal(await code(applyChange(w.address, { ...body, confirmation: { nonce: c3.nonce, signature: await sign(other, c3.typedData) } }, RP, notify)), "confirmation_required");
  // expired
  const c4: any = await requestConfirmation(w.address, body, RP);
  assert.equal(await code(applyChange(w.address, { ...body, confirmation: { nonce: c4.nonce, signature: await sign(w, c4.typedData) } }, RP, notify, Date.now() + 6 * 60_000)), "confirmation_required");
  assert.equal((await readLimits(w.address)).policy.dailyLimitUsd, 50, "nothing was applied");
  // a Telegram that fails never blocks the change
  const c5: any = await requestConfirmation(w.address, body, RP);
  const r = await applyChange(w.address, { ...body, confirmation: { nonce: c5.nonce, signature: await sign(w, c5.typedData) } }, RP, async () => { throw new Error("telegram down"); });
  assert.equal(r.policy.dailyLimitUsd, 500);
});

test("with a passkey, raising takes a passkey assertion over the exact values; replay and other values are refused", async () => {
  notices.length = 0;
  const w = await setup({ maxAutoTxPerDay: 3 });
  const key = await addPasskey(w.address);
  const body = raise({ maxAutoTxPerDay: null });
  const c: any = await requestConfirmation(w.address, body, RP);
  assert.equal(c.method, "passkey");
  const assertion = key.assert(c.options.challenge);
  // wrong values
  assert.equal(await code(applyChange(w.address, { ...raise({ maxAutoTxPerDay: 50 }), confirmation: { nonce: c.nonce, response: assertion } }, RP, notify)), "confirmation_required");
  // fresh request, right values
  const c2: any = await requestConfirmation(w.address, body, RP);
  const a2 = key.assert(c2.options.challenge);
  const r = await applyChange(w.address, { ...body, confirmation: { nonce: c2.nonce, response: a2 } }, RP, notify);
  assert.equal(r.policy.maxAutoTxPerDay, undefined, "the cap is gone");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Automatic payments per day: 3 → no limit/);
  // replay of the same assertion/nonce, once the cap is back (so removing it is loosening again)
  await applyChange(w.address, raise({ maxAutoTxPerDay: 3 }), RP, notify);
  assert.equal(await code(applyChange(w.address, { ...body, confirmation: { nonce: c2.nonce, response: a2 } }, RP, notify)), "confirmation_required");
});

test("attack: a wallet signature is refused when the wallet has a passkey", async () => {
  const w = await setup({ dailyLimitUsd: 50 });
  const body = raise({ dailyLimitUsd: 500 });
  // A request made before the passkey existed, signed afterwards.
  const c: any = await requestConfirmation(w.address, body, RP);
  assert.equal(c.method, "wallet");
  await addPasskey(w.address);
  const signature = await sign(w, c.typedData);
  assert.equal(await code(applyChange(w.address, { ...body, confirmation: { nonce: c.nonce, signature } }, RP, notify)), "confirmation_required");
  assert.equal((await readLimits(w.address)).policy.dailyLimitUsd, 50);
  // …and without any proof the answer names the passkey
  await assert.rejects(applyChange(w.address, body, RP, notify), /passkey/);
});

test("attack: an assertion from another wallet's passkey is refused", async () => {
  const w = await setup({ dailyLimitUsd: 50 });
  await addPasskey(w.address);
  const attacker = await setup();
  const evilKey = await addPasskey(attacker.address);
  const body = raise({ dailyLimitUsd: 500 });
  const c: any = await requestConfirmation(w.address, body, RP);
  assert.notEqual(await code(applyChange(w.address, { ...body, confirmation: { nonce: c.nonce, response: evilKey.assert(c.options.challenge) } }, RP, notify)), "no error");
  assert.equal((await readLimits(w.address)).policy.dailyLimitUsd, 50);
});

test("an email wallet without a passkey can't raise limits (it can still lower them)", async () => {
  _resetEmailGate();
  const w = await setup({ dailyLimitUsd: 50 });
  await markEmailWallet(w.address, "did:privy:e1");
  assert.equal(await code(requestConfirmation(w.address, raise({ dailyLimitUsd: 500 }), RP)), "passkey_required");
  await assert.rejects(requestConfirmation(w.address, raise({ dailyLimitUsd: 500 }), RP), /Add a passkey first to raise your limits\./);
  assert.equal(await code(applyChange(w.address, raise({ dailyLimitUsd: 500 }), RP, notify)), "confirmation_required");
  const r = await applyChange(w.address, raise({ dailyLimitUsd: 10 }), RP, notify);
  assert.equal(r.policy.dailyLimitUsd, 10);
});

test("a legacy knownAddresses in the stored policy is dropped on the next save and never shown", async () => {
  const w = await setup({ dailyLimitUsd: 50, knownAddresses: [FRIEND], verifiedTokens: ["0x1"] });
  const r = await applyChange(w.address, raise({ dailyLimitUsd: 40 }), RP, notify);
  assert.deepEqual(r.policy, { dailyLimitUsd: 40 });
  assert.equal((await readUserProfile(w.address)).policy.knownAddresses, undefined);
});

test("the Telegram notice is plain words", async () => {
  const lines = describeLoosening({ dailyLimitUsd: 50, maxAutoTxPerDay: 3 }, { set: { dailyLimitUsd: 500, maxAutoTxPerDay: null, typicalMaxUsd: 20 } });
  assert.deepEqual(lines, ["Daily limit without asking: $50 → $500", "Automatic payments per day: 3 → no limit"]);
});

(async () => {
  console.log("limits");
  for (const [name, fn] of tests) {
    _resetLimits();
    _resetPolicyStoreCache();
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
