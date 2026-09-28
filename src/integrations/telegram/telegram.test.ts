// ─── Telegram — link-signature tests (Telegram API stubbed, no network) ───
// Run with `npm run test:telegram`.

import assert from "node:assert/strict";
import { ethers } from "ethers";

process.env.TELEGRAM_BOT_TOKEN = "test-token";
// Stub the Bot API: only getMe is reached by these tests.
globalThis.fetch = (async () => ({
  status: 200,
  json: async () => ({ ok: true, result: { username: "orchestra_test_bot" } }),
})) as any;

import { linkRequest, confirmLink } from "./index";

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
