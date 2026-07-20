// ─── Policy — behaviour-pinning tests ───
// Zero-config: run with `npm run test:policy` (executes via tsx, uses node:assert).
// These lock in the CURRENT behaviour of the extracted safety net so that later
// refactors are provably behaviour-preserving.

import assert from "node:assert/strict";
import {
  detectIntentType,
  resolveAutoApproveLimit,
  computePlanValueUsd,
  evaluatePolicy,
  decide,
  estimateUsd,
  symbolFromAddress,
  toTokenWei,
  DEFAULT_AUTO_APPROVE_LIMIT,
} from "./index";
import { WETH_SEPOLIA, USDC_SEPOLIA } from "../integrations/uniswap/types";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("policy");

// ── detectIntentType ──
test("detectIntentType: empty/unknown", () => {
  assert.equal(detectIntentType([]), "unknown");
  assert.equal(detectIntentType(undefined as any), "unknown");
  assert.equal(detectIntentType([{ action: "frobnicate" }]), "unknown");
});
test("detectIntentType: known actions", () => {
  assert.equal(detectIntentType([{ action: "swap" }]), "swap");
  assert.equal(detectIntentType([{ action: "send" }]), "send");
  assert.equal(detectIntentType([{ action: "add_liquidity" }]), "add_liquidity");
  assert.equal(detectIntentType([{ action: "balance" }]), "balance");
});

// ── resolveAutoApproveLimit ──
test("resolveAutoApproveLimit: positive number honoured", () => {
  assert.equal(resolveAutoApproveLimit(5), 5);
  assert.equal(resolveAutoApproveLimit(2500), 2500);
});
test("resolveAutoApproveLimit: invalid → default", () => {
  assert.equal(resolveAutoApproveLimit(0), DEFAULT_AUTO_APPROVE_LIMIT);
  assert.equal(resolveAutoApproveLimit(-1), DEFAULT_AUTO_APPROVE_LIMIT);
  assert.equal(resolveAutoApproveLimit(undefined), DEFAULT_AUTO_APPROVE_LIMIT);
  assert.equal(resolveAutoApproveLimit("50"), DEFAULT_AUTO_APPROVE_LIMIT);
});

// ── estimateUsd / symbolFromAddress ──
test("estimateUsd: stub prices", () => {
  assert.equal(estimateUsd("USDC", 100), 100);
  assert.equal(estimateUsd("usdt", 5), 5);
  assert.equal(estimateUsd("ETH", 0.01), 25);
  assert.equal(estimateUsd("WETH", 1), 2500);
  assert.equal(estimateUsd("MYSTERY", 7), 7);
});
test("symbolFromAddress: known + fallback", () => {
  assert.equal(symbolFromAddress(WETH_SEPOLIA), "ETH");
  assert.equal(symbolFromAddress(USDC_SEPOLIA), "USDC");
  assert.equal(symbolFromAddress("0xdead", "ETH"), "ETH");
});
test("toTokenWei: decimals per token", () => {
  assert.equal(toTokenWei("1", USDC_SEPOLIA).toString(), "1000000");        // 6 dp
  assert.equal(toTokenWei("1", WETH_SEPOLIA).toString(), "1000000000000000000"); // 18 dp
  assert.equal(toTokenWei("1", "0xunknown").toString(), "1000000000000000000"); // default 18
});

// ── computePlanValueUsd ──
test("computePlanValueUsd: swap uses input token", () => {
  assert.equal(computePlanValueUsd("swap", { symbolIn: "USDC", amount: "2" }, 9999), 2);
  assert.equal(computePlanValueUsd("swap", { symbolIn: "ETH", amount: "0.01" }, 9999), 25);
  // symbol derived from tokenIn when symbolIn absent
  assert.equal(computePlanValueUsd("swap", { tokenIn: WETH_SEPOLIA, amount: "1" }, 0), 2500);
});
test("computePlanValueUsd: send", () => {
  assert.equal(computePlanValueUsd("send", { symbol: "USDC", amount: "5" }, 0), 5);
  assert.equal(computePlanValueUsd("send", { amount: "1" }, 0), 2500); // defaults to ETH
});
test("computePlanValueUsd: other → fallback", () => {
  assert.equal(computePlanValueUsd("balance", {}, 0), 0);
  assert.equal(computePlanValueUsd("add_liquidity", {}, 42), 42);
  assert.equal(computePlanValueUsd("unknown", {}, undefined as any), 0);
});

// ── evaluatePolicy (the safety net) ──
test("evaluatePolicy: balance → INFO", () => {
  const r = evaluatePolicy({ intentType: "balance", valueUsd: 0, autoApproveLimit: 100, aiVerdict: "NEEDS_APPROVAL", aiRiskScore: 50 });
  assert.equal(r.verdict, "INFO");
  assert.equal(r.riskScore, 0);
  assert.equal(r.override, null);
});
test("evaluatePolicy: override AUTO_EXECUTE → NEEDS_APPROVAL when over limit", () => {
  const r = evaluatePolicy({ intentType: "swap", valueUsd: 500, autoApproveLimit: 5, aiVerdict: "AUTO_EXECUTE", aiRiskScore: 10 });
  assert.equal(r.verdict, "NEEDS_APPROVAL");
  assert.equal(r.riskScore, 70);
  assert.match(r.override!, /AUTO_EXECUTE → NEEDS_APPROVAL/);
});
test("evaluatePolicy: override NEEDS_APPROVAL → AUTO_EXECUTE when under limit", () => {
  const r = evaluatePolicy({ intentType: "send", valueUsd: 3, autoApproveLimit: 100, aiVerdict: "NEEDS_APPROVAL", aiRiskScore: 80 });
  assert.equal(r.verdict, "AUTO_EXECUTE");
  assert.equal(r.riskScore, 15);
  assert.match(r.override!, /NEEDS_APPROVAL → AUTO_EXECUTE/);
});
test("evaluatePolicy: no override when AI already agrees", () => {
  const under = evaluatePolicy({ intentType: "swap", valueUsd: 3, autoApproveLimit: 100, aiVerdict: "AUTO_EXECUTE", aiRiskScore: 12 });
  assert.equal(under.verdict, "AUTO_EXECUTE");
  assert.equal(under.riskScore, 12);
  assert.equal(under.override, null);

  const over = evaluatePolicy({ intentType: "swap", valueUsd: 500, autoApproveLimit: 5, aiVerdict: "NEEDS_APPROVAL", aiRiskScore: 60 });
  assert.equal(over.verdict, "NEEDS_APPROVAL");
  assert.equal(over.riskScore, 60);
  assert.equal(over.override, null);
});
test("evaluatePolicy: boundary — value equal to limit auto-executes", () => {
  const r = evaluatePolicy({ intentType: "swap", valueUsd: 100, autoApproveLimit: 100, aiVerdict: "NEEDS_APPROVAL", aiRiskScore: 50 });
  assert.equal(r.verdict, "AUTO_EXECUTE");
});
test("evaluatePolicy: unknown/add_liquidity pass through untouched", () => {
  const r = evaluatePolicy({ intentType: "add_liquidity", valueUsd: 9999, autoApproveLimit: 5, aiVerdict: "NEEDS_APPROVAL", aiRiskScore: 55 });
  assert.equal(r.verdict, "NEEDS_APPROVAL");
  assert.equal(r.riskScore, 55);
  assert.equal(r.override, null);
});

// ── decide (STEP 2 — authoritative deterministic verdict) ──
const okPlan = { summary: "Swap 0.01 WETH for USDC", steps: [{ action: "swap", params: {} }] };

test("decide: balance → INFO", () => {
  const d = decide({ intentType: "balance", valueUsd: 0, autoApproveLimit: 100, plan: { summary: "Portfolio", steps: [] } });
  assert.equal(d.verdict, "INFO");
  assert.equal(d.riskScore, 0);
  assert.equal(d.requiresLedger, false);
});
test("decide: under limit → AUTO_EXECUTE", () => {
  const d = decide({ intentType: "swap", valueUsd: 25, autoApproveLimit: 100, plan: okPlan });
  assert.equal(d.verdict, "AUTO_EXECUTE");
  assert.equal(d.riskScore, 15);
  assert.equal(d.requiresLedger, false);
});
test("decide: over limit → NEEDS_APPROVAL + requiresLedger", () => {
  const d = decide({ intentType: "swap", valueUsd: 500, autoApproveLimit: 5, plan: okPlan });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.equal(d.riskScore, 70);
  assert.equal(d.requiresLedger, true);
  assert.match(d.reason, /exceeds/);
});
test("decide: boundary — value equal to limit auto-executes", () => {
  const d = decide({ intentType: "send", valueUsd: 100, autoApproveLimit: 100, plan: { summary: "send", steps: [{ action: "send" }] } });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});
test("decide: missing summary → BLOCKED", () => {
  const d = decide({ intentType: "swap", valueUsd: 10, autoApproveLimit: 100, plan: { steps: [{ action: "swap" }] } });
  assert.equal(d.verdict, "BLOCKED");
  assert.equal(d.riskScore, 100);
});
test("decide: value-bearing intent with no steps → BLOCKED", () => {
  const d = decide({ intentType: "swap", valueUsd: 10, autoApproveLimit: 100, plan: { summary: "swap", steps: [] } });
  assert.equal(d.verdict, "BLOCKED");
  assert.match(d.reason, /no executable steps/);
});
test("decide: unknown intent → fail closed NEEDS_APPROVAL", () => {
  const d = decide({ intentType: "unknown", valueUsd: 0, autoApproveLimit: 100, plan: { summary: "???", steps: [] } });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.equal(d.requiresLedger, true);
});
test("decide: add_liquidity respects limit", () => {
  const plan = { summary: "add liq", steps: [{ action: "add_liquidity", params: {} }] };
  assert.equal(decide({ intentType: "add_liquidity", valueUsd: 3, autoApproveLimit: 100, plan }).verdict, "AUTO_EXECUTE");
  assert.equal(decide({ intentType: "add_liquidity", valueUsd: 300, autoApproveLimit: 100, plan }).verdict, "NEEDS_APPROVAL");
});

console.log(`\n${passed} passed`);
