// ─── Approvals — store tests (no network) ───
// Run with `npm run test:approvals`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { describeApproval, reviewOf } from "./describe";
import { USDC_SEPOLIA } from "../integrations/uniswap/types";
import {
  createApproval,
  getApproval,
  requirePending,
  claim,
  reject,
  settle,
  challengeBytes,
  issueReviewToken,
  approvalForReview,
  canonicalJson,
  hashExecution,
  approvalView,
  ApprovalError,
  APPROVAL_TTL_MS,
  _resetApprovals,
  type NewApproval,
} from "./index";

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
  execution: { sendData: { unsignedTx: { to: "0xUSDC", data: "0xa9059cbb", value: "0" }, amount: "150" } },
  ...over,
});

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);
const code = (fn: () => void) => {
  try { fn(); } catch (e) { return e instanceof ApprovalError ? e.status : -1; }
  return 0;
};

test("canonicalJson: key order doesn't change the hash", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(hashExecution({ x: 1, y: 2 }), hashExecution({ y: 2, x: 1 }));
  assert.notEqual(hashExecution({ x: 1 }), hashExecution({ x: 2 }));
});

test("create: pending, lowercased wallet, hash of the execution payload", () => {
  const a = createApproval(base());
  assert.equal(a.status, "pending");
  assert.equal(a.wallet, WALLET.toLowerCase());
  assert.equal(a.hash, hashExecution(base().execution));
  assert.equal(getApproval(a.id), a);
});

test("requirePending: unknown id / other wallet / wrong status", () => {
  const a = createApproval(base());
  assert.equal(code(() => requirePending("nope", WALLET)), 404);
  assert.equal(code(() => requirePending(a.id, OTHER)), 403);
  assert.equal(code(() => requirePending(a.id, WALLET.toUpperCase().replace("0X", "0x"))), 0); // case-insensitive
  reject(a.id, WALLET);
  assert.equal(code(() => requirePending(a.id, WALLET)), 409);
});

test("claim: only one approver wins; the challenge is cleared", () => {
  const a = createApproval(base());
  a.challenge = "abc";
  claim(a.id, WALLET);
  assert.equal(a.status, "executing");
  assert.equal(a.challenge, undefined);
  assert.equal(code(() => claim(a.id, WALLET)), 409);
});

test("expiry: a lapsed approval can't be claimed", () => {
  const t0 = 1_000_000;
  const a = createApproval(base(), t0);
  assert.equal(code(() => claim(a.id, WALLET, t0 + APPROVAL_TTL_MS + 1)), 409);
  assert.equal(getApproval(a.id)!.status, "expired");
});

test("challengeBytes: 32 bytes, fresh each time", () => {
  const a = createApproval(base());
  const c1 = challengeBytes(a);
  const c2 = challengeBytes(a);
  assert.equal(c1.length, 32);
  assert.notDeepEqual(c1, c2);
});

test("settle + view: result exposed, execution payload is not", () => {
  const a = createApproval(base());
  claim(a.id, WALLET);
  settle(a, { result: { txHash: "0xabc", explorerUrl: "https://x" } });
  const v = approvalView(a) as any;
  assert.equal(v.status, "executed");
  assert.equal(v.txHash, "0xabc");
  assert.equal(v.execution, undefined);

  const b = createApproval(base());
  claim(b.id, WALLET);
  settle(b, { error: "reverted" });
  assert.equal(b.status, "failed");
  assert.equal((approvalView(b) as any).error, "reverted");
});

// ── describeApproval: decoded from the payload, not the summary ──
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const transfer = new ethers.Interface(["function transfer(address to, uint256 amount)"]);

test("describe: ERC-20 send is decoded from the calldata, ignoring the summary", () => {
  const a = createApproval(base({
    summary: "Send 5 USDC to alice.eth", // a lying summary must not reach the phone
    execution: { sendData: { unsignedTx: { to: USDC_SEPOLIA, value: "0", data: transfer.encodeFunctionData("transfer", [VITALIK, 150_000_000n]) } } },
  }));
  const html = describeApproval(a);
  assert.match(html, /<b>Send 150 USDC<\/b>/);
  assert.match(html, new RegExp(`to <code>${VITALIK}</code>`));
  assert.match(html, /over your daily auto-approve limit/);
  assert.doesNotMatch(html, /alice/);
});

test("describe: native ETH send shows the value and full recipient", () => {
  const a = createApproval(base({ execution: { sendData: { unsignedTx: { to: VITALIK.toLowerCase(), value: "500000000000000000", data: "0x" } } } }));
  const html = describeApproval(a);
  assert.match(html, /<b>Send 0\.5 ETH<\/b>/);
  assert.match(html, new RegExp(VITALIK)); // checksummed
});

test("describe: swap shows exact input, expected output and the market guard", () => {
  const a = createApproval(base({
    intentType: "swap",
    execution: { quoteData: { tokenIn: USDC_SEPOLIA, tokenOut: "0x0000000000000000000000000000000000000000", amount: "10000000", expectedOut: 0.00372 } },
  }));
  const html = describeApproval(a);
  assert.match(html, /Swap 10 USDC → ETH/);
  assert.match(html, /You spend exactly 10 USDC/);
  assert.match(html, /≈ 0\.00372 ETH \(refused if more than 5% below market\)/);
});

test("describe: an undecodable payload is flagged, never summarised", () => {
  const a = createApproval(base({ execution: { sendData: { unsignedTx: { to: USDC_SEPOLIA, value: "0", data: "0xdeadbeef" } } } }));
  const html = describeApproval(a);
  assert.match(html, /couldn't decode this transaction/);
  assert.doesNotMatch(html, /Send 150/);
});

test("describe: HTML in the reason is escaped", () => {
  const a = createApproval(base({ triggered: [], reason: "<b>bad</b> & worse" }));
  assert.match(describeApproval(a), /&lt;b&gt;bad&lt;\/b&gt; &amp; worse/);
});

// ── Phone review links ──
test("review link: only the exact secret opens it", () => {
  const a = createApproval(base());
  assert.equal(code(() => approvalForReview(a.id, "anything")), 404); // no token issued yet
  const t = issueReviewToken(a);
  assert.equal(approvalForReview(a.id, t), a);
  assert.equal(code(() => approvalForReview(a.id, t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))), 404);
  assert.equal(code(() => approvalForReview(a.id, undefined)), 404);
  assert.equal(code(() => approvalForReview("unknown", t)), 404);
});

test("review + phone hint: structured review matches the message; the chat says to use the passkey", () => {
  const a = createApproval(base({
    execution: { sendData: { unsignedTx: { to: USDC_SEPOLIA, value: "0", data: transfer.encodeFunctionData("transfer", [VITALIK, 150_000_000n]) } } },
  }));
  const r = reviewOf(a);
  assert.equal(r.decoded, true);
  assert.equal(r.title, "Send 150 USDC");
  assert.deepEqual(r.details, [{ label: "to", value: VITALIK, mono: true }]);
  assert.equal(r.ref, a.hash.slice(2, 10));
  assert.match(describeApproval(a, { phonePasskey: true }), /confirm with your phone's passkey/);
  assert.doesNotMatch(describeApproval(a), /passkey/);
});

test("describe: add liquidity is decoded from lpData — max deposit, expected use, full range, to the Safe", () => {
  const a = createApproval(base({
    intentType: "add_liquidity",
    execution: { lpData: {
      tokenA: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", symbolA: "ETH", amountA: "10000000000000000",
      tokenB: USDC_SEPOLIA, symbolB: "USDC", amountB: "25000000",
      feeTier: 3000, usedA: 0.01, usedB: 25,
    } },
  }));
  const r = reviewOf(a);
  assert.equal(r.title, "Add liquidity: ETH/USDC 0.3%");
  assert.deepEqual(r.details.map((d) => d.value), [
    "0.01 ETH + 25 USDC",
    "0.01 ETH + 25 USDC (the rest stays in your Safe)",
    "full range (refused if the pool's price is far from market)",
    "your Safe",
  ]);
  const unknown = createApproval(base({ intentType: "add_liquidity", execution: { lpData: { tokenA: "0x0000000000000000000000000000000000000001", tokenB: USDC_SEPOLIA, feeTier: 3000 } } }));
  assert.equal(reviewOf(unknown).decoded, false);
});

test("describe: remove liquidity is decoded from lpRemoveData — position, share, back to the Safe", () => {
  const a = createApproval(base({
    intentType: "remove_liquidity",
    execution: { lpRemoveData: { tokenId: "1234", percent: 50, token0: USDC_SEPOLIA, token1: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", symbol0: "USDC", symbol1: "WETH", fee: 3000 } },
  }));
  const r = reviewOf(a);
  assert.equal(r.title, "Remove liquidity: USDC/ETH 0.3%");
  assert.deepEqual(r.details.map((d) => d.value), ["#1234", "50%", "USDC and ETH at the pool's current price, plus the fees earned", "your Safe"]);
  const bad = createApproval(base({ intentType: "remove_liquidity", execution: { lpRemoveData: { tokenId: "1234", percent: 150, token0: USDC_SEPOLIA, token1: USDC_SEPOLIA, fee: 3000 } } }));
  assert.equal(reviewOf(bad).decoded, false);
});

console.log("approvals");
for (const [name, fn] of tests) {
  _resetApprovals();
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
console.log(`\n${passed} passed`);
