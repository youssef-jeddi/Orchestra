// ─── Passkey — what the chat shows and allows an email user (frontend helpers, no browser) ───
// Run with `npm run test:email-ui`. Pure helpers in frontend/src/lib/emailPasskey.js and the
// signing helpers in frontend/src/lib/signing.js, which must refuse an email user's wallet.

import assert from "node:assert/strict";
import { ethers } from "ethers";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import * as ui from "../../../frontend/src/lib/emailPasskey.js";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { depositToSafe, executeSend, executeSwap } from "../../../frontend/src/lib/signing.js";

const addr = () => ethers.Wallet.createRandom().address;

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

(async () => {
  // ── What the chat shows and allows (frontend/src/lib/emailPasskey.js, frontend/src/lib/signing.js) ──

  test("UI: the prompt is plain words for newcomers — passkey, email code, no jargon", () => {
    assert.match(ui.PASSKEY_PROMPT, /passkey/);
    assert.match(ui.PASSKEY_PROMPT, /email you a code/);
    assert.ok(!/\bSafe\b|wallet|signer|multisig/.test(ui.PASSKEY_PROMPT), ui.PASSKEY_PROMPT);
    assert.equal(ui.isPasskeyRequired({ status: "passkey_required" }), true);
    assert.equal(ui.isPasskeyRequired({ status: "ok" }), false);
    assert.equal(ui.isPasskeyRequired(undefined), false);
  });

  test("UI: the passkey is offered on its own only to an email user with a ready account and no passkey", () => {
    const base = { emailWallet: true, hasPasskey: false, accountReady: true };
    assert.equal(ui.shouldOfferPasskey(base), true);
    assert.equal(ui.shouldOfferPasskey({ ...base, hasPasskey: true }), false, "already added one: no prompt");
    assert.equal(ui.shouldOfferPasskey({ ...base, emailWallet: false }), false, "passkey and wallet users: no prompt");
    assert.equal(ui.shouldOfferPasskey({ ...base, accountReady: false }), false, "after the account is created");
  });

  test("UI: an email user is never offered their own wallet's signature, except funding their account once they hold a passkey", () => {
    for (const kind of ["send", "swap"]) {
      assert.equal(ui.userMaySign({ emailWallet: true, hasPasskey: true }, kind), false, kind);
      assert.equal(ui.userMaySign({ emailWallet: true, hasPasskey: false }, kind), false, kind);
    }
    assert.equal(ui.userMaySign({ emailWallet: true, hasPasskey: false }, "deposit"), false, "no passkey, no deposit");
    assert.equal(ui.userMaySign({ emailWallet: true, hasPasskey: true }, "deposit"), true);
    for (const kind of ["send", "swap", "deposit"]) assert.equal(ui.userMaySign({ emailWallet: false, hasPasskey: false }, kind), true, `wallet users keep ${kind}`);
  });

  test("UI: the signing helpers refuse an email user before touching their wallet (and a caller that forgot who)", async () => {
    const touched: string[] = [];
    const ledger = { connectionType: "privy", walletAddress: addr(), getProvider: () => { touched.push("provider"); return null; } };
    const data = { sendData: { unsignedTx: { to: addr(), data: "0x", value: "1" } }, quoteData: {} };
    const email = { emailWallet: true, hasPasskey: false };
    await assert.rejects(executeSend(ledger, data, email), /passkey/);
    await assert.rejects(executeSwap(ledger, data, email), /passkey/);
    await assert.rejects(depositToSafe(ledger, addr(), "eth", "0.01", email), /passkey/);
    await assert.rejects(executeSend(ledger, data, { emailWallet: true, hasPasskey: true }), /passkey/);
    await assert.rejects(executeSend(ledger, data, undefined), /passkey/);
    assert.deepEqual(touched, [], "the embedded wallet was never asked to sign");
  });

  test("UI: the held-back request is sent once after the passkey is added, then forgotten", () => {
    const held = ui.pendingRequest();
    assert.equal(held.take(), null);
    held.hold("send 5 USDC to vitalik.eth", [{ role: "user", content: "hi" }]);
    assert.deepEqual(held.take(), { text: "send 5 USDC to vitalik.eth", history: [{ role: "user", content: "hi" }] });
    assert.equal(held.take(), null, "not sent twice");
  });

  test("UI: account state falls back to the sign-in answer, and errors are plain sentences", () => {
    assert.deepEqual(ui.accountFrom({ emailWallet: true, hasPasskey: false }), { emailWallet: true, hasPasskey: false });
    assert.deepEqual(ui.accountFrom(null, { emailWallet: true }), { emailWallet: true, hasPasskey: false });
    assert.deepEqual(ui.accountFrom(null, {}), { emailWallet: false, hasPasskey: false });
    assert.match(ui.emailStepError(new Error("raw"), "email"), /code/);
    assert.match(ui.emailStepError(Object.assign(new Error("x"), { code: "email_verification_failed" }), "email"), /x/);
    assert.ok(!/HTTP|undefined|Error/.test(ui.emailStepError(new Error("HTTP 500"), "passkey")));
  });

  console.log("email ui");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
