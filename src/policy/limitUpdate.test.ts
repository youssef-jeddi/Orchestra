// ─── Policy — changing the limit with the owner's on-chain transaction (no network) ───
// /prepare-limit-update and /finalize-limit-update (ORC-94, ORC-95): the limit is validated, the
// account must be fully set up, the enforced limit (policy.dailyLimitUsd) is what changes, a raise
// follows the same rules as POST /policy (passkey, notice), and a failed registry write behaves as
// agreed: a raise saves nothing and can be repeated; a lowering stays lowered.
// Run with `npm run test:limit-update`.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { softPasskey, TEST_RP as RP } from "../integrations/passkey/softPasskey";
import * as pk from "../integrations/passkey";
import { markEmailWallet, _resetEmailGate } from "../integrations/passkey/emailGate";
import { ACCOUNT_NOT_READY_REASON } from "../integrations/safe/onboarding";
import { LimitsError, _resetLimits } from "./limits";
import { prepareLimitUpdate, finalizeLimitUpdate, LIMIT_NOT_SAVED, REGISTRY_NOT_UPDATED, type LimitUpdateDeps } from "./limitUpdate";
import { writeUserProfile, readUserProfile, _resetPolicyStoreCache } from "./store";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { finishLimitUpdate, needsPasskey } from "../../frontend/src/lib/limitUpdate.js";

console.log = ((orig) => (...a: unknown[]) => { if (!/^\[(LocalStorage|Storage)\]/.test(String(a[0]))) orig(...a); })(console.log);
console.error = () => {};

const SAFE = "0x" + "5a".repeat(20);
let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

interface ChainTx { tx: any; receipt: any; minedAtMs: number | null }
function world() {
  const s = {
    ready: new Map<string, boolean>(),
    accounts: new Map<string, Record<string, any>>(),
    chain: new Map<string, ChainTx>(),
    used: new Set<string>(),
    registryCalls: [] as number[],
    registryFail: null as string | null,
    notices: [] as string[],
    fetched: 0,
  };
  const buildTx = (safe: string, _w: string, usd: number) => ({ to: safe, data: "0x" + usd.toString(16).padStart(8, "0"), value: "0x0", gasLimit: 1 });
  const deps: LimitUpdateDeps = {
    isReady: async (w) => s.ready.get(w.toLowerCase()) ?? false,
    account: async (w) => s.accounts.get(w.toLowerCase()) ?? null,
    saveAccount: async (w, rec) => { s.accounts.set(w.toLowerCase(), rec); },
    buildTx,
    fetchTx: async (h) => { s.fetched++; return s.chain.get(h) ?? { tx: null, receipt: null, minedAtMs: null }; },
    txUsed: async (h) => s.used.has(h),
    markTxUsed: async (h) => { s.used.add(h); },
    updateRegistry: async (_safe, usd) => {
      if (s.registryFail) throw new Error(s.registryFail);
      s.registryCalls.push(usd);
    },
    notify: async (_w, text) => { s.notices.push(text); },
    rp: RP,
  };
  /** The owner's tx for `limit` as the chain would show it. */
  const mine = (from: string, limit: number, o: { ageMs?: number; status?: number; data?: string; minedAtMs?: number | null } = {}) => {
    const hash = "0x" + crypto.randomBytes(32).toString("hex");
    s.chain.set(hash, {
      tx: { from, to: SAFE, data: o.data ?? buildTx(SAFE, from, limit).data },
      receipt: { status: o.status ?? 1 },
      minedAtMs: o.minedAtMs !== undefined ? o.minedAtMs : Date.now() - (o.ageMs ?? 0),
    });
    return hash;
  };
  return { s, deps, mine };
}
type World = ReturnType<typeof world>;

async function newUser(w: World, policy: Record<string, unknown> = { dailyLimitUsd: 100 }) {
  const user = ethers.Wallet.createRandom();
  await writeUserProfile(user.address, { policy });
  w.s.accounts.set(user.address.toLowerCase(), { safeAddress: SAFE, spendingLimitUSD: 100 });
  w.s.ready.set(user.address.toLowerCase(), true);
  return user;
}
const limitOf = async (user: { address: string }) => (await readUserProfile(user.address)).policy?.dailyLimitUsd;
const recordLimit = (w: World, user: { address: string }) => w.s.accounts.get(user.address.toLowerCase())!.spendingLimitUSD;
const addPasskey = async (wallet: string) => {
  const key = softPasskey();
  const o = await pk.registrationOptions(wallet, RP);
  await pk.verifyRegistration(wallet, key.register(o.challenge), { rp: RP });
  return key;
};
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e; } return null; };

test("attack: a limit that isn't a whole number from $0 to $1,000 is refused by both endpoints, before the chain is read", async () => {
  const w = world();
  const user = await newUser(w);
  const hash = w.mine(user.address, 500);
  for (const bad of [-1, 1001, 1e9, 12.5, 0.5, "500", "1e6", "", NaN, Infinity, null, undefined, true, {}, [500]]) {
    for (const call of [
      () => prepareLimitUpdate(user.address, { newLimitUSD: bad }, w.deps),
      () => finalizeLimitUpdate(user.address, { newLimitUSD: bad, txHash: hash }, w.deps),
    ]) {
      const e = await fails(call());
      assert.ok(e instanceof LimitsError && e.status === 400, `${JSON.stringify(bad)} → ${e?.message}`);
      assert.match(e.message, /whole number of dollars from \$0 to \$1,000/);
    }
  }
  assert.equal(w.s.fetched, 0);
  assert.equal(await limitOf(user), 100);
  assert.equal(recordLimit(w, user), 100);
  // The edges are fine.
  assert.ok((await prepareLimitUpdate(user.address, { newLimitUSD: 0 }, w.deps)).unsignedTx);
  assert.ok((await prepareLimitUpdate(user.address, { newLimitUSD: 1000 }, w.deps)).unsignedTx);
});

test("attack: finalize with a missing or malformed transaction hash is refused", async () => {
  const w = world();
  const user = await newUser(w);
  for (const txHash of [undefined, "", "0x12", 5, "0x" + "zz".repeat(32)]) {
    const e = await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 50, txHash }, w.deps));
    assert.ok(e instanceof LimitsError && e.status === 400, String(txHash));
  }
  assert.equal(await limitOf(user), 100);
});

test("attack: an account whose setup isn't finished (or doesn't exist) can't change its limit", async () => {
  const w = world();
  const user = await newUser(w);
  const hash = w.mine(user.address, 50);
  w.s.ready.set(user.address.toLowerCase(), false);
  for (const call of [
    () => prepareLimitUpdate(user.address, { newLimitUSD: 50 }, w.deps),
    () => finalizeLimitUpdate(user.address, { newLimitUSD: 50, txHash: hash }, w.deps),
  ]) {
    const e = await fails(call());
    assert.ok(e instanceof LimitsError && e.status === 409, e?.message);
    assert.equal(e.message, ACCOUNT_NOT_READY_REASON);
  }
  w.s.ready.set(user.address.toLowerCase(), true);
  w.s.accounts.delete(user.address.toLowerCase()); // ready by the chain, but no record of the account
  assert.equal((await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 50, txHash: hash }, w.deps)))?.status, 409);
  assert.equal(await limitOf(user), 100);
  assert.equal(w.s.fetched, 0, "nothing was read from the chain");
});

test("attack: another signed-in user can't use my transaction to change a limit (theirs or mine)", async () => {
  const w = world();
  const alice = await newUser(w, { dailyLimitUsd: 500 });
  const bob = await newUser(w, { dailyLimitUsd: 500 });
  const lowerByAlice = w.mine(alice.address, 5); // Alice really sent this
  const e = await fails(finalizeLimitUpdate(bob.address, { newLimitUSD: 5, txHash: lowerByAlice }, w.deps));
  assert.ok(e instanceof LimitsError && e.status === 400);
  assert.match(e.message, /wasn't sent by your wallet/);
  assert.equal(await limitOf(bob), 500);
  assert.equal(await limitOf(alice), 500, "Alice's limit isn't touched by a request in Bob's session either");
});

test("attack: a transaction that isn't mined, reverted, for another limit, or too old doesn't count", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 500 });
  const bad = {
    unmined: "0x" + "11".repeat(32),
    reverted: w.mine(user.address, 50, { status: 0 }),
    otherLimit: w.mine(user.address, 400),
    wrongData: w.mine(user.address, 50, { data: "0xdeadbeef" }),
    tooOld: w.mine(user.address, 50, { ageMs: 31 * 60_000 }),
    unknownAge: w.mine(user.address, 50, { minedAtMs: null }),
  };
  for (const [name, txHash] of Object.entries(bad)) {
    const e = await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 50, txHash }, w.deps));
    assert.ok(e instanceof LimitsError && e.status === 400, `${name}: ${e?.message}`);
  }
  assert.equal(await limitOf(user), 500);
  assert.equal(recordLimit(w, user), 100);
});

test("lowering changes the enforced limit at once (policy.dailyLimitUsd), the account record and the registry; no notice", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 500, maxAutoTxPerDay: 4 });
  const prepared = await prepareLimitUpdate(user.address, { newLimitUSD: 50 }, w.deps);
  assert.equal(prepared.confirmation, "none");
  assert.equal(prepared.unsignedTx.to, SAFE);
  const r = await finalizeLimitUpdate(user.address, { newLimitUSD: 50, txHash: w.mine(user.address, 50) }, w.deps);
  assert.deepEqual(r, { success: true, limitUsd: 50, raised: false });
  const profile = await readUserProfile(user.address);
  assert.equal(profile.policy.dailyLimitUsd, 50);
  assert.equal(profile.policy.maxAutoTxPerDay, 4, "other settings stay");
  assert.equal(profile.autoApproveLimit, undefined, "the unused field isn't written");
  assert.equal(recordLimit(w, user), 50);
  assert.deepEqual(w.s.registryCalls, [50]);
  assert.deepEqual(w.s.notices, []);
});

test("raising on a wallet without a passkey: the owner's transaction is the proof; saved, registry written, notice sent", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 50 });
  assert.equal((await prepareLimitUpdate(user.address, { newLimitUSD: 300 }, w.deps)).confirmation, "none");
  const hash = w.mine(user.address, 300);
  const r = await finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash }, w.deps);
  assert.deepEqual(r, { success: true, limitUsd: 300, raised: true });
  assert.equal(await limitOf(user), 300);
  assert.equal(recordLimit(w, user), 300);
  assert.deepEqual(w.s.registryCalls, [300]);
  assert.equal(w.s.notices.length, 1);
  assert.match(w.s.notices[0], /\$50 → \$300/);
});

test("attack: an old raise transaction can't be replayed to raise the limit again after it was lowered", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 50 });
  const raise = w.mine(user.address, 300);
  await finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: raise }, w.deps);
  await finalizeLimitUpdate(user.address, { newLimitUSD: 20, txHash: w.mine(user.address, 20) }, w.deps);
  const e = await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: raise }, w.deps));
  assert.ok(e instanceof LimitsError && e.status === 409, e?.message);
  assert.equal(await limitOf(user), 20);
});

test("raising on a wallet with a passkey: no assertion → confirmation_required with a challenge, nothing saved or written", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 50 });
  const key = await addPasskey(user.address);
  assert.equal((await prepareLimitUpdate(user.address, { newLimitUSD: 300 }, w.deps)).confirmation, "passkey");
  assert.equal((await prepareLimitUpdate(user.address, { newLimitUSD: 10 }, w.deps)).confirmation, "none", "lowering never needs it");
  const hash = w.mine(user.address, 300);
  const e = await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash }, w.deps));
  assert.ok(e instanceof LimitsError && e.status === 403 && e.code === "confirmation_required");
  assert.equal(e.extra.method, "passkey");
  assert.ok(typeof e.extra.nonce === "string" && (e.extra.options as any).challenge);
  assert.equal(await limitOf(user), 50);
  assert.equal(recordLimit(w, user), 100);
  assert.deepEqual(w.s.registryCalls, []);
  assert.deepEqual(w.s.notices, []);
  // Retry with the same transaction and the passkey's answer.
  const r = await finalizeLimitUpdate(user.address, {
    newLimitUSD: 300, txHash: hash, confirmation: { nonce: e.extra.nonce, response: key.assert((e.extra.options as any).challenge) },
  }, w.deps);
  assert.equal(r.raised, true);
  assert.equal(await limitOf(user), 300);
  assert.equal(w.s.notices.length, 1);
  assert.deepEqual(w.s.registryCalls, [300]);
});

test("attack: another wallet's passkey, a reused answer or an answer for other values can't raise a passkey wallet's limit", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 50 });
  await addPasskey(user.address);
  const attacker = await newUser(w);
  const evil = await addPasskey(attacker.address);
  const hash = w.mine(user.address, 300);
  const e = (await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash }, w.deps)))!;
  const forged = { nonce: e.extra.nonce, response: evil.assert((e.extra.options as any).challenge) };
  const refused = await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash, confirmation: forged }, w.deps));
  assert.ok(refused, "an assertion from another wallet's passkey is refused");
  // Garbage or a missing nonce: still no.
  assert.ok(await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash, confirmation: { nonce: "nope", response: {} } }, w.deps)));
  assert.equal(await limitOf(user), 50);
  assert.deepEqual(w.s.registryCalls, []);
  assert.deepEqual(w.s.notices, []);
});

test("an email wallet without a passkey can't raise (told before it sends the transaction); it can lower", async () => {
  _resetEmailGate();
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 50 });
  await markEmailWallet(user.address, "did:privy:e-limit");
  const e = await fails(prepareLimitUpdate(user.address, { newLimitUSD: 300 }, w.deps));
  assert.ok(e instanceof LimitsError && e.status === 403 && e.code === "passkey_required");
  assert.equal((await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: w.mine(user.address, 300) }, w.deps)))?.code, "passkey_required");
  assert.equal(await limitOf(user), 50);
  const r = await finalizeLimitUpdate(user.address, { newLimitUSD: 10, txHash: w.mine(user.address, 10) }, w.deps);
  assert.equal(r.limitUsd, 10);
});

test("registry write fails on a raise: nothing is saved (no notice, tx not used), and the same transaction works once it's fixed", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 50 });
  const hash = w.mine(user.address, 300);
  w.s.registryFail = "RPC https://sepolia.example/key=SECRET-API-KEY refused";
  const e = await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash }, w.deps));
  assert.ok(e instanceof LimitsError && e.status === 503 && e.code === "limit_not_saved");
  assert.equal(e.message, LIMIT_NOT_SAVED);
  assert.ok(!e.message.includes("SECRET-API-KEY"));
  assert.equal(await limitOf(user), 50);
  assert.equal(recordLimit(w, user), 100);
  assert.deepEqual(w.s.notices, []);
  assert.equal(w.s.used.size, 0);
  w.s.registryFail = null;
  const r = await finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash }, w.deps);
  assert.equal(r.raised, true);
  assert.equal(await limitOf(user), 300);
  assert.deepEqual(w.s.registryCalls, [300]);
  // Repeating the finished call changes nothing and doesn't notify twice.
  const again = await finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash }, w.deps);
  assert.equal(again.limitUsd, 300);
  assert.equal(w.s.notices.length, 1);
});

test("registry write fails on a raise by a passkey wallet: nothing saved; the retry asks for the passkey again and then works", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 50 });
  const key = await addPasskey(user.address);
  const hash = w.mine(user.address, 300);
  const ask = async () => (await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash }, w.deps)))!;
  const answer = (e: LimitsError) => ({ nonce: e.extra.nonce, response: key.assert((e.extra.options as any).challenge) });
  w.s.registryFail = "boom";
  const first = await ask();
  const failed = await fails(finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash, confirmation: answer(first) }, w.deps));
  assert.equal((failed as LimitsError).code, "limit_not_saved");
  assert.equal(await limitOf(user), 50);
  w.s.registryFail = null;
  const second = await ask();
  assert.equal(second.code, "confirmation_required");
  const r = await finalizeLimitUpdate(user.address, { newLimitUSD: 300, txHash: hash, confirmation: answer(second) }, w.deps);
  assert.equal(r.raised, true);
  assert.equal(await limitOf(user), 300);
});

test("registry write fails on a lowering: the lower limit is kept and the answer says so", async () => {
  const w = world();
  const user = await newUser(w, { dailyLimitUsd: 500 });
  w.s.registryFail = "boom with a secret";
  const r = await finalizeLimitUpdate(user.address, { newLimitUSD: 40, txHash: w.mine(user.address, 40) }, w.deps);
  assert.equal(r.success, true);
  assert.equal(r.raised, false);
  assert.equal(r.notice, REGISTRY_NOT_UPDATED);
  assert.ok(!JSON.stringify(r).includes("secret"));
  assert.equal(await limitOf(user), 40);
  assert.equal(recordLimit(w, user), 40);
});

test("page: a raise answers the passkey challenge and repeats the call with the same transaction; other errors pass through", async () => {
  const ask = Object.assign(new Error("Confirm with your passkey to raise your limit."), { code: "confirmation_required", data: { method: "passkey", nonce: "n1", options: { challenge: "c1" } } });
  const calls: any[][] = [];
  const finalize = async (...args: any[]) => { calls.push(args); if (calls.length === 1) throw ask; return { limitUsd: 300, raised: true }; };
  const r = await finishLimitUpdate(300, "0xabc", "0xhash", { finalize, authenticate: async ({ optionsJSON }: any) => ({ answered: optionsJSON.challenge }) } as any);
  assert.equal(r.raised, true);
  assert.deepEqual(calls[1], [300, "0xabc", "0xhash", { nonce: "n1", response: { answered: "c1" } }]);
  assert.equal(needsPasskey(ask), true);
  assert.equal(needsPasskey(Object.assign(new Error("x"), { code: "limit_not_saved" })), false);
  // A different failure is not retried; a cancelled prompt rejects so the page can say what to do.
  const boom = new Error("Limit not updated: it wasn't sent by your wallet.");
  await assert.rejects(finishLimitUpdate(300, "0xabc", "0xhash", { finalize: async () => { throw boom; }, authenticate: async () => ({}) } as any), /wasn't sent by your wallet/);
  const cancel = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
  await assert.rejects(finishLimitUpdate(300, "0xabc", "0xhash", { finalize: async () => { throw ask; }, authenticate: async () => { throw cancel; } } as any), /cancelled/);
});

test("the messages are plain: no jargon, codes or internals", async () => {
  for (const m of [LIMIT_NOT_SAVED, REGISTRY_NOT_UPDATED, ACCOUNT_NOT_READY_REASON]) {
    assert.ok(!/GS0|revert|nonce|gas|rpc|undefined|error:|0x/i.test(m), m);
  }
});

(async () => {
  console.log("limit update");
  for (const [name, fn] of tests) {
    _resetLimits();
    _resetPolicyStoreCache();
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  }
  process.stdout.write(`\n${passed} passed\n`);
})().catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
