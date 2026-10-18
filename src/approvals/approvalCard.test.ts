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
    assert.match(c.text, /add a passkey/);
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

(async () => {
  console.log("approval card");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
