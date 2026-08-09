// ─── Policy — behaviour-pinning tests ───
// Zero-config: run with `npm run test:policy` (executes via tsx, uses node:assert).
// The single spending control is a DAILY limit — there is no per-transaction limit.

import assert from "node:assert/strict";
import {
  detectIntentType,
  resolveDailyLimit,
  computePlanValueUsd,
  decide,
  computeHabitProfile,
  estimateUsd,
  symbolFromAddress,
  toTokenWei,
  DEFAULT_DAILY_LIMIT,
  getPriceUsd,
  setPrices,
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

// ── resolveDailyLimit ──
test("resolveDailyLimit: positive number honoured", () => {
  assert.equal(resolveDailyLimit(5), 5);
  assert.equal(resolveDailyLimit(2500), 2500);
});
test("resolveDailyLimit: invalid → default", () => {
  assert.equal(resolveDailyLimit(0), DEFAULT_DAILY_LIMIT);
  assert.equal(resolveDailyLimit(-1), DEFAULT_DAILY_LIMIT);
  assert.equal(resolveDailyLimit(undefined), DEFAULT_DAILY_LIMIT);
  assert.equal(resolveDailyLimit("50"), DEFAULT_DAILY_LIMIT);
});

// ── price feed / estimateUsd ──
test("getPriceUsd: stub defaults before any refresh", () => {
  assert.equal(getPriceUsd("USDC"), 1);
  assert.equal(getPriceUsd("ETH"), 2500);
  assert.equal(getPriceUsd("WETH"), 2500);
  assert.equal(getPriceUsd("MYSTERY"), 0); // unknown → 0
});
test("estimateUsd: uses cache, $1 fallback for unknown", () => {
  assert.equal(estimateUsd("USDC", 100), 100);
  assert.equal(estimateUsd("usdt", 5), 5);
  assert.equal(estimateUsd("ETH", 0.01), 25);
  assert.equal(estimateUsd("WETH", 1), 2500);
  assert.equal(estimateUsd("MYSTERY", 7), 7); // price 0 → treated as $1
});
test("estimateUsd: reflects a live price update", () => {
  setPrices({ ETH: 4000, WETH: 4000 });
  assert.equal(estimateUsd("ETH", 1), 4000);
  assert.equal(estimateUsd("ETH", 0.01), 40);
  setPrices({ ETH: 2500, WETH: 2500 }); // restore for other tests
  assert.equal(estimateUsd("ETH", 1), 2500);
});
test("symbolFromAddress: known + fallback", () => {
  assert.equal(symbolFromAddress(WETH_SEPOLIA), "ETH");
  assert.equal(symbolFromAddress(USDC_SEPOLIA), "USDC");
  assert.equal(symbolFromAddress("0xdead", "ETH"), "ETH");
});
test("toTokenWei: decimals per token", () => {
  assert.equal(toTokenWei("1", USDC_SEPOLIA).toString(), "1000000");
  assert.equal(toTokenWei("1", WETH_SEPOLIA).toString(), "1000000000000000000");
  assert.equal(toTokenWei("1", "0xunknown").toString(), "1000000000000000000");
});

// ── computePlanValueUsd ──
test("computePlanValueUsd: swap uses input token", () => {
  assert.equal(computePlanValueUsd("swap", { symbolIn: "USDC", amount: "2" }, 9999), 2);
  assert.equal(computePlanValueUsd("swap", { symbolIn: "ETH", amount: "0.01" }, 9999), 25);
  assert.equal(computePlanValueUsd("swap", { tokenIn: WETH_SEPOLIA, amount: "1" }, 0), 2500);
});
test("computePlanValueUsd: send", () => {
  assert.equal(computePlanValueUsd("send", { symbol: "USDC", amount: "5" }, 0), 5);
  assert.equal(computePlanValueUsd("send", { amount: "1" }, 0), 2500);
});
test("computePlanValueUsd: other → fallback", () => {
  assert.equal(computePlanValueUsd("balance", {}, 0), 0);
  assert.equal(computePlanValueUsd("add_liquidity", {}, 42), 42);
  assert.equal(computePlanValueUsd("unknown", {}, undefined as any), 0);
});

// ── decide — core (single daily limit) ──
const okPlan = { summary: "Swap 0.01 WETH for USDC", steps: [{ action: "swap", params: {} }] };
const swapPlan = (tokenIn: string, tokenOut: string) => ({
  summary: "swap",
  steps: [{ action: "swap", params: { tokenIn, tokenOut } }],
});
const sendPlan = (to: string) => ({ summary: "send", steps: [{ action: "send", params: { to } }] });

test("decide: balance → INFO", () => {
  const d = decide({ intentType: "balance", valueUsd: 0, dailyLimitUsd: 100, plan: { summary: "Portfolio", steps: [] } });
  assert.equal(d.verdict, "INFO");
  assert.equal(d.riskScore, 0);
  assert.equal(d.requiresLedger, false);
});
test("decide: within daily limit → AUTO_EXECUTE", () => {
  const d = decide({ intentType: "swap", valueUsd: 25, dailyLimitUsd: 100, plan: okPlan });
  assert.equal(d.verdict, "AUTO_EXECUTE");
  assert.equal(d.riskScore, 15);
  assert.deepEqual(d.triggered, []);
});
test("decide: over daily limit → NEEDS_APPROVAL + requiresLedger", () => {
  const d = decide({ intentType: "swap", valueUsd: 500, dailyLimitUsd: 5, plan: okPlan });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.equal(d.riskScore, 70);
  assert.equal(d.requiresLedger, true);
  assert.deepEqual(d.triggered, ["daily-limit"]);
});
test("decide: boundary — value equal to limit auto-executes", () => {
  const d = decide({ intentType: "send", valueUsd: 100, dailyLimitUsd: 100, plan: { summary: "send", steps: [{ action: "send" }] } });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});
test("decide: missing summary → BLOCKED", () => {
  const d = decide({ intentType: "swap", valueUsd: 10, dailyLimitUsd: 100, plan: { steps: [{ action: "swap" }] } });
  assert.equal(d.verdict, "BLOCKED");
  assert.equal(d.riskScore, 100);
});
test("decide: value-bearing intent with no steps → BLOCKED", () => {
  const d = decide({ intentType: "swap", valueUsd: 10, dailyLimitUsd: 100, plan: { summary: "swap", steps: [] } });
  assert.equal(d.verdict, "BLOCKED");
  assert.match(d.reason, /no executable steps/);
});
test("decide: unknown intent → fail closed NEEDS_APPROVAL", () => {
  const d = decide({ intentType: "unknown", valueUsd: 0, dailyLimitUsd: 100, plan: { summary: "???", steps: [] } });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.equal(d.requiresLedger, true);
});

// ── decide — daily limit uses rolling-24h spend ──
test("decide: cumulative spend crosses the daily limit", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const history = [
    { valueUsd: 40, at: "2026-07-20T09:00:00Z" },
    { valueUsd: 40, at: "2026-07-20T10:00:00Z" },
  ];
  const d = decide({ intentType: "swap", valueUsd: 30, dailyLimitUsd: 100, plan: okPlan, history, now });
  assert.equal(d.verdict, "NEEDS_APPROVAL"); // 80 + 30 > 100
  assert.deepEqual(d.triggered, ["daily-limit"]);
});
test("decide: daily limit fires on the FIRST tx (empty history)", () => {
  const d = decide({ intentType: "swap", valueUsd: 150, dailyLimitUsd: 10, plan: okPlan, history: [] });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["daily-limit"]);
});
test("decide: daily limit fires with no history array at all", () => {
  const d = decide({ intentType: "swap", valueUsd: 150, dailyLimitUsd: 10, plan: okPlan });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
});
test("decide: daily limit ignores spend older than 24h", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const history = [{ valueUsd: 500, at: "2026-07-18T12:00:00Z" }]; // 2 days old
  const d = decide({ intentType: "swap", valueUsd: 30, dailyLimitUsd: 100, plan: okPlan, history, now });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});

// ── decide — extended rules ──
test("decide: unverified token → escalates", () => {
  const d = decide({
    intentType: "swap", valueUsd: 10, dailyLimitUsd: 100,
    plan: swapPlan(WETH_SEPOLIA, "0xBADtoken"),
    profile: { verifiedTokens: [WETH_SEPOLIA, USDC_SEPOLIA] },
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["unverified-token"]);
});
test("decide: verified token within limit → AUTO_EXECUTE", () => {
  const d = decide({
    intentType: "swap", valueUsd: 10, dailyLimitUsd: 100,
    plan: swapPlan(WETH_SEPOLIA, USDC_SEPOLIA),
    profile: { verifiedTokens: [WETH_SEPOLIA, USDC_SEPOLIA] },
  });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});
test("decide: unknown recipient → escalates (send)", () => {
  const known = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const d = decide({
    intentType: "send", valueUsd: 5, dailyLimitUsd: 100,
    plan: sendPlan("0xStranger"), profile: { knownAddresses: [known] },
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["unknown-recipient"]);
});
test("decide: known recipient (case-insensitive) → AUTO_EXECUTE", () => {
  const known = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const d = decide({
    intentType: "send", valueUsd: 5, dailyLimitUsd: 100,
    plan: sendPlan(known.toLowerCase()), profile: { knownAddresses: [known] },
  });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});
test("decide: daily count velocity cap → escalates", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const history = [
    { valueUsd: 1, at: "2026-07-20T09:00:00Z" },
    { valueUsd: 1, at: "2026-07-20T10:00:00Z" },
    { valueUsd: 1, at: "2026-07-20T11:00:00Z" },
  ];
  const d = decide({
    intentType: "swap", valueUsd: 1, dailyLimitUsd: 100, plan: okPlan,
    profile: { maxAutoTxPerDay: 3 }, history, now,
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["daily-count-velocity"]);
});
test("decide: habit anomaly → escalates", () => {
  const d = decide({
    intentType: "swap", valueUsd: 600, dailyLimitUsd: 1000, plan: okPlan,
    profile: { typicalMaxUsd: 50 }, // 600 > 50*10
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["habit-anomaly"]);
});
test("decide: within habit range → AUTO_EXECUTE", () => {
  const d = decide({
    intentType: "swap", valueUsd: 400, dailyLimitUsd: 1000, plan: okPlan,
    profile: { typicalMaxUsd: 50 }, // 400 < 50*10
  });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});
test("decide: multiple escalations combine, max risk + all rules", () => {
  const d = decide({
    intentType: "send", valueUsd: 5000, dailyLimitUsd: 100,
    plan: sendPlan("0xStranger"),
    profile: { knownAddresses: ["0xknown"], typicalMaxUsd: 10 },
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.equal(d.riskScore, 70); // max(daily-limit 70, unknown-recipient 60, habit 55)
  assert.ok(d.triggered.includes("daily-limit"));
  assert.ok(d.triggered.includes("unknown-recipient"));
  assert.ok(d.triggered.includes("habit-anomaly"));
});
test("decide: empty verifiedTokens disables the token rule", () => {
  const d = decide({
    intentType: "swap", valueUsd: 1, dailyLimitUsd: 100,
    plan: okPlan, profile: { verifiedTokens: [] },
  });
  assert.equal(d.verdict, "AUTO_EXECUTE");
});

// ── computeHabitProfile ──
const rec = (valueUsd: number) => ({ valueUsd, at: new Date().toISOString() });

test("computeHabitProfile: empty history → all null", () => {
  const h = computeHabitProfile([]);
  assert.equal(h.sampleSize, 0);
  assert.equal(h.typicalMaxUsd, null);
});
test("computeHabitProfile: below min samples → no baseline", () => {
  const h = computeHabitProfile([rec(10), rec(20)]);
  assert.equal(h.sampleSize, 2);
  assert.equal(h.medianUsd, 15);
  assert.equal(h.typicalMaxUsd, null);
});
test("computeHabitProfile: median (odd), enough samples → baseline set", () => {
  const h = computeHabitProfile([rec(10), rec(10), rec(10), rec(10), rec(10)]);
  assert.equal(h.sampleSize, 5);
  assert.equal(h.medianUsd, 10);
  assert.equal(h.maxUsd, 10);
  assert.equal(h.typicalMaxUsd, 10);
});
test("computeHabitProfile: median (even) averages middle two", () => {
  const h = computeHabitProfile([rec(10), rec(20), rec(30), rec(40), rec(50), rec(60)]);
  assert.equal(h.medianUsd, 35);
  assert.equal(h.meanUsd, 35);
  assert.equal(h.maxUsd, 60);
});
test("computeHabitProfile: ignores non-positive/invalid values", () => {
  const h = computeHabitProfile([rec(10), rec(0), rec(-5), rec(10), rec(10), rec(10), rec(10)]);
  assert.equal(h.sampleSize, 5);
  assert.equal(h.typicalMaxUsd, 10);
});
test("computeHabitProfile: derived baseline feeds the anomaly rule", () => {
  const habit = computeHabitProfile([rec(10), rec(10), rec(10), rec(10), rec(10)]);
  const d = decide({
    intentType: "swap", valueUsd: 150, dailyLimitUsd: 1000, plan: okPlan,
    profile: { typicalMaxUsd: habit.typicalMaxUsd ?? undefined },
  });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["habit-anomaly"]);
});

console.log(`\n${passed} passed`);
