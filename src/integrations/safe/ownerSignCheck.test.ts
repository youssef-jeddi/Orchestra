// ─── Safe — the browser's check of an owner-sign transaction before the wallet opens (ORC-113) ───
// Run with `npm run test:owner-sign-check`. The bridge builds the Safe transaction the owner signs
// for a request over the daily ceiling; a hacked bridge could word it as a payment while it adds an
// owner, enables a module or DelegateCalls. These tests perform each of those and check /simple
// refuses it, and that a real payment the bridge holds is shown and signed exactly as decoded.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { holdOwnerSign, ownerSignView, submitOwnerSignature, clearOwnerSignRecords, tamperedCall } from "./ownerSign";
import { faultOn } from "../../utils/faultInject";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { checkOwnerSign, NOT_A_PAYMENT, REFUSED, SEPOLIA_CHAIN_ID } from "../../../frontend/src/lib/ownerSignCheck.js";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { ownerSignCard } from "../../../frontend/src/lib/ownerSign.js";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { signOwnerRequest } from "../../../frontend/src/lib/signing.js";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const SAFE = "0x00000000000000000000000000000000000000D4";
const OTHER_SAFE = "0x00000000000000000000000000000000000000D5";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const UNKNOWN_TOKEN = "0x00000000000000000000000000000000000000AB";
const BOB = "0x00000000000000000000000000000000000000B0";
const MULTISEND = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2"; // Safe's MultiSendCallOnly 1.4.1
const owner = ethers.Wallet.createRandom();

const erc20 = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
]);
const safeAdmin = new ethers.Interface([
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function changeThreshold(uint256 _threshold)",
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function setGuard(address guard)",
  "function setFallbackHandler(address handler)",
]);
const multiSend = new ethers.Interface(["function multiSend(bytes transactions)"]);

type Call = { to: string; value: string; data: string; operation: number; nonce: number };
const ethSend = (to = BOB, value = ethers.parseEther("0.5").toString()): Call => ({ to, value, data: "0x", operation: 0, nonce: 3 });
const usdcSend = (to = BOB, amount = 2000_000000n): Call => ({ to: USDC, value: "0", data: erc20.encodeFunctionData("transfer", [to, amount]), operation: 0, nonce: 3 });

/** The offer exactly as the bridge returns it for `call` (its real holdOwnerSign / ownerSignView). */
function offerFor(call: Call, claim: { to?: string; amount?: string; symbol?: string } = {}) {
  return JSON.parse(JSON.stringify(ownerSignView(holdOwnerSign({ wallet: owner.address, safeAddress: SAFE, summary: "Send 2000 USDC to Bob", call, ...claim }))));
}
/** The same offer with fields of the held message changed after the fact (what a tampered bridge sends). */
function tampered(call: Call, edit: (m: any, o: any) => void) {
  const o = offerFor(call);
  edit(o.typedData.message, o);
  return o;
}
const check = (o: any, safeAddress: string | undefined = SAFE) => checkOwnerSign(o, { safeAddress });
const refusedWith = (o: any, reason: string, safeAddress?: string) => {
  const r = check(o, safeAddress);
  assert.equal(r.ok, false, `expected refusal ${reason}`);
  assert.equal(r.reason, reason);
  assert.equal(r.message, NOT_A_PAYMENT);
};

// ─── What a real payment looks like ───

test("an ETH payment the bridge holds is decoded: real amount and recipient, the bridge's own hash", () => {
  const o = offerFor(ethSend(), { to: BOB, amount: "0.5", symbol: "ETH" });
  const r = check(o);
  assert.equal(r.ok, true);
  assert.equal(r.payment.symbol, "ETH");
  assert.equal(r.payment.amount, "0.5");
  assert.equal(r.payment.to, ethers.getAddress(BOB));
  assert.equal(r.safeTxHash, o.safeTxHash, "the hash computed here matches what the server stored");
  assert.match(r.text, /send 0\.5 ETH from your account to 0x0000…00B0/);
});

test("a USDC payment is decoded with USDC's 6 decimals, not the bridge's wording", () => {
  const r = check(offerFor(usdcSend(), { to: BOB, amount: "2000", symbol: "USDC" }));
  assert.equal(r.ok, true);
  assert.equal(r.payment.symbol, "USDC");
  assert.equal(r.payment.amount, "2000");
  assert.equal(r.payment.token, ethers.getAddress(USDC));
  assert.equal(r.payment.to, ethers.getAddress(BOB));
});

test("the typed data handed to the wallet is rebuilt here (Sepolia, this page's account) and hashes the same", () => {
  const o = offerFor(usdcSend());
  o.typedData.types = { SafeTx: [{ name: "to", type: "address" }] }; // the bridge's types are never used
  o.safeTxHash = undefined;
  const r = check(o);
  assert.equal(r.ok, true);
  assert.deepEqual(r.typedData.domain, { chainId: SEPOLIA_CHAIN_ID, verifyingContract: ethers.getAddress(SAFE) });
  assert.ok(r.typedData.types.EIP712Domain, "eth_signTypedData_v4 needs the domain type");
  const { EIP712Domain, ...types } = r.typedData.types;
  assert.equal(ethers.TypedDataEncoder.hash(r.typedData.domain, types, r.typedData.message), r.safeTxHash);
  assert.equal(r.safeTxHash, offerFor(usdcSend()).safeTxHash, "same transaction, same hash as the server's");
});

test("a signature over what the browser rebuilt is accepted by the server for the held request", async () => {
  clearOwnerSignRecords();
  const o = offerFor(usdcSend());
  const r = check(o);
  const { EIP712Domain, ...types } = r.typedData.types;
  const sig = await owner.signTypedData(r.typedData.domain, types, r.typedData.message);
  const out = await submitOwnerSignature(owner.address, o.id, sig, { relay: async () => "0xabc" });
  assert.equal(out.txHash, "0xabc");
});

// ─── Calls to the account itself: its admin functions ───

const adminCalls: [string, string][] = [
  ["addOwnerWithThreshold", safeAdmin.encodeFunctionData("addOwnerWithThreshold", [BOB, 1])],
  ["removeOwner", safeAdmin.encodeFunctionData("removeOwner", ["0x0000000000000000000000000000000000000001", owner.address, 1])],
  ["swapOwner", safeAdmin.encodeFunctionData("swapOwner", ["0x0000000000000000000000000000000000000001", owner.address, BOB])],
  ["changeThreshold", safeAdmin.encodeFunctionData("changeThreshold", [1])],
  ["enableModule", safeAdmin.encodeFunctionData("enableModule", [BOB])],
  ["disableModule", safeAdmin.encodeFunctionData("disableModule", ["0x0000000000000000000000000000000000000001", BOB])],
  ["setGuard", safeAdmin.encodeFunctionData("setGuard", [BOB])],
  ["setFallbackHandler", safeAdmin.encodeFunctionData("setFallbackHandler", [BOB])],
];
for (const [name, data] of adminCalls) {
  test(`${name} on the account is refused, even worded as "Send 2000 USDC to Bob"`, () => {
    refusedWith(offerFor({ to: SAFE, value: "0", data, operation: 0, nonce: 3 }, { to: BOB, amount: "2000", symbol: "USDC" }), REFUSED.callsAccount);
  });
}

test("any call to the account is refused, even with an empty payload (ETH to itself) or a lowercase address", () => {
  refusedWith(offerFor({ to: SAFE.toLowerCase(), value: "1", data: "0x", operation: 0, nonce: 3 }), REFUSED.callsAccount);
});

test("the dev-only tampered offer (owner-sign-tamper) is refused, and that fault is off in production", () => {
  refusedWith(offerFor(tamperedCall(SAFE, usdcSend()), { to: BOB, amount: "2000", symbol: "USDC" }), REFUSED.callsAccount);
  assert.equal(faultOn("owner-sign-tamper", { ORCHESTRA_FAULT_INJECT: "owner-sign-tamper", STORAGE_BACKEND: "memory" } as any), true);
  assert.equal(faultOn("owner-sign-tamper", { ORCHESTRA_FAULT_INJECT: "owner-sign-tamper", NODE_ENV: "production" } as any), false);
  assert.equal(faultOn("owner-sign-tamper", {} as any), false, "off by default");
});

// ─── DelegateCall and MultiSend ───

test("a DelegateCall is refused, whatever it calls (here a MultiSend wrapping a plain USDC payment)", () => {
  const inner = usdcSend();
  const packed = ethers.solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, inner.to, 0, ethers.dataLength(inner.data), inner.data]);
  const data = multiSend.encodeFunctionData("multiSend", [packed]);
  refusedWith(offerFor({ to: MULTISEND, value: "0", data, operation: 1, nonce: 3 }), REFUSED.delegateCall);
  refusedWith(tampered(usdcSend(), (m) => { m.operation = 1; }), REFUSED.delegateCall);
});

test("a MultiSend as a plain call is refused too: it's not a payment shape", () => {
  refusedWith(offerFor({ to: MULTISEND, value: "0", data: multiSend.encodeFunctionData("multiSend", ["0x"]), operation: 0, nonce: 3 }), REFUSED.unknownCall);
});

// ─── Gas refund fields: Safe pays them out of the account ───

for (const [field, value] of [["gasPrice", "1"], ["safeTxGas", "100000"], ["baseGas", "50000"],
  ["refundReceiver", BOB], ["gasToken", USDC]] as const) {
  test(`a nonzero ${field} is refused (a refund the account would pay)`, () => {
    refusedWith(tampered(usdcSend(), (m) => { m[field] = value; }), REFUSED.gasRefund);
  });
}

// ─── Only a plain ETH or known-token transfer ───

test("an ERC-20 approve is refused (it would let someone else take the tokens later)", () => {
  refusedWith(offerFor({ to: USDC, value: "0", data: erc20.encodeFunctionData("approve", [BOB, ethers.MaxUint256]), operation: 0, nonce: 3 }), REFUSED.unknownCall);
});

test("transferFrom and other functions are refused", () => {
  refusedWith(offerFor({ to: USDC, value: "0", data: erc20.encodeFunctionData("transferFrom", [SAFE, BOB, 1n]), operation: 0, nonce: 3 }), REFUSED.unknownCall);
  refusedWith(offerFor({ to: BOB, value: "0", data: "0xdeadbeef", operation: 0, nonce: 3 }), REFUSED.unknownCall);
});

test("a transfer of an unknown token is refused rather than shown as a raw contract", () => {
  refusedWith(offerFor({ ...usdcSend(), to: UNKNOWN_TOKEN }), REFUSED.unknownToken);
});

test("ETH attached to a token call, or extra bytes after a transfer, are refused", () => {
  refusedWith(offerFor({ ...usdcSend(), value: "1" }), REFUSED.unknownCall);
  refusedWith(offerFor({ ...usdcSend(), data: usdcSend().data + "00".repeat(32) }), REFUSED.unknownCall);
});

test("a transfer whose address word has dirty high bits is refused (it reads differently elsewhere)", () => {
  const d = usdcSend().data;
  const dirty = d.slice(0, 10) + "ff" + d.slice(12);
  refusedWith(offerFor({ ...usdcSend(), data: dirty }), REFUSED.malformed);
});

test("nothing to pay (0 ETH, 0 tokens) is refused", () => {
  refusedWith(offerFor(ethSend(BOB, "0")), REFUSED.nothingSent);
  refusedWith(offerFor(usdcSend(BOB, 0n)), REFUSED.nothingSent);
});

test("paying the account itself or the zero address is refused", () => {
  refusedWith(offerFor(usdcSend(SAFE)), REFUSED.badRecipient);
  refusedWith(offerFor(usdcSend(ethers.ZeroAddress)), REFUSED.badRecipient);
});

// ─── The domain: which chain, which account ───

test("a signature for another chain or another account is refused", () => {
  refusedWith(tampered(usdcSend(), (_m, o) => { o.typedData.domain.chainId = 1; }), REFUSED.wrongChain);
  refusedWith(tampered(usdcSend(), (_m, o) => { o.typedData.domain.verifyingContract = OTHER_SAFE; }), REFUSED.wrongAccount);
  refusedWith(offerFor(usdcSend()), REFUSED.wrongAccount, OTHER_SAFE);
  refusedWith(offerFor(usdcSend()), REFUSED.wrongAccount, "");
});

test("a malformed offer is refused", () => {
  refusedWith({}, REFUSED.malformed);
  refusedWith(tampered(usdcSend(), (m) => { m.value = "-1"; }), REFUSED.malformed);
  refusedWith(tampered(usdcSend(), (m) => { m.to = "bob"; }), REFUSED.malformed);
  refusedWith(tampered(usdcSend(), (m) => { m.data = "0x123"; }), REFUSED.malformed);
  refusedWith(tampered(usdcSend(), (m) => { delete m.nonce; }), REFUSED.malformed);
});

// ─── What the bridge says vs what the transaction does ───

test("a bridge hash that isn't the hash of these fields is refused", () => {
  refusedWith(tampered(usdcSend(), (_m, o) => { o.safeTxHash = ethers.ZeroHash; }), REFUSED.hashMismatch);
  // Changing the recipient inside the message without updating the bridge's hash.
  refusedWith(tampered(usdcSend(), (m) => { m.data = usdcSend(OTHER_SAFE).data; }), REFUSED.hashMismatch);
});

test("a claim that doesn't match the decoded payment is refused (recipient, amount, token)", () => {
  refusedWith(offerFor(usdcSend(), { to: OTHER_SAFE, amount: "2000", symbol: "USDC" }), REFUSED.claimMismatch);
  refusedWith(offerFor(usdcSend(), { to: BOB, amount: "20", symbol: "USDC" }), REFUSED.claimMismatch);
  refusedWith(offerFor(usdcSend(), { to: BOB, amount: "2000", symbol: "ETH" }), REFUSED.claimMismatch);
  refusedWith(offerFor(ethSend(), { to: BOB, amount: "0.5", symbol: "USDC" }), REFUSED.claimMismatch);
  assert.equal(check(offerFor(ethSend(), { to: BOB.toLowerCase(), amount: "0.50", symbol: "eth" })).ok, true, "same values, other spelling");
});

// ─── What /simple shows and does ───

test("the chat card: decoded text and a Sign button, or the plain refusal and no button", () => {
  const ok = ownerSignCard(offerFor(usdcSend()), SAFE);
  assert.equal(ok.canSign, true);
  assert.match(ok.text, /2000 USDC/);
  const bad = ownerSignCard(offerFor(tamperedCall(SAFE, usdcSend())), SAFE);
  assert.deepEqual(bad, { canSign: false, refused: true, text: NOT_A_PAYMENT });
  assert.equal(ownerSignCard(offerFor(usdcSend()), undefined).canSign, false, "no account yet: nothing to sign");
  assert.equal(ownerSignCard(null, SAFE), null);
  assert.doesNotMatch(NOT_A_PAYMENT, /delegate|module|safe|calldata|0x/i, "no jargon");
});

/** A wallet that records whether it was ever asked to sign. */
function fakeWallet() {
  const asked: any[] = [];
  return { asked, ledger: { connectionType: "ledger", signTyped: async (td: any) => { asked.push(td); const { EIP712Domain, ...types } = td.types; return owner.signTypedData(td.domain, types, td.message); } } };
}
const who = { emailWallet: false, hasPasskey: false };

test("a refused offer never opens the wallet: signOwnerRequest throws the plain message first", async () => {
  const { asked, ledger } = fakeWallet();
  await assert.rejects(signOwnerRequest(ledger, offerFor(tamperedCall(SAFE, usdcSend())), who, SAFE), { message: NOT_A_PAYMENT });
  await assert.rejects(signOwnerRequest(ledger, offerFor(usdcSend()), who, OTHER_SAFE), { message: NOT_A_PAYMENT });
  assert.equal(asked.length, 0);
});

test("an accepted offer: the wallet is handed the rebuilt typed data and only the signature goes to the bridge", async () => {
  const { asked, ledger } = fakeWallet();
  const o = offerFor(usdcSend());
  o.typedData.types = { SafeTx: [] }; // whatever the bridge sent as types, the wallet gets ours
  const posted: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ txHash: "0xabc" }) } as any;
  }) as any;
  try {
    const out = await signOwnerRequest(ledger, o, who, SAFE);
    assert.equal(out.txHash, "0xabc");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(asked.length, 1);
  assert.equal(asked[0].primaryType, "SafeTx");
  assert.ok(asked[0].types.EIP712Domain);
  assert.equal(asked[0].types.SafeTx.length, 10);
  assert.deepEqual(Object.keys(posted[0].body), ["signature"]);
  assert.match(posted[0].url, new RegExp(`/owner-sign/${o.id}/submit$`));
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
