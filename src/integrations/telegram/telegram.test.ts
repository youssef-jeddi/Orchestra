// ─── Telegram — link-signature tests (Telegram API stubbed, no network) ───
// Run with `npm run test:telegram`.

import assert from "node:assert/strict";
import { ethers } from "ethers";

process.env.TELEGRAM_BOT_TOKEN = "test-token";
// Stub the Bot API and record what's sent.
const sent: { method: string; body: any }[] = [];
globalThis.fetch = (async (url: string, init: any) => {
  const method = String(url).split("/").pop()!;
  sent.push({ method, body: JSON.parse(init?.body || "{}") });
  return {
    status: 200,
    json: async () => ({ ok: true, result: method === "getMe" ? { username: "orchestra_test_bot" } : { message_id: 42 } }),
  };
}) as any;

import { linkRequest, confirmLink, sendApprovalMessage } from "./index";

const owner = ethers.Wallet.createRandom();
const attacker = ethers.Wallet.createRandom();

/** Sign the typed data the way eth_signTypedData_v4 would (ethers drops EIP712Domain itself). */
async function sign(wallet: ethers.HDNodeWallet, typedData: any): Promise<string> {
  const { EIP712Domain, ...types } = typedData.types;
  return wallet.signTypedData(typedData.domain, types, typedData.message);
}

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("link: the wallet's own signature returns the deep link", async () => {
  const { code, typedData } = linkRequest(owner.address);
  assert.equal(typedData.message.wallet, owner.address);
  assert.equal(typedData.message.code, code);
  assert.ok(typedData.types.EIP712Domain, "MetaMask v4 needs EIP712Domain in types");
  const { url } = await confirmLink(owner.address, code, await sign(owner, typedData));
  assert.equal(url, `https://t.me/orchestra_test_bot?start=${code}`);
});

test("link: someone else's signature is refused", async () => {
  const { code, typedData } = linkRequest(owner.address);
  await assert.rejects(confirmLink(owner.address, code, await sign(attacker, typedData)), /doesn't match this wallet/);
});

test("link: a code issued for another wallet can't be claimed", async () => {
  const { code, typedData } = linkRequest(owner.address);
  await assert.rejects(confirmLink(attacker.address, code, await sign(attacker, typedData)), /expired/);
});

test("link: unknown code is refused", async () => {
  await assert.rejects(confirmLink(owner.address, "nope", "0x"), /expired/);
});

test("approval message: basic mode has Approve + Reject buttons", async () => {
  sent.length = 0;
  assert.equal(await sendApprovalMessage(7, "id-1", "<b>x</b>"), 42);
  const kb = sent[0].body.reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.map((b: any) => b.callback_data), ["a:id-1", "r:id-1"]);
});

test("approval message: phone-passkey mode has only the review link and Reject — no Approve", async () => {
  sent.length = 0;
  await sendApprovalMessage(7, "id-2", "<b>x</b>", "https://app.example.com/phone/approve/id-2?t=secret");
  const kb = sent[0].body.reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb, [
    { text: "🔐 Review & approve", url: "https://app.example.com/phone/approve/id-2?t=secret" },
    { text: "✖️ Reject", callback_data: "r:id-2" },
  ]);
  assert.ok(!kb.some((b: any) => String(b.callback_data).startsWith("a:")));
});

(async () => {
  console.log("telegram");
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
