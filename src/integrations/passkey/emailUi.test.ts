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
    assert.match(ui.PASSKEY_PROMPT, /check it's really you/);
    assert.ok(!/email|code/i.test(ui.PASSKEY_PROMPT), "true for email and social sign-ins alike");
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
    assert.equal(ui.userMaySign({ emailWallet: false, hasPasskey: false }, "deposit"), true, "wallet users keep topping up their account");
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

  test("UI: with a passkey the embedded wallet signs a top-up of the user's own account — and nothing else", async () => {
    const wallet = addr();
    const safe = addr();
    const sent: any[] = [];
    const ledger = { connectionType: "privy", walletAddress: wallet, getProvider: () => ({
      request: async ({ method, params }: any) => { if (method === "eth_chainId") return "0xaa36a7"; if (method === "eth_sendTransaction") { sent.push(params[0]); return "0xabc"; } throw new Error(method); },
    }) };
    const who = { emailWallet: true, hasPasskey: true };
    await depositToSafe(ledger, safe, "eth", "0.01", who);
    await depositToSafe(ledger, safe, "usdc", "5", who);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].to, safe);
    assert.equal(new ethers.Interface(["function transfer(address,uint256)"]).parseTransaction({ data: sent[1].data })!.args[0], safe);
    const data = { sendData: { unsignedTx: { to: addr(), data: "0x", value: "1" } }, quoteData: {} };
    await assert.rejects(executeSend(ledger, data, who), /passkey/, "an outgoing send is refused even with a passkey");
    await assert.rejects(executeSwap(ledger, data, who), /passkey/);
    assert.equal(sent.length, 2, "nothing else reached the wallet");
  });

  const JARGON = /oauth|identity token|\btokens?\b|re-?authenticat|wallet|signer|multisig|\bJWT\b|\bSSO\b|provider/i;
  const noJargon = (text: string) => assert.ok(!JARGON.test(text) && !/\bSafe\b/.test(text), text);

  test("UI: a social user is asked to confirm with their provider, named in plain words; email users keep the code", () => {
    assert.deepEqual(ui.verifyStepFor(["email"]), { kind: "email" });
    assert.deepEqual(ui.verifyStepFor(["email", "google_oauth"]), { kind: "email" }, "a user with an email keeps the email code");
    assert.deepEqual(ui.verifyStepFor([]), { kind: "email" }, "older accounts keep the email code");
    assert.deepEqual(ui.verifyStepFor(["google_oauth"]), { kind: "social", type: "google_oauth", id: "google", name: "Google" });
    const names: Record<string, string> = { apple_oauth: "Apple", twitter_oauth: "X", discord_oauth: "Discord", github_oauth: "GitHub" };
    for (const [type, name] of Object.entries(names)) {
      const step = ui.verifyStepFor([type]);
      assert.equal(step.kind, "social");
      assert.equal(step.name, name);
      assert.equal(ui.socialConfirmLabel(name), `Confirm it's you with ${name}`);
      assert.ok(ui.socialConfirmHelp(name).includes(name));
    }
    assert.equal(ui.verifyStepFor(["phone"]).kind, "none", "nothing we can offer for a phone-only account yet");
  });

  test("UI: the social wording has no jargon", () => {
    for (const name of ["Google", "Apple", "X", "Discord", "GitHub"]) {
      for (const text of [ui.socialConfirmLabel(name), ui.socialConfirmHelp(name)]) noJargon(text);
    }
    for (const text of [ui.SOCIAL_NONE, ui.SOCIAL_WRONG_ACCOUNT, ui.PASSKEY_PROMPT]) noJargon(text);
  });

  test("UI: the held-back request survives the trip to the provider and is forgotten after use", () => {
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const wallet = addr();
    const draft = ui.passkeyDraft(fake);
    assert.equal(draft.peek(wallet), null);
    const t0 = 1_000_000;
    draft.save({ wallet, text: "send 5 USDC to vitalik.eth", history: [{ role: "user", content: "hi" }] }, t0);
    const back = draft.peek(wallet.toLowerCase(), t0 + 60_000);
    assert.equal(back.mine, true);
    assert.equal(back.text, "send 5 USDC to vitalik.eth");
    assert.deepEqual(back.history, [{ role: "user", content: "hi" }]);
    assert.equal(draft.peek(addr(), t0 + 60_000).mine, false, "another wallet's sign-in doesn't get it");
    assert.equal(draft.peek(wallet, t0 + ui.DRAFT_TTL_MS + 1), null, "too old");
    assert.deepEqual(Object.keys(JSON.parse([...store.values()][0])).sort(), ["history", "savedAt", "text", "wallet"], "only the request and the wallet address are kept");
    draft.clear();
    assert.equal(draft.peek(wallet, t0 + 1), null);
    const held = ui.pendingRequest();
    held.hold("hello", []);
    assert.deepEqual(held.peek(), { text: "hello", history: [] });
    assert.deepEqual(held.take(), { text: "hello", history: [] });
    assert.equal(held.peek(), null);
  });

  test("UI: the held-back request is sent once after the passkey is added, then forgotten", () => {
    const held = ui.pendingRequest();
    assert.equal(held.take(), null);
    held.hold("send 5 USDC to vitalik.eth", [{ role: "user", content: "hi" }]);
    assert.deepEqual(held.take(), { text: "send 5 USDC to vitalik.eth", history: [{ role: "user", content: "hi" }] });
    assert.equal(held.take(), null, "not sent twice");
  });

  test("UI: account state falls back to the sign-in answer, and errors are plain sentences", () => {
    assert.deepEqual(ui.accountFrom({ emailWallet: true, hasPasskey: false }), { emailWallet: true, hasPasskey: false, verifyWith: [] });
    assert.deepEqual(ui.accountFrom(null, { emailWallet: true }), { emailWallet: true, hasPasskey: false, verifyWith: [] });
    assert.deepEqual(ui.accountFrom(null, {}), { emailWallet: false, hasPasskey: false, verifyWith: [] });
    assert.deepEqual(ui.accountFrom({ emailWallet: true, verifyWith: ["google_oauth"] }).verifyWith, ["google_oauth"]);
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
