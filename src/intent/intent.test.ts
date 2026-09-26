// ─── Intent — schema, resolver and history tests (no LLM, no network) ───
// Run with `npm run test:intent`.

import assert from "node:assert/strict";
import { PlannerOutput, Step } from "./schema";
import { resolveSteps, ETH_GAS_RESERVE, type ResolveContext } from "./resolve";
import { sanitizeHistory } from "./planner";
import { assessAction } from "./pipeline";
import { setPrices } from "../policy";
import { WETH_SEPOLIA, USDC_SEPOLIA } from "../integrations/uniswap/types";

setPrices({ ETH: 2500, WETH: 2500, USDC: 1 });

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  connected: true,
  getBalances: async () => ({ eth: 1, weth: 0.5, usdc: 500, totalUsd: 0 }),
  resolveEns: async (name) => (name === "vitalik.eth" ? VITALIK : null),
  ...over,
});
const step = (s: Record<string, unknown>) => Step.parse(s);

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ── Schema ──
test("schema: swap gets unit/side defaults", () => {
  const s = step({ action: "swap", from: "USDC", to: "ETH", amount: "10" });
  assert.deepEqual(s, { action: "swap", from: "USDC", to: "ETH", amount: "10", unit: "token", side: "in" });
});

test("schema: numeric and comma amounts are normalised", () => {
  assert.equal((step({ action: "swap", from: "USDC", to: "ETH", amount: 10 }) as any).amount, "10");
  assert.equal((step({ action: "swap", from: "USDC", to: "ETH", amount: "1,000" }) as any).amount, "1000");
  assert.equal((step({ action: "swap", from: "USDC", to: "ETH", amount: "MAX" }) as any).amount, "max");
});

test("schema: rejects non-numeric amounts", () => {
  assert.equal(Step.safeParse({ action: "swap", from: "USDC", to: "ETH", amount: "ten" }).success, false);
  assert.equal(Step.safeParse({ action: "swap", from: "USDC", to: "ETH", amount: "-5" }).success, false);
});

test("schema: rejects unknown actions and missing fields", () => {
  assert.equal(Step.safeParse({ action: "stake", token: "ETH", amount: "1" }).success, false);
  assert.equal(Step.safeParse({ action: "send", token: "USDC", amount: "5" }).success, false);
  assert.equal(PlannerOutput.safeParse({ type: "clarify" }).success, false);
  assert.equal(PlannerOutput.safeParse({ type: "actions", steps: [] }).success, false);
});

// ── Resolver ──
test("resolve: swap maps symbols to registry addresses + server valuation", async () => {
  const r = await resolveSteps([step({ action: "swap", from: "USDC", to: "ETH", amount: "10" })], ctx());
  assert.equal(r.kind, "ok");
  const s = (r as any).steps[0];
  assert.equal(s.plan.params.tokenIn, USDC_SEPOLIA);
  assert.equal(s.plan.params.tokenOut, WETH_SEPOLIA);
  assert.equal(s.plan.params.amount, "10");
  assert.equal(s.valueUsd, 10);
  assert.equal(s.summary, "Swap 10 USDC for ETH");
});

test("resolve: unknown token → unsupported", async () => {
  const r = await resolveSteps([step({ action: "swap", from: "USDC", to: "PEPE", amount: "10" })], ctx());
  assert.equal(r.kind, "unsupported");
});

test("resolve: same-token swap → clarify; ETH↔WETH → unsupported", async () => {
  assert.equal((await resolveSteps([step({ action: "swap", from: "USDC", to: "usdc", amount: "1" })], ctx())).kind, "clarify");
  assert.equal((await resolveSteps([step({ action: "swap", from: "ETH", to: "WETH", amount: "1" })], ctx())).kind, "unsupported");
});

test("resolve: send to ENS name shows name and full address", async () => {
  const r = await resolveSteps([step({ action: "send", token: "USDC", amount: "5", to: "Vitalik.eth" })], ctx());
  assert.equal(r.kind, "ok");
  const s = (r as any).steps[0];
  assert.equal(s.plan.params.to, VITALIK);
  assert.equal(s.summary, `Send 5 USDC to vitalik.eth (${VITALIK})`);
});

test("resolve: unresolvable ENS / plain name / bad address → clarify", async () => {
  const badChecksum = VITALIK.slice(0, -1) + "F";
  for (const to of ["nobody.eth", "bob", "0x1234", badChecksum]) {
    const r = await resolveSteps([step({ action: "send", token: "USDC", amount: "5", to })], ctx());
    assert.equal(r.kind, "clarify", to);
  }
});

test("resolve: lowercase address is accepted and checksummed", async () => {
  const r = await resolveSteps([step({ action: "send", token: "USDC", amount: "5", to: VITALIK.toLowerCase() })], ctx());
  assert.equal((r as any).steps[0].plan.params.to, VITALIK);
});

test("resolve: zero address → unsupported", async () => {
  const r = await resolveSteps([step({ action: "send", token: "ETH", amount: "1", to: "0x0000000000000000000000000000000000000000" })], ctx());
  assert.equal(r.kind, "unsupported");
});

test("resolve: percentage of balance", async () => {
  const r = await resolveSteps([step({ action: "swap", from: "USDC", to: "ETH", amount: "50%" })], ctx());
  assert.equal((r as any).steps[0].plan.params.amount, "250");
});

test("resolve: 'all' native ETH keeps a gas reserve", async () => {
  const r = await resolveSteps([step({ action: "send", token: "ETH", amount: "all", to: VITALIK })], ctx());
  assert.equal(Number((r as any).steps[0].plan.params.amount), 1 - ETH_GAS_RESERVE);
});

test("resolve: relative amount needs a wallet and a readable balance", async () => {
  const s = step({ action: "swap", from: "USDC", to: "ETH", amount: "all" });
  assert.equal((await resolveSteps([s], ctx({ connected: false }))).kind, "clarify");
  assert.equal((await resolveSteps([s], ctx({ getBalances: async () => null }))).kind, "clarify");
  assert.equal((await resolveSteps([s], ctx({ getBalances: async () => ({ eth: 0, weth: 0, usdc: 0, totalUsd: 0 }) }))).kind, "clarify");
});

test("resolve: usd unit converts at the live price", async () => {
  const r = await resolveSteps([step({ action: "send", token: "ETH", amount: "20", unit: "usd", to: VITALIK })], ctx());
  const s = (r as any).steps[0];
  assert.equal(s.plan.params.amount, "0.008");
  assert.equal(s.valueUsd, 20);
});

test("resolve: exact-output swap estimates the input", async () => {
  const r = await resolveSteps([step({ action: "swap", from: "USDC", to: "ETH", amount: "0.01", side: "out" })], ctx());
  assert.equal((r as any).steps[0].plan.params.amount, "25");
});

test("resolve: over-precise amounts are truncated to token decimals", async () => {
  const r = await resolveSteps([step({ action: "swap", from: "USDC", to: "ETH", amount: "1.1234567" })], ctx());
  assert.equal((r as any).steps[0].plan.params.amount, "1.123456");
});

test("resolve: balance without a wallet → clarify", async () => {
  assert.equal((await resolveSteps([step({ action: "balance" })], ctx({ connected: false }))).kind, "clarify");
});

// ── Verdict on a resolved plan ──
test("assessAction: resolved value drives the daily limit", async () => {
  const small = await resolveSteps([step({ action: "send", token: "USDC", amount: "50", to: VITALIK })], ctx());
  const big = await resolveSteps([step({ action: "send", token: "ETH", amount: "1", to: VITALIK })], ctx());
  const plan = (r: any) => {
    const s = r.steps[0];
    return { id: "x", intentType: s.plan.action, summary: s.summary, steps: [s.plan], params: s.plan.params, valueUsd: s.valueUsd };
  };
  assert.equal(assessAction(plan(small), { profile: {} }).verdict, "AUTO_EXECUTE");

  const prev = process.env.LEDGER_APPROVAL;
  try {
    delete process.env.LEDGER_APPROVAL;
    const off = assessAction(plan(big), { profile: {} });
    assert.equal(off.verdict, "NEEDS_APPROVAL");
    assert.equal(off.approvalMethod, "passkey"); // Ledger tier disabled by default
    process.env.LEDGER_APPROVAL = "on";
    assert.equal(assessAction(plan(big), { profile: {} }).approvalMethod, "ledger");
  } finally {
    if (prev === undefined) delete process.env.LEDGER_APPROVAL;
    else process.env.LEDGER_APPROVAL = prev;
  }
});

// ── History ──
test("sanitizeHistory: alternates roles, starts on user, ends on assistant", () => {
  const h = sanitizeHistory([
    { role: "assistant", content: "hello" },
    { role: "user", content: "swap usdc" },
    { role: "user", content: "for eth" },
    { role: "assistant", content: "How much?" },
    { role: "user", content: "dangling" },
    { role: "system", content: "ignored" },
  ]);
  assert.deepEqual(h, [
    { role: "user", content: "swap usdc\nfor eth" },
    { role: "assistant", content: "How much?" },
  ]);
  assert.deepEqual(sanitizeHistory("nope"), []);
});

(async () => {
  console.log("intent");
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
