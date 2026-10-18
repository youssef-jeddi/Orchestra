// ─── /simple approval card — what it says and offers (frontend helpers, no browser) ───
// Run with `npm run test:approval-card`. ORC-70 (a way to say no) and ORC-75 (a held action is
// never paid from the personal wallet).

import assert from "node:assert/strict";
import { ethers } from "ethers";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import * as card from "../../frontend/src/lib/approvalCard.js";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { userMaySign } from "../../frontend/src/lib/emailPasskey.js";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { executeSend, executeSwap, depositToSafe } from "../../frontend/src/lib/signing.js";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { RULE_LABELS } from "../../frontend/src/lib/plainLanguage.js";

// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import * as bal from "../../frontend/src/lib/balances.js";

const JARGON = /\b(safe|multisig|nonce|calldata|erc-?20|eip-?\d+|gas|hash|slug|rule)\b/i;
const addr = () => ethers.Wallet.createRandom().address;

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("tooltips: every rule chip has one short plain sentence, and an unknown slug gets a calm one", () => {
  for (const slug of Object.keys(RULE_LABELS)) {
    const hint = card.ruleHint(slug);
    assert.ok(card.RULE_HINTS[slug], `${slug} has its own sentence`);
    assert.ok(hint.length < 90 && /[.]$/.test(hint), hint);
    assert.ok(!JARGON.test(hint), hint);
  }
  assert.equal(card.ruleHint("unknown-recipient"), "You haven't sent to this address before.");
  assert.ok(!card.ruleHint("something-new").includes("something-new"));
});

test("decline: plain button and outcome wording for each kind of action", () => {
  assert.equal(card.declineLabel("send"), "Don't send");
  assert.equal(card.declineLabel("swap"), "Don't swap");
  assert.ok(card.declineLabel("add_liquidity") && card.declineLabel("remove_liquidity"));
  assert.equal(card.declinedText("send"), "You said no. Nothing was sent.");
  assert.equal(card.declinedText("swap"), "You said no. Nothing was swapped.");
  assert.equal(card.expiredText("send"), "This request expired. Nothing was sent.");
  for (const kind of ["send", "swap", "add_liquidity", "remove_liquidity", "other"]) {
    for (const t of [card.declineLabel(kind), card.declinedText(kind), card.expiredText(kind)]) assert.ok(!JARGON.test(t), t);
  }
});

test("controls: every pending held card can be declined — passkey and Telegram alike", () => {
  const passkey = card.approvalControls({ intentType: "send", approval: { id: "a" }, passkeyReg: true });
  assert.deepEqual([passkey.mode, passkey.canDecline], ["passkey", true]);
  const telegram = card.approvalControls({ intentType: "swap", approval: { id: "a", channel: "telegram" }, passkeyReg: true });
  assert.deepEqual([telegram.mode, telegram.canDecline], ["telegram", true]);
  const lp = card.approvalControls({ intentType: "add_liquidity", approval: { id: "a" }, passkeyReg: false });
  assert.equal(lp.canDecline, true);
});

test("ORC-75: no passkey and not on Telegram → add a passkey or link Telegram; never the personal wallet", () => {
  for (const intentType of ["send", "swap", "add_liquidity", "remove_liquidity"]) {
    const c = card.approvalControls({ intentType, approval: { id: "a" }, passkeyReg: false });
    assert.equal(c.mode, "need-passkey", intentType);
    assert.notEqual(c.mode, "wallet");
    assert.match(c.text, /Add passkey/);
    assert.match(c.text, /Telegram/);
    assert.match(c.text, /ask again/);
    assert.equal(c.canDecline, true);
  }
});

test("ORC-75: no server-held approval (account not ready) → still being set up, no wallet path, nothing to decline", () => {
  for (const intentType of ["send", "swap"]) {
    const c = card.approvalControls({ intentType, approval: undefined, passkeyReg: false });
    assert.equal(c.mode, "not-ready");
    assert.match(c.text, /still being set up/);
    assert.equal(c.canDecline, false);
  }
});

test("ORC-75: a deposit is the one thing the personal wallet pays", () => {
  const c = card.approvalControls({ intentType: "deposit", approval: undefined, passkeyReg: false });
  assert.deepEqual([c.mode, c.canDecline], ["wallet", false]);
});

test("attack: a held send or swap never reaches the personal wallet — MetaMask user, no passkey, any card state", async () => {
  const touched: string[] = [];
  const ledger = { connectionType: "metamask", walletAddress: addr(), getProvider: () => { touched.push("provider"); return null; } };
  const data = { sendData: { unsignedTx: { to: addr(), data: "0x", value: "1" } }, quoteData: {} };
  for (const who of [{ emailWallet: false, hasPasskey: false }, { emailWallet: false, hasPasskey: true }, undefined]) {
    await assert.rejects(executeSend(ledger, data, who), /passkey or on Telegram/);
    await assert.rejects(executeSwap(ledger, data, who), /passkey or on Telegram/);
  }
  assert.deepEqual(touched, [], "the wallet was never asked to sign");
  for (const kind of ["send", "swap", "add_liquidity", "remove_liquidity"]) {
    assert.equal(userMaySign({ emailWallet: false, hasPasskey: false }, kind), false, kind);
  }
});

test("a deposit into their own account is still allowed for a MetaMask user without a passkey", async () => {
  const sent: any[] = [];
  const ledger = { connectionType: "metamask", walletAddress: addr(), getProvider: () => ({
    request: async ({ method, params }: any) => { if (method === "eth_chainId") return "0xaa36a7"; if (method === "eth_sendTransaction") { sent.push(params[0]); return "0xabc"; } throw new Error(method); },
  }) };
  const safe = addr();
  const out = await depositToSafe(ledger, safe, "eth", "0.01", { emailWallet: false, hasPasskey: false });
  assert.equal(out.txHash, "0xabc");
  assert.equal(sent[0].to, safe);
});

// ── Card state transitions (ORC-70): open → approving → done / failed, or ended ──
const open = { signing: false, declining: false };

test("open card: both buttons are there and enabled", () => {
  const v = card.cardView({ ...open });
  assert.deepEqual([v.settled, v.showApprove, v.showDecline, v.approveDisabled, v.declineDisabled], [false, true, true, false, false]);
});

test("approving: the decline button is disabled (and so is approve) so the two can't race", () => {
  const v = card.cardView({ ...open, signing: true });
  assert.equal(v.settled, false);
  assert.equal(v.declineDisabled, true);
  assert.equal(v.approveDisabled, true);
  const d = card.cardView({ ...open, declining: true });
  assert.equal(d.approveDisabled, true, "and approve is disabled while a decline is in flight");
});

test("approved: the card says Done with the receipt link and loses both buttons", () => {
  const outcome = card.doneOutcome({ txHash: "0xabc", explorerUrl: "https://sepolia.etherscan.io/tx/0xabc" });
  const v = card.cardView({ ...open, outcome });
  assert.deepEqual([v.settled, v.line, v.receiptUrl, v.showApprove, v.showDecline], [true, "Done.", "https://sepolia.etherscan.io/tx/0xabc", false, false]);
  assert.equal(card.DONE_TEXT, "Done.");
});

test("failed after the server ran it: a plain error line, no buttons", () => {
  const outcome = card.outcomeAfterError(new Error("boom"), { status: "failed", error: "The transfer reverted" }, "send");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.text, "It didn't go through: The transfer reverted");
  const v = card.cardView({ ...open, outcome });
  assert.deepEqual([v.settled, v.showApprove, v.showDecline], [true, false, false]);
  assert.ok(!JARGON.test(v.line));
});

test("an error while the approval is still waiting (prompt cancelled, check failed) leaves the card open", () => {
  for (const approval of [{ status: "pending" }, { status: "executing" }, null, undefined]) {
    assert.equal(card.outcomeAfterError(new Error("cancelled"), approval, "send"), null);
  }
});

test("the server's state wins when the approval call errors: executed → Done, declined/expired → the plain ended line", () => {
  const done = card.outcomeAfterError(new Error("timeout"), { status: "executed", txHash: "0x1", explorerUrl: "https://x" }, "send");
  assert.equal(card.cardView({ ...open, outcome: done }).line, "Done.");
  assert.equal(card.outcomeAfterError(new Error("x"), { status: "rejected" }, "send").text, "You said no. Nothing was sent.");
  assert.equal(card.outcomeAfterError(new Error("x"), { status: "expired" }, "swap").text, "This request expired. Nothing was swapped.");
});

test("declined card: the line replaces the buttons; a failed decline keeps them; settled elsewhere hides only decline", () => {
  const ended = { text: card.declinedText("send") };
  const v = card.cardView({ ...open, ended });
  assert.deepEqual([v.settled, v.line, v.showApprove, v.showDecline], [true, "You said no. Nothing was sent.", false, false]);
  const retry = card.cardView({ ...open, ended: { text: "network", retry: true } });
  assert.deepEqual([retry.settled, retry.showApprove, retry.showDecline], [false, true, true]);
  const phone = card.cardView({ ...open, settledElsewhere: true });
  assert.deepEqual([phone.showApprove, phone.showDecline], [true, false]);
});

// ── The verdict pill and rule chips give way to one calm pill once the card is settled ──
test("open card: the verdict pill and the rule chips stay", () => {
  const v = card.cardView({ ...open, intentType: "send" });
  assert.deepEqual([v.pill, v.showChips], [null, true]);
  const retry = card.cardView({ ...open, intentType: "send", ended: { kind: "handled", text: "x", retry: true } });
  assert.deepEqual([retry.pill, retry.showChips], [null, true], "a failed decline leaves the card as it was");
});

test("declined: one calm 'Not sent' pill (verb follows the action) and no chips", () => {
  const labels: Record<string, string> = { send: "Not sent", swap: "Not swapped", add_liquidity: "Not added", remove_liquidity: "Not taken out", other: "Not done" };
  for (const [intentType, label] of Object.entries(labels)) {
    const v = card.cardView({ ...open, intentType, ended: { kind: "declined", text: card.declinedText(intentType) } });
    assert.deepEqual([v.pill.label, v.pill.tone, v.showChips], [label, "calm", false], intentType);
  }
});

test("expired: 'Expired', no chips — also when the server tells us after a failed approval", () => {
  const v = card.cardView({ ...open, intentType: "send", ended: { kind: "expired", text: card.expiredText("send") } });
  assert.deepEqual([v.pill.label, v.showChips], ["Expired", false]);
  const after = card.outcomeAfterError(new Error("x"), { status: "expired" }, "swap");
  assert.equal(card.cardView({ ...open, intentType: "swap", outcome: after }).pill.label, "Expired");
  const declined = card.outcomeAfterError(new Error("x"), { status: "rejected" }, "swap");
  assert.equal(card.cardView({ ...open, intentType: "swap", outcome: declined }).pill.label, "Not swapped");
});

test("done after a passkey approval reads 'Done'; a failed run says it didn't go through; neither keeps chips", () => {
  const done = card.cardView({ ...open, intentType: "send", outcome: card.doneOutcome({ txHash: "0x1", explorerUrl: "https://x" }) });
  assert.deepEqual([done.pill.label, done.pill.tone, done.showChips], ["Done", "good", false]);
  const failed = card.cardView({ ...open, intentType: "send", outcome: { status: "failed", text: "It didn't go through: boom" } });
  assert.deepEqual([failed.pill.label, failed.pill.tone, failed.showChips], ["Didn't go through", "bad", false]);
  const handled = card.cardView({ ...open, intentType: "send", ended: { kind: "handled", text: card.ALREADY_SETTLED } });
  assert.deepEqual([handled.pill.label, handled.showChips], ["Already handled", false]);
});

// ── The header balance is re-read after money moves ──
test("balance refresh: an auto-executed send, swap or liquidity change refreshes; chat, held and failed answers don't", () => {
  for (const intentType of ["send", "swap", "add_liquidity", "remove_liquidity"]) {
    assert.equal(bal.shouldRefreshBalances({ autoExecuted: true, txHash: "0x1", intentType }), true, intentType);
  }
  assert.equal(bal.shouldRefreshBalances({ autoExecuted: false, intentType: "send" }), false, "held for approval");
  assert.equal(bal.shouldRefreshBalances({ autoExecuted: true, intentType: "send" }), false, "no transaction");
  assert.equal(bal.shouldRefreshBalances({ autoExecuted: true, txHash: "0x1", intentType: "balance" }), false);
  assert.equal(bal.shouldRefreshBalances({ status: "reply" }), false);
  assert.equal(bal.shouldRefreshBalances(undefined), false);
});

test("balance refresh: an approval that was carried out (passkey, Telegram, phone) refreshes; one that wasn't doesn't", () => {
  assert.equal(bal.approvalMovedFunds({ status: "executed", intentType: "send" }), true);
  assert.equal(bal.approvalMovedFunds({ status: "executed", intentType: "swap" }), true);
  for (const status of ["pending", "executing", "rejected", "expired", "failed"]) assert.equal(bal.approvalMovedFunds({ status, intentType: "send" }), false, status);
});

test("balance refresh: read now and once more shortly after", () => {
  const calls: string[] = [];
  const timers: [() => void, number][] = [];
  bal.refreshSoon(() => calls.push("read"), (fn: () => void, ms: number) => { timers.push([fn, ms]); return 1; });
  assert.deepEqual(calls, ["read"]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], bal.REFRESH_AGAIN_MS);
  timers[0][0]();
  assert.deepEqual(calls, ["read", "read"]);
});

(async () => {
  console.log("approval card");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
