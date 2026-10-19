// ─── Policy — known recipients (no network) ───
// Run with `npm run test:recipients`. ORC-68: the server records an address only after a send to
// it went through, keeps the list apart from the user-editable policy, and every other address asks.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { assessAction } from "../intent/pipeline";
import { createApproval, declineApproval, claim, _resetApprovals, type PendingApproval } from "../approvals";
import { executeApprovalFlow, rememberSentRecipient } from "../approvals/flows";
import { sentRecipient } from "../approvals/describe";
import { USDC_SEPOLIA } from "../integrations/uniswap/types";
import {
  getPolicyProfile, getKnownRecipients, recordKnownRecipient, removeKnownRecipient,
  readUserProfile, writeUserProfile, updateUserProfile, _resetPolicyStoreCache,
} from "./store";

const WALLET = "0xAbC0000000000000000000000000000000000001";
const FRIEND = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const STRANGER = "0x000000000000000000000000000000000000dEaD";
const transfer = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
const usdcSend = (to: string) => ({ sendData: { unsignedTx: { to: USDC_SEPOLIA, value: "0", data: transfer.encodeFunctionData("transfer", [to, 5_000_000n]) } } });
const ethSend = (to: string) => ({ sendData: { unsignedTx: { to, value: "1000", data: "0x" } } });

const newApproval = (execution: Record<string, unknown>, intentType: PendingApproval["intentType"] = "send") =>
  createApproval({ wallet: WALLET, safeAddress: "0x933f48ed12e2de3da82cc69c7a4f95c2adece3d1", intentType, summary: "s", valueUsd: 5, reason: "r", triggered: ["unknown-recipient"], execution });
const ok = async () => ({ txHash: "0xabc", explorerUrl: "https://x" });

const plan = (to: string): any => ({ id: "x", intentType: "send" as const, summary: "Send 5 USDC", steps: [{ action: "send", params: { to } }], params: { to }, valueUsd: 5 });

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("the recipient is read from the transaction that will run — ERC-20 transfer or native send", async () => {
  assert.equal(sentRecipient(usdcSend(FRIEND)), FRIEND);
  assert.equal(sentRecipient(ethSend(FRIEND.toLowerCase())), FRIEND);
  assert.equal(sentRecipient({ sendData: { unsignedTx: { to: USDC_SEPOLIA, value: "0", data: "0xdeadbeef" } } }), null);
  assert.equal(sentRecipient({}), null);
});

test("an approved send that executed records its recipient (lowercased); the next send to it no longer asks", async () => {
  const a = await newApproval(usdcSend(FRIEND));
  await claim(a.id, WALLET);
  await executeApprovalFlow(a, ok);
  assert.deepEqual(await getKnownRecipients(WALLET), [FRIEND.toLowerCase()]);
  const profile = await getPolicyProfile(WALLET);
  assert.equal(assessAction(plan(FRIEND), { profile }).verdict, "AUTO_EXECUTE");
  assert.equal(assessAction(plan(STRANGER), { profile }).verdict, "NEEDS_APPROVAL");
});

test("not recorded: a failed execution, a decline, an expired approval or a non-send", async () => {
  const failed = await newApproval(usdcSend(FRIEND));
  await claim(failed.id, WALLET);
  await assert.rejects(executeApprovalFlow(failed, async () => { throw new Error("reverted"); }), /reverted/);
  assert.equal(failed.status, "failed");

  const empty = await newApproval(usdcSend(FRIEND));
  await claim(empty.id, WALLET);
  await assert.rejects(executeApprovalFlow(empty, async () => null), /no result/);

  const declined = await newApproval(usdcSend(FRIEND));
  await declineApproval(declined.id, WALLET);
  const expired = await newApproval(usdcSend(FRIEND));
  expired.status = "expired";
  await rememberSentRecipient(WALLET, "swap", usdcSend(FRIEND)); // not a send
  assert.deepEqual(await getKnownRecipients(WALLET), []);
});

test("an executed swap or liquidity action records nothing", async () => {
  const swap = await newApproval({ quoteData: { tokenIn: USDC_SEPOLIA } }, "swap");
  await claim(swap.id, WALLET);
  await executeApprovalFlow(swap, ok);
  assert.deepEqual(await getKnownRecipients(WALLET), []);
});

test("attack: a legacy policy.knownAddresses written through the API is ignored", async () => {
  await writeUserProfile(WALLET, { policy: { knownAddresses: [STRANGER], dailyLimitUsd: 50 } });
  const profile = await getPolicyProfile(WALLET);
  assert.deepEqual(profile.knownAddresses, []);
  assert.equal(profile.dailyLimitUsd, 50, "the rest of the policy still applies");
  assert.equal(assessAction(plan(STRANGER), { profile }).verdict, "NEEDS_APPROVAL");
});

test("a profile that can't be read leaves the list empty, so a send asks", async () => {
  const profile = await getPolicyProfile(undefined); // what the 2s timeout fallback also yields: {}
  assert.equal(assessAction(plan(FRIEND), { profile }).verdict, "NEEDS_APPROVAL");
  assert.equal(assessAction(plan(FRIEND), { profile: {} }).verdict, "NEEDS_APPROVAL");
});

test("removing an address is instant and the next send to it asks again; other addresses stay", async () => {
  await recordKnownRecipient(WALLET, FRIEND);
  await recordKnownRecipient(WALLET, STRANGER);
  await recordKnownRecipient(WALLET, FRIEND.toUpperCase().replace("0X", "0x")); // same address, no duplicate
  assert.equal((await getKnownRecipients(WALLET)).length, 2);
  assert.deepEqual(await removeKnownRecipient(WALLET, FRIEND), [STRANGER.toLowerCase()]);
  const profile = await getPolicyProfile(WALLET);
  assert.equal(assessAction(plan(FRIEND), { profile }).verdict, "NEEDS_APPROVAL");
  assert.equal(assessAction(plan(STRANGER), { profile }).verdict, "AUTO_EXECUTE");
});

test("junk is not recorded", async () => {
  await recordKnownRecipient(WALLET, "vitalik.eth");
  await recordKnownRecipient(WALLET, "0x1234");
  assert.deepEqual(await getKnownRecipients(WALLET), []);
});

test("a recorded address and a policy change racing each other both survive", async () => {
  await Promise.all([
    recordKnownRecipient(WALLET, FRIEND),
    updateUserProfile(WALLET, (p) => ({ ...p, policy: { ...(p.policy || {}), dailyLimitUsd: 20 } })),
    recordKnownRecipient(WALLET, STRANGER),
  ]);
  const p = await readUserProfile(WALLET);
  assert.equal(p.policy.dailyLimitUsd, 20);
  assert.equal((await getKnownRecipients(WALLET)).length, 2);
});

test("each wallet has its own list", async () => {
  await recordKnownRecipient(WALLET, FRIEND);
  assert.deepEqual(await getKnownRecipients("0x0000000000000000000000000000000000000002"), []);
});

(async () => {
  console.log("recipients");
  for (const [name, fn] of tests) {
    _resetApprovals();
    _resetPolicyStoreCache();
    await writeUserProfile(WALLET, {});
    await writeUserProfile("0x0000000000000000000000000000000000000002", {});
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
