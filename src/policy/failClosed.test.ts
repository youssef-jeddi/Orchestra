// ─── Policy — fail closed when a dependency is down or stale (ORC-40) ───
// One check per dependency the automatic-execution decision touches: the price feed, storage
// (limits, activity, the kill switch), the RPC (account, ceiling, gas), the quote API and the
// language model. Each one, when it's unavailable or returns stale or missing data, must end in
// "needs approval", "blocked" or "nothing done", and never in an automatic run. Also the three
// fixes: prices count as fresh only with ETH and USDC (A), concurrent requests can't run past the
// limit together (B), and a spend that couldn't be saved pauses the wallet's automatic runs (C).
// Run with `npm run test:fail-closed`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { decide, type DecisionInput, type ActivityRecord, type PolicyDecision } from "./index";
import { pricesUsable, setPrices, refreshPrices, _resetPriceFeedForTests, REQUIRED_PRICES } from "./priceFeed";
import { readPolicyInputs, recordActivity, getRecentActivity, hasUnsavedSpend, writeUserProfile, _resetPolicyStoreCache } from "./store";
import { decideWithReservation, reservedFor, _resetReservations } from "./reservations";
import { pauseFor, loadGlobalSwitch, GLOBAL_SWITCH_KEY, _resetKillSwitch } from "./killSwitch";
import { assessQuote, getAdapter } from "../executor/adapters";
import { lpPriceProblem } from "../integrations/uniswap/liquidity";
import { executeForAccount, type AccountExecDeps } from "../integrations/safe/accountExec";
import { safeGasLimit, WOULD_FAIL_TEXT } from "../integrations/safe/transaction";
import { accountReady } from "../integrations/safe/onboarding";
import { resolveSteps, type ResolveContext } from "../intent/resolve";
import { Step } from "../intent/schema";
import { interpretIntent } from "../intent/pipeline";
import { LlmError } from "../integrations/llm";
import { amountsForLiquidity, type Position } from "../integrations/uniswap/liquidity";
import { WETH_SEPOLIA, USDC_SEPOLIA } from "../integrations/uniswap/types";
import { PRICE_UNAVAILABLE_REASON } from "../intent/messages";
import * as storage from "../integrations/zero-g/storage";
import { issueToken } from "../auth";
import { startBridge, post, replay, wait } from "../utils/testBridge";

console.log = ((orig) => (...a: unknown[]) => { if (!/^\[(LocalStorage|Storage|policy|kill-switch|prices|safe|adapter|planner)/.test(String(a[0]))) orig(...a); })(console.log);
const origError = console.error;
console.error = () => {};
console.warn = () => {};

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const withFault = async <T>(fault: string, fn: () => Promise<T>): Promise<T> => {
  process.env.ORCHESTRA_FAULT_INJECT = fault;
  try { return await fn(); } finally { delete process.env.ORCHESTRA_FAULT_INJECT; }
};
const notAuto = (d: PolicyDecision, what: string) => assert.notEqual(d.verdict, "AUTO_EXECUTE", what);

const FRIEND = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const fresh = () => { _resetPriceFeedForTests(); setPrices({ ETH: 2500, WETH: 2500, USDC: 1 }); };
// A $5 send to a known address under a $100 limit: the shape that runs on its own when all is well.
const autoInput = (extra: Partial<DecisionInput> = {}): DecisionInput => ({
  intentType: "send", valueUsd: 5, dailyLimitUsd: 100,
  plan: { summary: "Send 5 USDC", steps: [{ action: "send", params: { to: FRIEND } }] },
  profile: { knownAddresses: [FRIEND] }, history: [], ...extra,
});

// ── Price feed ──

test("price: never fetched, too old, or a failing feed → not usable (spends refuse)", async () => {
  _resetPriceFeedForTests();
  assert.equal(pricesUsable(), false, "never fetched");
  fresh();
  assert.equal(pricesUsable(), true);
  assert.equal(pricesUsable(Date.now() + 6 * 60_000), false, "stale");
  await withFault("price-read", async () => assert.equal(pricesUsable(), false));
  await withFault("price-stale", async () => assert.equal(pricesUsable(), false));
});

test("fix A: prices are fresh only with both ETH and USDC — set by hand or fetched", async () => {
  assert.deepEqual([...REQUIRED_PRICES], ["ETH", "USDC"]);
  _resetPriceFeedForTests();
  setPrices({ ETH: 2500, WETH: 2500 });
  assert.equal(pricesUsable(), false, "ETH alone is not enough");
  const realFetch = globalThis.fetch;
  try {
    _resetPriceFeedForTests();
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ ethereum: { usd: 2500 } }) })) as any;
    await refreshPrices();
    assert.equal(pricesUsable(), false, "a fetch without USDC doesn't make prices fresh");
    _resetPriceFeedForTests();
    globalThis.fetch = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as any;
    await refreshPrices();
    assert.equal(pricesUsable(), false, "an error answer");
    _resetPriceFeedForTests();
    globalThis.fetch = (async () => { throw new Error("offline"); }) as any;
    await refreshPrices();
    assert.equal(pricesUsable(), false, "no network");
    _resetPriceFeedForTests();
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ ethereum: { usd: 2500 }, "usd-coin": { usd: 1 } }) })) as any;
    await refreshPrices();
    assert.equal(pricesUsable(), true, "both came back");
  } finally { globalThis.fetch = realFetch; }
});

test("fix A: a swap quote for a token with no price is refused (the 5% check can't run)", async () => {
  const leg = { tokenIn: "0x0000000000000000000000000000000000000000", symbolIn: "ETH", amountIn: "10000000000000000", tokenOut: USDC_SEPOLIA, symbolOut: "USDC" };
  const quote = { output: { amount: "25000000" } }; // 25 USDC for 0.01 ETH: fair at $2,500
  fresh();
  assert.equal(assessQuote(quote, leg).refusal, undefined, "with prices, a fair quote passes");
  _resetPriceFeedForTests();
  setPrices({ ETH: 2500, WETH: 2500 });
  assert.match(assessQuote(quote, leg).refusal!, /can't check the market price/);
  assert.match(assessQuote({ output: {} }, leg).refusal!, /couldn't read how much you'd receive/);
  fresh();
  assert.match(assessQuote({ output: { amount: "1000000" } }, leg).refusal!, /less than/, "far below market");
});

test("fix A: liquidity at a pool price that can't be checked is refused", async () => {
  const t0 = { address: USDC_SEPOLIA, symbol: "USDC", decimals: 6, native: false, amount: 1n };
  const t1 = { address: WETH_SEPOLIA, symbol: "WETH", decimals: 18, native: false, amount: 1n };
  const sqrt = BigInt(Math.round(Math.sqrt(1e12 / 2500) * 2 ** 96));
  fresh();
  assert.equal(lpPriceProblem(sqrt, t0, t1), null, "fair pool, known prices");
  _resetPriceFeedForTests();
  setPrices({ ETH: 2500, WETH: 2500 });
  assert.match(lpPriceProblem(sqrt, t0, t1)!, /can't check the market price/);
});

test("fix A: taking liquidity out with a side that has no price is refused, not valued at $0", async () => {
  const tick = Math.round(Math.log(1e12 / 2500) / Math.log(1.0001));
  const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(1.0001 ** tick) * 2 ** 96));
  const L = BigInt(Math.floor(25_000_000 * Math.sqrt(1.0001 ** tick)));
  const pos: Position = {
    tokenId: "7", token0: { address: USDC_SEPOLIA, symbol: "USDC", decimals: 6 }, token1: { address: WETH_SEPOLIA, symbol: "WETH", decimals: 18 },
    fee: 3000, tickLower: -887220, tickUpper: 887220, liquidity: L, fullRange: true,
    ...amountsForLiquidity(sqrtPriceX96, -887220, 887220, L), owed0: 0n, owed1: 0n, sqrtPriceX96,
  } as any;
  const ctx: ResolveContext = { connected: true, getBalances: async () => null, resolveEns: async () => null, getPositions: async () => [pos] } as any;
  const steps = [Step.parse({ action: "remove_liquidity", positionId: 7 })];
  fresh();
  const ok: any = await resolveSteps(steps, ctx);
  assert.equal(ok.kind, "ok");
  assert.ok(ok.steps[0].valueUsd > 40);
  _resetPriceFeedForTests();
  setPrices({ USDC: 1 });
  const r: any = await resolveSteps(steps, ctx);
  assert.equal(r.kind, "unsupported");
  assert.equal(r.reason, PRICE_UNAVAILABLE_REASON);
});

test("a value that isn't a real dollar amount (NaN, Infinity, negative) never runs on its own", async () => {
  for (const valueUsd of [NaN, Infinity, -5]) {
    const d = decide(autoInput({ valueUsd }));
    assert.equal(d.verdict, "NEEDS_APPROVAL", String(valueUsd));
    assert.ok(d.triggered.includes("unpriced"));
  }
});

test("bridge: with no fresh price, a send does nothing and says so", async () => {
  const RECIPIENT = ethers.Wallet.createRandom().address;
  const SEND = `send 5 USDC to ${RECIPIENT} (fail-closed test)`;
  replay(SEND, { type: "actions", steps: [{ action: "send", token: "USDC", amount: "5", unit: "token", to: RECIPIENT }] });
  const bridge = await startBridge({ ORCHESTRA_FAULT_INJECT: "price-stale" });
  try {
    const wallet = ethers.Wallet.createRandom().address;
    const r = await post(bridge.port, { message: SEND, walletAddress: wallet }, issueToken(wallet).token);
    assert.equal(r.body.status, "unsupported", JSON.stringify(r.body));
    assert.equal(r.body.reason, PRICE_UNAVAILABLE_REASON);
    assert.ok(!r.body.autoExecuted && !r.body.txHash && !r.body.approval);
  } finally { bridge.child.kill(); }
});

// ── Storage ──

test("storage: an unreadable or slow profile or history is 'not ok' — never defaults or $0 spent", async () => {
  const w = ethers.Wallet.createRandom().address;
  await writeUserProfile(w, { policy: { dailyLimitUsd: 20 } });
  for (const fault of ["profile-read", "activity-read", "profile-timeout", "activity-timeout"]) {
    _resetPolicyStoreCache();
    const inputs = await withFault(fault, () => readPolicyInputs(w, 200));
    assert.equal(inputs.ok, false, fault);
  }
  _resetPolicyStoreCache();
  assert.equal((await readPolicyInputs(w)).ok, true);
});

test("storage: an unreadable kill switch, or a damaged wallet flag, is a pause", async () => {
  _resetKillSwitch("off");
  await withFault("killswitch-read", () => loadGlobalSwitch());
  notAuto(decide(autoInput({ paused: pauseFor(FRIEND, null) })), "global switch unreadable");
  await storage.write(GLOBAL_SWITCH_KEY, { on: 1 });
  await loadGlobalSwitch();
  notAuto(decide(autoInput({ paused: pauseFor(FRIEND, null) })), "global switch damaged");
  _resetKillSwitch("off");
  notAuto(decide(autoInput({ paused: pauseFor(FRIEND, { scope: "wallet", cause: "unreadable" }) })), "wallet flag damaged");
  assert.equal(decide(autoInput({ paused: pauseFor(FRIEND, null) })).verdict, "AUTO_EXECUTE", "all readable and off: it runs");
});

test("fix C: a spend record that can't be saved pauses the wallet's automatic runs until a retry saves it", async () => {
  _resetKillSwitch("off");
  const w = ethers.Wallet.createRandom().address;
  await writeUserProfile(w, {});
  await getRecentActivity(w);
  const rec: ActivityRecord = { valueUsd: 40, at: new Date().toISOString(), source: "auto" };
  await withFault("activity-write", async () => { await recordActivity(w, rec); await wait(10); });
  assert.equal(hasUnsavedSpend(w), true);
  assert.deepEqual(pauseFor(w, null), { scope: "wallet", cause: "unsaved-spend" });
  const d = decide(autoInput({ paused: pauseFor(w, null), history: await getRecentActivity(w) }));
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["auto-paused"]);
  assert.equal((await getRecentActivity(w)).length, 1, "the spend still counts in memory");
  // Still failing: the retry in readPolicyInputs doesn't clear it.
  await withFault("activity-write", () => readPolicyInputs(w));
  assert.equal(hasUnsavedSpend(w), true);
  // Storage is back: the next read saves it and the pause lifts.
  assert.equal((await readPolicyInputs(w)).ok, true);
  assert.equal(hasUnsavedSpend(w), false);
  assert.equal(pauseFor(w, null), null);
  const saved = (await storage.readMany(`activity:${w.toLowerCase()}`)) as any[];
  assert.equal(saved.filter((r) => r.at === rec.at).length, 1, "saved once");
});

// ── RPC ──

test("RPC: an unreadable on-chain daily ceiling sends nothing", async () => {
  let sent = 0;
  const deps: AccountExecDeps = {
    enabled: () => true,
    remainingCents: async () => { throw new Error("rpc down"); },
    viaModule: async () => { sent++; return "0x1"; },
    viaOwner: async () => { sent++; return "0x2"; },
    offer: async () => null,
  };
  await assert.rejects(executeForAccount({ safeAddress: FRIEND, agentKey: "k", batch: [], valueUsd: 5 }, deps), /couldn't check your account's daily ceiling/);
  assert.equal(sent, 0);
});

test("RPC: a gas estimate that reverts sends nothing; account status that can't be read counts as not ready", async () => {
  await assert.rejects(safeGasLimit(async () => { throw Object.assign(new Error("revert GS013"), { code: "CALL_EXCEPTION" }); }, "150000"), new RegExp(WOULD_FAIL_TEXT.slice(0, 20)));
  assert.equal(await accountReady({ status: async () => { throw new Error("rpc down"); } } as any, FRIEND), false);
});

// ── Quote API ──

test("quote API down: the swap has no quote, so there is nothing to run on its own", async () => {
  fresh();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("quote API down"); }) as any;
  try {
    const adapter = getAdapter("swap")!;
    const wallet = ethers.Wallet.createRandom().address;
    const ctx: any = {
      walletAddress: wallet, safeAddress: FRIEND, balanceAddress: FRIEND, provider: null,
      params: { tokenIn: WETH_SEPOLIA, symbolIn: "ETH", tokenOut: USDC_SEPOLIA, symbolOut: "USDC", amount: "0.01" },
      planSummary: "Swap 0.01 ETH for USDC", planSteps: [], totalEstimatedValueUsd: 25, balances: null,
    };
    const built = await adapter.build(ctx);
    assert.equal((built.payload as any)?.quoteData, null);
    assert.equal(await adapter.execute!(ctx, built), null, "nothing executes");
  } finally { globalThis.fetch = realFetch; }
});

// ── Language model ──

test("language model down: the answer is a message, never an action", async () => {
  const ctx: ResolveContext = { connected: true, getBalances: async () => null, resolveEns: async () => null } as any;
  const r = await interpretIntent("send 5 USDC to vitalik.eth", [], ctx, {
    provider: "groq", model: "test-model", log: () => {}, completeFn: async () => { throw new LlmError("LLM request timed out", null); },
  } as any);
  assert.notEqual(r.outcome.kind, "action");
  assert.equal(r.planner.failed, true);
});

// ── Concurrency (fix B) ──

test("fix B: two requests at once can't both run past the daily limit", async () => {
  _resetReservations();
  const w = ethers.Wallet.createRandom().address;
  const history: ActivityRecord[] = [];
  const read = async () => { await wait(15); return [...history]; };
  const decideFor = (h: ActivityRecord[] | undefined) => decide(autoInput({ valueUsd: 60, history: h }));
  // What used to happen: both decided on the same history, before either was recorded.
  assert.deepEqual([decideFor(history).verdict, decideFor(history).verdict], ["AUTO_EXECUTE", "AUTO_EXECUTE"]);
  const [a, b] = await Promise.all([decideWithReservation(w, 60, read, decideFor), decideWithReservation(w, 60, read, decideFor)]);
  assert.deepEqual([a.decision.verdict, b.decision.verdict].sort(), ["AUTO_EXECUTE", "NEEDS_APPROVAL"]);
  assert.equal(reservedFor(w).length, 1);
  // The automatic one went through: it's recorded, then released.
  history.push({ valueUsd: 60, at: new Date().toISOString(), source: "auto" });
  a.release(); b.release(); a.release();
  assert.equal(reservedFor(w).length, 0);
  assert.equal((await decideWithReservation(w, 60, read, decideFor)).decision.verdict, "NEEDS_APPROVAL", "$60 spent, another $60 asks");
});

test("fix B: a run that failed frees its reservation; other wallets aren't held up; no wallet reserves nothing", async () => {
  _resetReservations();
  const w = ethers.Wallet.createRandom().address;
  const read = async () => [] as ActivityRecord[];
  const decideFor = (h: ActivityRecord[] | undefined) => decide(autoInput({ valueUsd: 60, history: h }));
  const first = await decideWithReservation(w, 60, read, decideFor);
  assert.equal(first.decision.verdict, "AUTO_EXECUTE");
  assert.equal((await decideWithReservation(w, 60, read, decideFor)).decision.verdict, "NEEDS_APPROVAL", "while the first is in progress");
  first.release(); // the transaction failed: nothing recorded
  assert.equal((await decideWithReservation(w, 60, read, decideFor)).decision.verdict, "AUTO_EXECUTE");
  const other = ethers.Wallet.createRandom().address;
  assert.equal((await decideWithReservation(other, 60, read, decideFor)).decision.verdict, "AUTO_EXECUTE");
  const none = await decideWithReservation(undefined, 60, read, decideFor);
  assert.equal(reservedFor(FRIEND).length, 0);
  none.release();
  await assert.rejects(decideWithReservation(w, 5, async () => { throw new Error("history gone"); }, decideFor), /history gone/, "no history, no verdict");
  // The lock isn't stuck after that error: with $60 still reserved, $50 more asks.
  assert.equal((await decideWithReservation(w, 50, read, (h) => decide(autoInput({ valueUsd: 50, history: h })))).decision.verdict, "NEEDS_APPROVAL");
});

// ── Sweep: every dependency failure at once in one table ──

test("sweep: no dependency failure in this file produces AUTO_EXECUTE", async () => {
  const cases: [string, Partial<DecisionInput>][] = [
    ["global pause", { paused: { scope: "global", cause: "admin" } }],
    ["global flag unreadable", { paused: { scope: "global", cause: "unreadable" } }],
    ["wallet pause", { paused: { scope: "wallet", cause: "user" } }],
    ["wallet flag damaged", { paused: { scope: "wallet", cause: "unreadable" } }],
    ["unsaved spend", { paused: { scope: "wallet", cause: "unsaved-spend" } }],
    ["no price → NaN value", { valueUsd: NaN }],
    ["recipients unreadable → none known", { profile: { knownAddresses: [] } }],
    ["no profile at all", { profile: undefined }],
  ];
  for (const [name, extra] of cases) notAuto(decide(autoInput(extra)), name);
});

(async () => {
  console.log("fail closed");
  for (const [name, fn] of tests) {
    _resetPolicyStoreCache();
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => { origError(e); process.exit(1); });
