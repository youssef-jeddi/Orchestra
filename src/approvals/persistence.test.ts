// ─── Approvals — pending approvals survive a bridge restart (no network) ───
// Run with `npm run test:approval-persistence`. A restart is simulated with _resetApprovals()
// (forgets the in-memory map, not storage) followed by loadApprovals().

import assert from "node:assert/strict";
import {
  createApproval, getApproval, claim, reject, declineApproval, settle, persistApproval, loadApprovals,
  issueReviewToken, approvalForReview, hashExecution, ApprovalError, APPROVAL_TTL_MS,
  _resetApprovals, _setApprovalStore, type NewApproval, type PendingApproval,
} from "./index";
import { approveWithPasskeyFlow, telegramDecisionFlow } from "./flows";
import { read, readMany, write, clear } from "../integrations/zero-g/storage";

console.log = ((orig) => (...a: unknown[]) => { if (!String(a[0]).startsWith("[LocalStorage]")) orig(...a); })(console.log);
console.warn = () => {};
const logError = console.error;
console.error = () => {}; // the failures these tests inject are logged on purpose

const WALLET = "0xAbC0000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";
const base = (over: Partial<NewApproval> = {}): NewApproval => ({
  wallet: WALLET,
  safeAddress: "0x933f48ed12e2de3da82cc69c7a4f95c2adece3d1",
  intentType: "send",
  summary: "Send 150 USDC to vitalik.eth",
  valueUsd: 150,
  reason: "over limit",
  triggered: ["daily-limit"],
  execution: { sendData: { unsignedTx: { to: "0xUSDC", data: "0xa9059cbb", value: "0" } } },
  ...over,
});
const status = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof ApprovalError ? e.status : -1; }
  return 0;
};
const restart = async () => { _resetApprovals(); await loadApprovals(); };
const stored = (id: string) => read(`approvals/${id}`) as Promise<Record<string, any> | null>;
const failingStore = (over: Partial<Parameters<typeof _setApprovalStore>[0] & object> = {}) => ({
  write: async () => { throw new Error("disk full"); },
  readMany: async () => [],
  delete: async () => {},
  ...over,
});

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const executed: string[] = [];
const execute = async (a: PendingApproval) => { executed.push(a.id); return { txHash: "0xabc", explorerUrl: "https://x" }; };

test("a pending approval survives a restart intact, and can be claimed exactly once", async () => {
  const a = await createApproval(base());
  a.channel = "telegram";
  a.factor = "phone-passkey";
  a.telegram = { chatId: 7, messageId: 9 };
  await persistApproval(a);
  await restart();
  const b = getApproval(a.id)!;
  assert.notEqual(b, a, "a different object: it came back from storage");
  assert.deepEqual(
    [b.id, b.wallet, b.hash, b.expiresAt, b.status, b.channel, b.factor, b.telegram, b.execution],
    [a.id, a.wallet, a.hash, a.expiresAt, "pending", "telegram", "phone-passkey", { chatId: 7, messageId: 9 }, a.execution],
  );
  await claim(a.id, WALLET);
  assert.equal(await status(claim(a.id, WALLET)), 409);
  assert.equal((await stored(a.id))!.status, "executing", "saved before anything would run");
});

test("owner binding holds after a restart: another wallet's claim or decline → 403", async () => {
  const a = await createApproval(base());
  await restart();
  assert.equal(await status(claim(a.id, OTHER)), 403);
  assert.equal(await status(declineApproval(a.id, OTHER)), 403);
  assert.equal(await status(reject(a.id, OTHER)), 403);
  assert.equal(getApproval(a.id)!.status, "pending");
});

test("attack: an approval declined before the restart is still rejected after it and can't be claimed", async () => {
  const a = await createApproval(base());
  await declineApproval(a.id, WALLET);
  await restart();
  assert.equal(getApproval(a.id)!.status, "rejected");
  assert.equal(await status(claim(a.id, WALLET)), 409);
});

test("attack: an expired approval can't be claimed after a restart", async () => {
  const a = await createApproval(base(), Date.now() - APPROVAL_TTL_MS - 1000);
  await restart();
  assert.equal(getApproval(a.id)!.status, "expired");
  assert.equal(await status(claim(a.id, WALLET)), 409);
});

test("attack: an executed approval can't be claimed again after a restart", async () => {
  const a = await createApproval(base());
  await claim(a.id, WALLET);
  await settle(a, { result: { txHash: "0xabc", explorerUrl: "https://x" } });
  await restart();
  const b = getApproval(a.id)!;
  assert.deepEqual([b.status, b.result?.txHash], ["executed", "0xabc"]);
  assert.equal(await status(claim(a.id, WALLET)), 409);
});

test("attack: a record left 'executing' (crash mid-execution) loads as failed, is never re-run, and stays failed", async () => {
  const a = await createApproval(base());
  await claim(a.id, WALLET);
  await restart();
  const b = getApproval(a.id)!;
  assert.equal(b.status, "failed");
  assert.match(b.error!, /The server restarted while this was running\. Check your activity before asking again\./);
  assert.equal(await status(claim(a.id, WALLET)), 409);
  assert.equal((await stored(a.id))!.status, "failed", "the correction is saved too");
  await restart();
  assert.equal(getApproval(a.id)!.status, "failed");
});

test("attack: a stored payload changed after approval (hash mismatch) loads as failed and can't be claimed", async () => {
  const a = await createApproval(base());
  const row = (await stored(a.id))!;
  row.execution = { sendData: { unsignedTx: { to: "0xATTACKER", data: "0xa9059cbb", value: "999" } } };
  await write(`approvals/${a.id}`, row);
  assert.notEqual(hashExecution(row.execution), row.hash);
  await restart();
  const b = getApproval(a.id)!;
  assert.equal(b.status, "failed");
  assert.match(b.error!, /This request was changed after it was made, so it was cancelled\. Nothing was done\./);
  assert.equal(await status(claim(a.id, WALLET)), 409);
  executed.length = 0;
  b.challenge = "x";
  assert.equal(await status(approveWithPasskeyFlow(WALLET, a.id, { verify: async () => true, execute })), 409);
  assert.deepEqual(executed, []);
});

test("an executed record whose stored payload changed keeps its outcome (only an open request is failed)", async () => {
  const a = await createApproval(base());
  await claim(a.id, WALLET);
  await settle(a, { result: { txHash: "0xabc", explorerUrl: "https://x" } });
  const row = (await stored(a.id))!;
  row.execution = { sendData: { unsignedTx: { to: "0xATTACKER", data: "0x", value: "1" } } };
  await write(`approvals/${a.id}`, row);
  await restart();
  assert.deepEqual([getApproval(a.id)!.status, getApproval(a.id)!.result?.txHash], ["executed", "0xabc"]);
  assert.equal(await status(claim(a.id, WALLET)), 409);
});

test("after a restart the passkey flow runs the stored payload exactly once", async () => {
  executed.length = 0;
  const a = await createApproval(base());
  await restart();
  getApproval(a.id)!.challenge = "c1";
  await approveWithPasskeyFlow(WALLET, a.id, { verify: async () => true, execute });
  getApproval(a.id)!.challenge = "c2";
  assert.equal(await status(approveWithPasskeyFlow(WALLET, a.id, { verify: async () => true, execute })), 409);
  assert.deepEqual(executed, [a.id]);
});

test("incomplete records are dropped, the rest still load", async () => {
  const a = await createApproval(base());
  await write("approvals/junk-1", { id: "junk-1", status: "pending" });
  await write("approvals/junk-2", "not an object");
  await restart();
  assert.equal(getApproval("junk-1"), null);
  assert.equal(getApproval(a.id)!.status, "pending");
});

test("challenge, passkey options and the plain review token are never written; the review link still works after a restart", async () => {
  const a = await createApproval(base());
  a.challenge = "CHALLENGE-123";
  a.passkeyOptions = { challenge: "CHALLENGE-123", rpId: "x" };
  const token = issueReviewToken(a);
  await persistApproval(a);
  const raw = JSON.stringify(await stored(a.id));
  for (const secret of ["CHALLENGE-123", "passkeyOptions", token]) assert.ok(!raw.includes(secret), `${secret} must not be stored`);
  assert.match(raw, /reviewTokenHash/);

  const b = await createApproval(base());
  const t = issueReviewToken(b);
  await persistApproval(b);
  await restart();
  assert.equal(approvalForReview(b.id, t).id, b.id);
  assert.throws(() => approvalForReview(b.id, "wrong-token"), (e: any) => e instanceof ApprovalError && e.status === 404);
  assert.throws(() => approvalForReview(b.id, undefined), (e: any) => e.status === 404);
  assert.equal(getApproval(b.id)!.challenge, undefined, "a fresh challenge is issued after a restart");
});

test("attack: the Telegram-only choice survives a restart (it can't become a desktop-passkey approval)", async () => {
  executed.length = 0;
  const a = await createApproval(base());
  a.channel = "telegram";
  a.factor = "telegram-button";
  await persistApproval(a);
  await restart();
  getApproval(a.id)!.challenge = "c";
  assert.equal(await status(approveWithPasskeyFlow(WALLET, a.id, { verify: async () => true, execute })), 409);
  assert.deepEqual(executed, []);
});

test("claim when the save fails: 503, back to pending, and the passkey flow never executes", async () => {
  executed.length = 0;
  const a = await createApproval(base());
  a.challenge = "c";
  _setApprovalStore(failingStore());
  try {
    await assert.rejects(
      approveWithPasskeyFlow(WALLET, a.id, { verify: async () => true, execute }),
      (e: any) => e instanceof ApprovalError && e.status === 503 && e.message === "I couldn't save your OK, so nothing was done. Please try again in a moment.",
    );
  } finally { _setApprovalStore(); }
  assert.deepEqual(executed, []);
  assert.equal(getApproval(a.id)!.status, "pending");
  assert.equal((await stored(a.id))!.status, "pending");
  await claim(a.id, WALLET); // works once saving works again
});

test("Telegram yes when the save fails: told so, nothing executes; Telegram no likewise keeps it waiting", async () => {
  executed.length = 0;
  const a = await createApproval(base());
  a.channel = "telegram";
  a.factor = "telegram-button";
  const flow = telegramDecisionFlow({ requirePasskey: async () => {}, isPasskeyError: () => false, refresh: async () => {}, execute });
  _setApprovalStore(failingStore());
  try {
    assert.match(await flow({ wallet: a.wallet, approvalId: a.id, approve: true }), /couldn't save your OK, so nothing was done/);
    assert.match(await flow({ wallet: a.wallet, approvalId: a.id, approve: false }), /couldn't save that, so the request is still waiting/);
  } finally { _setApprovalStore(); }
  assert.deepEqual(executed, []);
  assert.equal(getApproval(a.id)!.status, "pending");
});

test("decline and reject when the save fails: 503, still pending (so a restart can't resurrect a 'no' as a 'yes')", async () => {
  const a = await createApproval(base());
  const b = await createApproval(base());
  _setApprovalStore(failingStore());
  try {
    await assert.rejects(declineApproval(a.id, WALLET), (e: any) => e.status === 503 && e.message === "I couldn't save that, so the request is still waiting. Please try again.");
    assert.equal(await status(reject(b.id, WALLET)), 503);
  } finally { _setApprovalStore(); }
  assert.equal(getApproval(a.id)!.status, "pending");
  assert.equal(getApproval(b.id)!.status, "pending");
});

test("create when the save fails: it throws and nothing is held", async () => {
  _setApprovalStore(failingStore());
  try {
    await assert.rejects(createApproval(base({ summary: "never held" })), /disk full/);
  } finally { _setApprovalStore(); }
  await restart();
  assert.deepEqual(await readMany("approvals"), []);
});

test("settle when the save fails is swallowed; the record on disk stays 'executing' and a restart fails it, never re-runs it", async () => {
  const a = await createApproval(base());
  await claim(a.id, WALLET);
  _setApprovalStore(failingStore());
  try {
    await settle(a, { result: { txHash: "0xabc", explorerUrl: "https://x" } });
  } finally { _setApprovalStore(); }
  assert.equal(a.status, "executed", "this process still knows how it ended");
  assert.equal((await stored(a.id))!.status, "executing");
  await restart();
  assert.equal(getApproval(a.id)!.status, "failed");
  assert.equal(await status(claim(a.id, WALLET)), 409);
});

test("a storage read failure makes loadApprovals throw (the bridge won't start as if nothing were pending)", async () => {
  _setApprovalStore(failingStore({ readMany: async () => { throw new Error("storage unreadable"); } }));
  try {
    await assert.rejects(loadApprovals(), /storage unreadable/);
  } finally { _setApprovalStore(); }
});

test("sweeping an old record also deletes it from storage", async () => {
  const old = await createApproval(base(), Date.now() - 3 * APPROVAL_TTL_MS);
  assert.ok(await stored(old.id));
  await createApproval(base()); // sweeps
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(getApproval(old.id), null);
  assert.equal(await stored(old.id), null);
});

(async () => {
  console.log("approval persistence");
  for (const [name, fn] of tests) {
    _resetApprovals();
    await clear();
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { logError(e); process.exit(1); });
