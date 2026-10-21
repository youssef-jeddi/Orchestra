// ─── Safe — on-chain cap tests (no network: the module, the owner path and the chain are injected) ───
// Run with `npm run test:spending-module`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { isSpendingModuleEnabled, exceedsRemaining, remainingToday, DailyCapRevert, OVER_CAP_TEXT, OVER_CAP_NO_OWNER_TEXT, spendingModuleAddress, ModuleConfigError } from "./spendingModule";
import { executeForAccount, type AccountExecDeps, type AccountExecInput } from "./accountExec";
import { getRecentActivity, _resetPolicyStoreCache } from "../../policy/store";
import { holdOwnerSign, submitOwnerSignature, getOwnerSign, ownerSignView, safeTxHashOf, clearOwnerSignRecords, SAFE_TX_TYPES, OWNER_SIGN_TTL_MS } from "./ownerSign";
import { registerSafeArgs, REGISTERED_SPENDING_LIMIT } from "./policyContract";
import { errorResponse } from "../ledger/errors";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { userMaySign } from "../../../frontend/src/lib/emailPasskey.js";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { errorMessage } from "../../../frontend/src/lib/ownerSign.js";
import { OverCapError, UserFacingError } from "../../utils/userFacing";
import { faultOn, faultInjectProblem } from "../../utils/faultInject";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const SAFE = "0x00000000000000000000000000000000000000d4";
const KEY = "0x" + "11".repeat(32);
const owner = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();
const batch = [{ to: "0x00000000000000000000000000000000000000e5", value: "1", data: "0x" }];

/** Fake deps recording which path ran; `remaining` is the module's remainingToday in cents. */
function fake(over: Partial<AccountExecDeps> & { remaining?: bigint } = {}) {
  const calls: string[] = [];
  const deps: AccountExecDeps = {
    enabled: () => true,
    remainingCents: async () => over.remaining ?? 100_000n,
    viaModule: async () => { calls.push("module"); return "0xmodule"; },
    viaOwner: async () => { calls.push("owner"); return "0xowner"; },
    offer: async (wallet, safe, summary) => { calls.push("offer"); return { kind: "safe-owner", id: "x", wallet, safe, summary }; },
    ...over,
  };
  return { deps, calls };
}
const input = (valueUsd: number, extra: Partial<AccountExecInput> = {}): AccountExecInput =>
  ({ safeAddress: SAFE, agentKey: KEY, batch, valueUsd, wallet: owner.address, summary: "Send 1500 USDC", ...extra });

test("SPENDING_MODULE_ADDRESS is read trimmed and must be a real address", () => {
  const before = process.env.SPENDING_MODULE_ADDRESS;
  try {
    delete process.env.SPENDING_MODULE_ADDRESS;
    assert.equal(isSpendingModuleEnabled(), false);
    process.env.SPENDING_MODULE_ADDRESS = "  0x00000000000000000000000000000000000000c3\n";
    assert.equal(isSpendingModuleEnabled(), true);
    // A malformed value never means "off" (that was the agent-as-owner fallback): it's on, and refuses.
    process.env.SPENDING_MODULE_ADDRESS = "0xnope";
    assert.equal(isSpendingModuleEnabled(), true);
    assert.throws(() => spendingModuleAddress(), (e: any) => e instanceof ModuleConfigError && e.status === 503);
  } finally {
    if (before === undefined) delete process.env.SPENDING_MODULE_ADDRESS; else process.env.SPENDING_MODULE_ADDRESS = before;
  }
});

test("registerSafe is always written with a 0 limit", () => {
  assert.equal(REGISTERED_SPENDING_LIMIT, 0);
  assert.deepEqual(registerSafeArgs(SAFE, owner.address), [SAFE, owner.address, 0]);
});

test("exceedsRemaining: within, at the edge, over, and unreadable amounts failing closed", () => {
  assert.equal(exceedsRemaining(500, 100_000n), false);
  assert.equal(exceedsRemaining(1000, 100_000n), false);
  assert.equal(exceedsRemaining(1000.01, 100_000n), false, "inside the 1% estimate tolerance");
  assert.equal(exceedsRemaining(1100, 100_000n), true);
  assert.equal(exceedsRemaining(10, 0n), true, "nothing left today");
  assert.equal(exceedsRemaining(NaN, 100_000n), true);
  assert.equal(exceedsRemaining(-1, 100_000n), true);
});

test("module not set: the owner path runs, the module and its cap check are never touched", async () => {
  let read = 0;
  const { deps, calls } = fake({ enabled: () => false, remainingCents: async () => { read++; return 0n; } });
  assert.equal(await executeForAccount(input(5000), deps), "0xowner");
  assert.deepEqual(calls, ["owner"]);
  assert.equal(read, 0);
});

test("module set: a batch within the ceiling goes through the module, not the owner path", async () => {
  const { deps, calls } = fake({ remaining: 60_000n });
  assert.equal(await executeForAccount(input(250), deps), "0xmodule");
  assert.deepEqual(calls, ["module"]);
});

test("attack: a plan over what's left today never reaches the module, even when the server's own limit would allow it", async () => {
  // The server-side daily limit is not consulted here at all (it could be set to anything); the
  // on-chain remaining figure alone refuses.
  const { deps, calls } = fake({ remaining: 20_000n });
  await assert.rejects(executeForAccount(input(1500), deps), (e: any) => {
    assert.ok(e instanceof OverCapError);
    assert.equal(e.code, "over_daily_cap");
    assert.equal(e.message, OVER_CAP_TEXT);
    assert.ok(e.ownerSign, "the owner is offered to sign it");
    return true;
  });
  assert.ok(!calls.includes("module"), "the module is not called");
  assert.ok(!calls.includes("owner"), "and the agent doesn't fall back to the owner path");
});

test("attack: an exhausted ceiling refuses even a tiny plan", async () => {
  const { deps, calls } = fake({ remaining: 0n });
  await assert.rejects(executeForAccount(input(1), deps), OverCapError);
  assert.ok(!calls.includes("module"));
});

test("over the ceiling with no wallet to sign: a plain refusal, no offer", async () => {
  const { deps, calls } = fake({ remaining: 0n });
  await assert.rejects(executeForAccount(input(50, { wallet: undefined }), deps), (e: any) => {
    assert.equal(e.message, OVER_CAP_NO_OWNER_TEXT);
    assert.equal(e.ownerSign, undefined);
    return true;
  });
  assert.ok(!calls.includes("offer"));
});

test("an offer that can't be built still refuses with a plain sentence (never silent)", async () => {
  const { deps } = fake({ remaining: 0n, offer: async () => null });
  await assert.rejects(executeForAccount(input(50), deps), (e: any) => e instanceof OverCapError && e.message === OVER_CAP_NO_OWNER_TEXT);
});

test("the contract's DailyLimitExceeded revert (spend higher than estimated) becomes the same over-ceiling answer", async () => {
  const { deps, calls } = fake({ remaining: 100_000n, viaModule: async () => { throw new DailyCapRevert("DailyLimitExceeded"); } });
  await assert.rejects(executeForAccount(input(10), deps), (e: any) => e instanceof OverCapError && !!e.ownerSign);
  assert.ok(calls.includes("offer"));
});

test("other module failures keep their own message and aren't turned into an over-ceiling offer", async () => {
  const { deps, calls } = fake({ viaModule: async () => { throw new UserFacingError("This didn't go through"); } });
  await assert.rejects(executeForAccount(input(10), deps), /didn't go through/);
  assert.ok(!calls.includes("offer"));
});

test("an unreadable ceiling fails closed: nothing is sent", async () => {
  const { deps, calls } = fake({ remainingCents: async () => { throw new Error("rpc down https://secret.example/key"); } });
  await assert.rejects(executeForAccount(input(10), deps), (e: any) => e instanceof UserFacingError && !/secret/.test(e.message));
  assert.deepEqual(calls, []);
});

test("the over-ceiling answer carries its code and the offer to the frontend, and nothing else", () => {
  const e = new OverCapError(OVER_CAP_TEXT, { kind: "safe-owner", id: "abc" });
  const { status, body } = errorResponse(e);
  assert.equal(status, 409);
  assert.deepEqual(body, { error: OVER_CAP_TEXT, code: "over_daily_cap", ownerSign: { kind: "safe-owner", id: "abc" } });
  assert.deepEqual(errorResponse(new OverCapError(OVER_CAP_NO_OWNER_TEXT)).body, { error: OVER_CAP_NO_OWNER_TEXT, code: "over_daily_cap" });
});

// ─── The owner signs what the server holds ───

const call = { to: "0x00000000000000000000000000000000000000e5", value: "1000", data: "0x1234", operation: 0, nonce: 7 };
const hold = (now?: number) => holdOwnerSign({ wallet: owner.address, safeAddress: SAFE, summary: "Send 1500 USDC", call }, now);
const sign = (w: ethers.HDNodeWallet | ethers.Wallet, r: ReturnType<typeof hold>) => w.signTypedData(r.domain, SAFE_TX_TYPES, r.message);
const relayOk = (sent: string[]) => ({ relay: async (r: { id: string }) => { sent.push(r.id); return "0xabc"; } });

test("the offer is the stored Safe transaction and its EIP-712 hash — the wallet can sign it as is", () => {
  clearOwnerSignRecords();
  const r = hold();
  const view = ownerSignView(r);
  assert.equal(view.kind, "safe-owner");
  assert.equal(view.safeTxHash, safeTxHashOf(r.domain, r.message));
  assert.equal(view.typedData.primaryType, "SafeTx");
  assert.equal(view.typedData.message.nonce, 7);
  assert.equal(view.typedData.message.to, call.to);
  assert.equal(view.typedData.domain.chainId, 11155111);
});

test("the owner's signature over the held hash is relayed once, and the relay is handed the stored transaction", async () => {
  clearOwnerSignRecords();
  const r = hold();
  const sent: string[] = [];
  const out = await submitOwnerSignature(owner.address, r.id, await sign(owner, r), relayOk(sent));
  assert.equal(out.txHash, "0xabc");
  assert.deepEqual(sent, [r.id]);
  await assert.rejects(submitOwnerSignature(owner.address, r.id, await sign(owner, r), relayOk(sent)), /already sent/);
  assert.equal(sent.length, 1);
});

test("attack: a signature from another wallet is refused, nothing is relayed", async () => {
  clearOwnerSignRecords();
  const r = hold();
  const sent: string[] = [];
  await assert.rejects(submitOwnerSignature(owner.address, r.id, await sign(stranger, r), relayOk(sent)), /isn't from your wallet/);
  assert.deepEqual(sent, []);
});

test("attack: a signature over a different transaction is refused (the client can't swap what is executed)", async () => {
  clearOwnerSignRecords();
  const r = hold();
  const other = { ...r.message, to: stranger.address, value: "999999" };
  const sig = await owner.signTypedData(r.domain, SAFE_TX_TYPES, other);
  const sent: string[] = [];
  await assert.rejects(submitOwnerSignature(owner.address, r.id, sig, relayOk(sent)), /isn't from your wallet/);
  assert.deepEqual(sent, []);
});

test("attack: another signed-in wallet can't submit someone else's held transaction", async () => {
  clearOwnerSignRecords();
  const r = hold();
  const sent: string[] = [];
  await assert.rejects(submitOwnerSignature(stranger.address, r.id, await sign(owner, r), relayOk(sent)), /couldn't find/);
  assert.deepEqual(sent, []);
});

test("an expired or unknown request, and a malformed signature, are refused with plain sentences", async () => {
  clearOwnerSignRecords();
  const t0 = 1_000_000;
  const r = hold(t0);
  const sig = await sign(owner, r);
  const sent: string[] = [];
  await assert.rejects(submitOwnerSignature(owner.address, r.id, sig, { ...relayOk(sent), now: () => t0 + OWNER_SIGN_TTL_MS + 1 }), /expired/);
  await assert.rejects(submitOwnerSignature(owner.address, "nope", sig, relayOk(sent)), /couldn't find/);
  const fresh = hold();
  await assert.rejects(submitOwnerSignature(owner.address, fresh.id, "0x1234", relayOk(sent)), /isn't valid/);
  await assert.rejects(submitOwnerSignature(owner.address, fresh.id, undefined, relayOk(sent)), /isn't valid/);
  assert.deepEqual(sent, []);
});

test("a failed relay leaves the request retryable; a concurrent second submit while one is running is refused", async () => {
  clearOwnerSignRecords();
  const r = hold();
  const sig = await sign(owner, r);
  await assert.rejects(submitOwnerSignature(owner.address, r.id, sig, { relay: async () => { throw new UserFacingError("nope"); } }), /nope/);
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const first = submitOwnerSignature(owner.address, r.id, sig, { relay: async () => { await gate; return "0x1"; } });
  await assert.rejects(submitOwnerSignature(owner.address, r.id, sig, relayOk([])), /already sent/);
  release();
  assert.equal((await first).txHash, "0x1");
});


test("remaining-zero fault: remainingToday returns 0 without calling the chain", async () => {
  const before = process.env.ORCHESTRA_FAULT_INJECT;
  const mod = process.env.SPENDING_MODULE_ADDRESS;
  try {
    process.env.ORCHESTRA_FAULT_INJECT = "remaining-zero";
    process.env.SPENDING_MODULE_ADDRESS = "0x00000000000000000000000000000000000000c3";
    // Would throw without a provider/module if it hit the chain; the fault short-circuits.
    assert.equal(await remainingToday(SAFE), 0n);
  } finally {
    if (before === undefined) delete process.env.ORCHESTRA_FAULT_INJECT; else process.env.ORCHESTRA_FAULT_INJECT = before;
    if (mod === undefined) delete process.env.SPENDING_MODULE_ADDRESS; else process.env.SPENDING_MODULE_ADDRESS = mod;
  }
});

test("attack: remaining-zero is ignored in production and on 0G, and the bridge refuses to start with it in production", () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
  assert.equal(faultOn("remaining-zero", env({ ORCHESTRA_FAULT_INJECT: "remaining-zero" })), true);
  assert.equal(faultOn("remaining-zero", env({ ORCHESTRA_FAULT_INJECT: "remaining-zero", NODE_ENV: "production" })), false);
  assert.equal(faultOn("remaining-zero", env({ ORCHESTRA_FAULT_INJECT: "remaining-zero", STORAGE_BACKEND: "0g" })), false);
  assert.match(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "remaining-zero", NODE_ENV: "production" }))!, /production/);
  assert.equal(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "remaining-zero" })), null);
});

const holdWith = (extra: { valueUsd?: number; to?: string; token?: string }, now?: number) =>
  holdOwnerSign({ wallet: owner.address, safeAddress: SAFE, summary: "Send 1500 USDC", call, ...extra }, now);

test("an owner-signed send is recorded once in the activity list, with source owner and the relay's hash", async () => {
  clearOwnerSignRecords();
  _resetPolicyStoreCache();
  const hash = "0x" + "cd".repeat(32);
  const r = holdWith({ valueUsd: 1500, to: call.to, token: "USDC" });
  const out = await submitOwnerSignature(owner.address, r.id, await sign(owner, r), { relay: async () => hash });
  const mine = (await getRecentActivity(owner.address)).filter((row) => row.txHash === hash);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].source, "owner");
  assert.equal(mine[0].valueUsd, 1500);
  assert.equal(mine[0].to, call.to);
  assert.equal(mine[0].token, "USDC");
  assert.equal(mine[0].explorerUrl, out.explorerUrl);
  await assert.rejects(submitOwnerSignature(owner.address, r.id, await sign(owner, r), { relay: async () => hash }), /already sent/);
  assert.equal((await getRecentActivity(owner.address)).filter((row) => row.txHash === hash).length, 1, "a repeat doesn't record again");
});

test("a failed relay records nothing; attack: another wallet can't submit (or record) for the owner", async () => {
  clearOwnerSignRecords();
  _resetPolicyStoreCache();
  // Fresh wallets so leftover activity from earlier tests in this file can't confuse the empty check.
  const payer = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom();
  const r = holdOwnerSign({ wallet: payer.address, safeAddress: SAFE, summary: "Send", call, valueUsd: 1500 });
  const sig = await sign(payer, r);
  const before = (await getRecentActivity(payer.address)).length;
  await assert.rejects(submitOwnerSignature(payer.address, r.id, sig, { relay: async () => { throw new UserFacingError("nope"); } }), /nope/);
  await assert.rejects(submitOwnerSignature(other.address, r.id, sig, relayOk([])), /couldn't find/);
  assert.equal((await getRecentActivity(payer.address)).length, before, "failed relay must not record");
  assert.equal((await getRecentActivity(other.address)).length, 0);
});

test("the offer carries the amount, recipient and token from the account run (not from the client)", async () => {
  const seen: unknown[] = [];
  const { deps } = fake({ remaining: 0n, offer: async (_w, _s, _sum, _b, meta) => { seen.push(meta); return { kind: "safe-owner", id: "x" }; } });
  await assert.rejects(executeForAccount(input(1500, { to: call.to, token: "USDC" }), deps), OverCapError);
  assert.deepEqual(seen, [{ valueUsd: 1500, to: call.to, token: "USDC" }]);
});

test("getOwnerSign: only the owner sees a pending request; missing, someone else's, used and expired all look the same", async () => {
  clearOwnerSignRecords();
  const t0 = Date.now();
  const r = hold(t0);
  assert.equal(getOwnerSign(owner.address, r.id, t0).id, r.id);
  assert.equal(getOwnerSign(owner.address.toLowerCase(), r.id, t0).id, r.id);
  assert.equal(ownerSignView(getOwnerSign(owner.address, r.id, t0)).safeTxHash, safeTxHashOf(r.domain, r.message));
  for (const bad of [() => getOwnerSign(stranger.address, r.id, t0), () => getOwnerSign(owner.address, "nope", t0), () => getOwnerSign(owner.address, undefined, t0)]) {
    assert.throws(bad, (e: any) => e instanceof UserFacingError && e.status === 404);
  }
  assert.throws(() => getOwnerSign(owner.address, r.id, t0 + OWNER_SIGN_TTL_MS + 1), (e: any) => e.status === 404);
  assert.throws(() => getOwnerSign(owner.address, r.id, t0), (e: any) => e.status === 404, "once expired it stays expired");
  const done = hold();
  await submitOwnerSignature(owner.address, done.id, await sign(owner, done), relayOk([]));
  assert.throws(() => getOwnerSign(owner.address, done.id), (e: any) => e.status === 404, "an executed one can't be shown again");
});

test("remaining-zero: executeForAccount offers owner-sign for a small send when remaining reads 0", async () => {
  // Mirrors what the fault does for the real remainingToday: deps.remainingCents returns 0.
  const { deps, calls } = fake({ remaining: 0n });
  await assert.rejects(executeForAccount(input(1), deps), (e: any) => e instanceof OverCapError && !!e.ownerSign);
  assert.ok(!calls.includes("module") && !calls.includes("owner"), "nothing reached the chain");
});

// ─── The /simple page ───

test("the page may sign only a held owner request (like a deposit), never an agent payload; an email user needs a passkey", () => {
  assert.equal(userMaySign({ emailWallet: false, hasPasskey: false }, "safe-owner"), true);
  assert.equal(userMaySign({ emailWallet: true, hasPasskey: false }, "safe-owner"), false);
  assert.equal(userMaySign({ emailWallet: true, hasPasskey: true }, "safe-owner"), true);
  for (const kind of ["send", "swap", "add_liquidity", "remove_liquidity", "anything"]) {
    assert.equal(userMaySign({ emailWallet: false, hasPasskey: true }, kind), false, kind);
  }
});

test("an over-ceiling answer becomes a message with a sign button only when it carries a signable offer", () => {
  const offer = { kind: "safe-owner", id: "abc", typedData: { domain: {}, types: {}, primaryType: "SafeTx", message: {} } };
  const mk = (code: string | undefined, ownerSign: unknown) => Object.assign(new Error(OVER_CAP_TEXT), { code, data: { ownerSign } });
  assert.deepEqual(errorMessage(mk("over_daily_cap", offer)), { role: "agent", error: OVER_CAP_TEXT, ownerSign: offer });
  assert.deepEqual(errorMessage(mk("over_daily_cap", undefined)), { role: "agent", error: OVER_CAP_TEXT });
  assert.deepEqual(errorMessage(mk("over_daily_cap", { kind: "other", id: "abc", typedData: {} })), { role: "agent", error: OVER_CAP_TEXT });
  assert.deepEqual(errorMessage(mk(undefined, offer)), { role: "agent", error: OVER_CAP_TEXT }, "only the over-ceiling code carries an offer");
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exit(1);
    }
  }
  console.log(`\n${passed} passed`);
})();
