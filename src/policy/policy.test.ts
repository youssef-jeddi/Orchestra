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

// ── decide: extended policy rules (Axis-3) ──
const swapPlan = (tokenIn: string, tokenOut: string) => ({
  summary: "swap",
  steps: [{ action: "swap", params: { tokenIn, tokenOut } }],
});
const sendPlan = (to: string) => ({ summary: "send", steps: [{ action: "send", params: { to } }] });

test("decide: base behaviour unchanged when no profile/history", () => {
  const d = decide({ intentType: "swap", valueUsd: 25, autoApproveLimit: 100, plan: okPlan });
  assert.equal(d.verdict, "AUTO_EXECUTE");
  assert.deepEqual(d.triggered, []);
});

test("decide: unverified token → escalates", () => {
  const d = decide({
    intentType: "swap", valueUsd: 10, autoApproveLimit: 100,
    plan: swapPlan(WETH_SEPOLIA, "0xBADtoken"),
    profile: { verifiedTokens: [WETH_SEPOLIA, USDC_SEPOLIA] },
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["unverified-token"]);
});
test("decide: verified token under limit → AUTO_EXECUTE", () => {
  const d = decide({
    intentType: "swap", valueUsd: 10, autoApproveLimit: 100,
    plan: swapPlan(WETH_SEPOLIA, USDC_SEPOLIA),
    profile: { verifiedTokens: [WETH_SEPOLIA, USDC_SEPOLIA] },
  });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});

test("decide: unknown recipient → escalates (send)", () => {
  const known = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const d = decide({
    intentType: "send", valueUsd: 5, autoApproveLimit: 100,
    plan: sendPlan("0xStranger"), profile: { knownAddresses: [known] },
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["unknown-recipient"]);
});
test("decide: known recipient (case-insensitive) → AUTO_EXECUTE", () => {
  const known = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const d = decide({
    intentType: "send", valueUsd: 5, autoApproveLimit: 100,
    plan: sendPlan(known.toLowerCase()), profile: { knownAddresses: [known] },
  });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});

test("decide: daily USD velocity cap → escalates", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const history = [
    { valueUsd: 40, at: "2026-07-20T09:00:00Z" },
    { valueUsd: 40, at: "2026-07-20T10:00:00Z" },
  ];
  const d = decide({
    intentType: "swap", valueUsd: 30, autoApproveLimit: 100, plan: okPlan,
    profile: { dailyLimitUsd: 100 }, history, now,
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL"); // 80 + 30 > 100
  assert.deepEqual(d.triggered, ["daily-usd-velocity"]);
});
test("decide: velocity ignores activity older than 24h", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const history = [{ valueUsd: 500, at: "2026-07-18T12:00:00Z" }]; // 2 days old
  const d = decide({
    intentType: "swap", valueUsd: 30, autoApproveLimit: 100, plan: okPlan,
    profile: { dailyLimitUsd: 100 }, history, now,
  });
  assert.equal(d.verdict, "AUTO_EXECUTE"); // old spend excluded
});
test("decide: daily count velocity cap → escalates", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const history = [
    { valueUsd: 1, at: "2026-07-20T09:00:00Z" },
    { valueUsd: 1, at: "2026-07-20T10:00:00Z" },
    { valueUsd: 1, at: "2026-07-20T11:00:00Z" },
  ];
  const d = decide({
    intentType: "swap", valueUsd: 1, autoApproveLimit: 100, plan: okPlan,
    profile: { maxAutoTxPerDay: 3 }, history, now,
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["daily-count-velocity"]);
});

test("decide: habit anomaly → escalates", () => {
  const d = decide({
    intentType: "swap", valueUsd: 600, autoApproveLimit: 1000, plan: okPlan,
    profile: { typicalMaxUsd: 50 }, // 600 > 50*10
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["habit-anomaly"]);
});
test("decide: within habit range → AUTO_EXECUTE", () => {
  const d = decide({
    intentType: "swap", valueUsd: 400, autoApproveLimit: 1000, plan: okPlan,
    profile: { typicalMaxUsd: 50 }, // 400 < 50*10
  });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});

test("decide: multiple escalations combine, max risk + all rules", () => {
  const d = decide({
    intentType: "send", valueUsd: 5000, autoApproveLimit: 100,
    plan: sendPlan("0xStranger"),
    profile: { knownAddresses: ["0xknown"], typicalMaxUsd: 10 },
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.equal(d.riskScore, 70); // max(over-limit 70, unknown-recipient 60, habit 55)
  assert.ok(d.triggered.includes("over-limit"));
  assert.ok(d.triggered.includes("unknown-recipient"));
  assert.ok(d.triggered.includes("habit-anomaly"));
});
test("decide: escalation never weakens a block/info", () => {
  // denylist still wins even with a permissive profile
  const d = decide({
    intentType: "swap", valueUsd: 1, autoApproveLimit: 100,
    plan: okPlan, profile: { verifiedTokens: [], dailyLimitUsd: 999999 },
  });
  assert.equal(d.verdict, "AUTO_EXECUTE"); // empty verifiedTokens disables that rule
});

console.log(`\n${passed} passed`);
