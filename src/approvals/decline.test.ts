// ─── Approvals — saying no from the app (no network) ───
// Run with `npm run test:decline`. Declining is final: the approval can't be approved
// afterwards on any channel, and nothing executes.

import assert from "node:assert/strict";
import { createApproval, declineApproval, getApproval, ApprovalError, APPROVAL_TTL_MS, _resetApprovals, type NewApproval, type PendingApproval } from "./index";
import { approveWithPasskeyFlow, telegramDecisionFlow } from "./flows";

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

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const executed: string[] = [];
const execute = async (a: PendingApproval) => { executed.push(a.id); return { txHash: "0xabc", explorerUrl: "https://x" }; };

test("decline: the wallet's own pending approval is rejected and its passkey challenge is dropped", async () => {
  const a = await createApproval(base());
  a.challenge = "abc";
  const r = await declineApproval(a.id, WALLET.toLowerCase());
  assert.equal(r.status, "rejected");
  assert.equal(r.challenge, undefined);
  assert.equal(getApproval(a.id)!.status, "rejected");
});

test("decline twice → 409 with a plain sentence", async () => {
  const a = await createApproval(base());
  await declineApproval(a.id, WALLET);
  assert.equal(await status(declineApproval(a.id, WALLET)), 409);
  await assert.rejects(declineApproval(a.id, WALLET), /already rejected/);
});

test("attack: another wallet's approval can't be declined (403) and stays pending", async () => {
  const a = await createApproval(base());
  assert.equal(await status(declineApproval(a.id, OTHER)), 403);
  assert.equal(getApproval(a.id)!.status, "pending");
});

test("unknown, expired or after-a-restart → 404 'expired, nothing was sent'", async () => {
  assert.equal(await status(declineApproval("nope", WALLET)), 404);
  await assert.rejects(declineApproval("nope", WALLET), /This request expired\. Ask me again\./);
  const t0 = 1_000_000;
  const a = await createApproval(base(), t0);
  assert.equal(await status(declineApproval(a.id, WALLET, undefined, t0 + APPROVAL_TTL_MS + 1)), 404);
  assert.equal(await status(declineApproval(undefined, WALLET)), 404);
});

test("an already executed approval can't be declined", async () => {
  const a = await createApproval(base());
  a.status = "executed";
  assert.equal(await status(declineApproval(a.id, WALLET)), 409);
});

test("attack: a passkey approval after a decline is refused and nothing executes", async () => {
  executed.length = 0;
  const a = await createApproval(base());
  a.challenge = "challenge";
  await declineApproval(a.id, WALLET);
  let verified = false;
  const run = approveWithPasskeyFlow(WALLET, a.id, { verify: async () => { verified = true; return true; }, execute });
  assert.equal(await status(run), 409);
  assert.equal(verified, false, "the passkey isn't even checked");
  assert.deepEqual(executed, []);
});

test("passkey approval still runs once, and not again", async () => {
  executed.length = 0;
  const a = await createApproval(base());
  a.challenge = "challenge";
  const { result } = await approveWithPasskeyFlow(WALLET, a.id, { verify: async () => true, execute });
  assert.equal(result.txHash, "0xabc");
  assert.deepEqual(executed, [a.id]);
  assert.equal(await status(declineApproval(a.id, WALLET)), 409, "can't decline what already went through");
});

const telegramApproval = async (over: Partial<PendingApproval> = {}) => {
  const a = await createApproval(base());
  a.channel = "telegram";
  a.factor = "telegram-button";
  a.telegram = { chatId: 1, messageId: 2 };
  return Object.assign(a, over);
};
const handler = (refreshed: string[]) => telegramDecisionFlow({
  requirePasskey: async () => {},
  isPasskeyError: () => false,
  refresh: async (a) => { refreshed.push(`${a.id}:${a.status}`); },
  execute,
});

test("decline closes the matching Telegram request (the message is refreshed to the rejected outcome)", async () => {
  const a = await telegramApproval();
  const refreshed: string[] = [];
  await declineApproval(a.id, WALLET, async (x) => { refreshed.push(`${x.id}:${x.status}`); });
  assert.deepEqual(refreshed, [`${a.id}:rejected`]);
});

test("a Telegram failure never undoes the decline", async () => {
  const a = await telegramApproval();
  const r = await declineApproval(a.id, WALLET, async () => { throw new Error("telegram down"); });
  assert.equal(r.status, "rejected");
});

test("attack: pressing Approve in Telegram after a decline in the app is refused and nothing executes", async () => {
  executed.length = 0;
  const a = await telegramApproval();
  await declineApproval(a.id, WALLET);
  const refreshed: string[] = [];
  const answer = await handler(refreshed)({ wallet: WALLET.toLowerCase(), approvalId: a.id, approve: true });
  assert.equal(answer, "Already rejected.");
  assert.deepEqual(executed, []);
  assert.deepEqual(refreshed, [`${a.id}:rejected`], "the message shows the outcome again");
});

test("Telegram yes still works when nothing was declined", async () => {
  executed.length = 0;
  const a = await telegramApproval();
  const answer = await handler([])({ wallet: WALLET.toLowerCase(), approvalId: a.id, approve: true });
  assert.match(answer, /Approved/);
  assert.deepEqual(executed, [a.id]);
});

(async () => {
  console.log("decline");
  for (const [name, fn] of tests) {
    _resetApprovals();
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
