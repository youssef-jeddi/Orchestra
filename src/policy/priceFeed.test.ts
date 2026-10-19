// ─── Policy — no price, no spend (ORC-106) ───
// The feed used to fall back to a built-in $2500/ETH with no age: with ETH at $4000, a 0.035 ETH
// send ($140) was valued at $87.50, stayed under a $100 limit and ran on its own. Now a cache that
// was never filled, or is older than MAX_PRICE_AGE_MS, is "not usable" and every spend is refused
// with a plain retry message (not sent to approval). Run with `npm run test:price-feed`.

import assert from "node:assert/strict";
import { decide, computePlanValueUsd, getPriceUsd, setPrices, pricesUsable, refreshPrices, MAX_PRICE_AGE_MS } from "./index";
import { _resetPriceFeedForTests } from "./priceFeed";
import { faultInjectProblem } from "../utils/faultInject";
import { interpretIntent } from "../intent/pipeline";
import { PRICE_UNAVAILABLE_REASON, LIMITS_UNREADABLE_REASON } from "../intent/messages";

console.log = () => {};
console.warn = () => {};
console.error = () => {};
const out = (s: string) => process.stdout.write(s + "\n");

const FRIEND = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const withFault = async <T>(fault: string, fn: () => Promise<T>): Promise<T> => {
  process.env.ORCHESTRA_FAULT_INJECT = fault;
  try { return await fn(); } finally { delete process.env.ORCHESTRA_FAULT_INJECT; }
};
// The same gate the bridge passes to interpretIntent.
const gate = async () => (pricesUsable() ? null : PRICE_UNAVAILABLE_REASON);
const ok = (text: string) => ({ text, provider: "groq", model: "m", latencyMs: 1, waitedMs: 0 });
const sendJson = JSON.stringify({ type: "actions", steps: [{ action: "send", token: "ETH", amount: "0.035", unit: "token", to: FRIEND }] });
const chatJson = JSON.stringify({ type: "reply", text: "Hi" });
const empty = { eth: 0, usdc: 0, weth: 0 } as any;
const run = (text: string, valueGate: () => Promise<string | null>) =>
  interpretIntent("x", [], { connected: true, getBalances: async () => empty, resolveEns: async () => null, valueGate },
    { provider: "groq", model: "m", log: () => {}, completeFn: async () => ok(text) as any });

test("before any fetch there is no price: no invented $2500, not usable", async () => {
  _resetPriceFeedForTests();
  assert.equal(getPriceUsd("ETH"), 0);
  assert.equal(getPriceUsd("WETH"), 0);
  assert.equal(pricesUsable(), false);
});

test("setPrices fills the cache and makes it usable", async () => {
  _resetPriceFeedForTests();
  setPrices({ ETH: 4000, WETH: 4000, USDC: 1 });
  assert.equal(pricesUsable(), true);
  assert.equal(getPriceUsd("ETH"), 4000);
});

test("age: usable up to MAX_PRICE_AGE_MS, not after", async () => {
  _resetPriceFeedForTests();
  setPrices({ ETH: 4000, WETH: 4000 });
  assert.equal(MAX_PRICE_AGE_MS, 5 * 60_000);
  assert.equal(pricesUsable(Date.now()), true);
  assert.equal(pricesUsable(Date.now() + MAX_PRICE_AGE_MS + 1_000), false);
});

test("attack: the old stub made a $140 send look like $87.50 and auto-run; now a stale or failing feed refuses it", async () => {
  // The fail-open, documented: with the stub price in the cache the send sits under a $100 limit.
  _resetPriceFeedForTests();
  setPrices({ ETH: 2500, WETH: 2500, USDC: 1 });
  const stubValue = computePlanValueUsd("send", { symbol: "ETH", amount: "0.035" });
  assert.ok(Math.abs(stubValue - 87.5) < 1e-9, String(stubValue));
  const plan = { summary: "Send 0.035 ETH", steps: [{ action: "send", params: { to: FRIEND } }] };
  const verdict = decide({ intentType: "send", valueUsd: stubValue, dailyLimitUsd: 100, plan, profile: { knownAddresses: [FRIEND] }, history: [] }).verdict;
  assert.equal(verdict, "AUTO_EXECUTE", "a wrong price lets it through — which is why the gate must stop it first");
  // Real ETH is $4000 (= $140), but the feed is stale / down: the gate refuses before any value is computed.
  for (const fault of ["price-stale", "price-read"]) {
    await withFault(fault, async () => {
      assert.equal(pricesUsable(), false, fault);
      assert.equal(await gate(), PRICE_UNAVAILABLE_REASON);
      const r = await run(sendJson, gate);
      assert.deepEqual(r.outcome, { kind: "unsupported", reason: PRICE_UNAVAILABLE_REASON }, "nothing is built, nothing runs");
    });
  }
  // A cache that is simply too old is refused the same way.
  _resetPriceFeedForTests();
  assert.deepEqual((await run(sendJson, gate)).outcome, { kind: "unsupported", reason: PRICE_UNAVAILABLE_REASON });
});

test("ordering: with no usable price a send gets the price answer even though the balance check would refuse; chat is unaffected", async () => {
  _resetPriceFeedForTests();
  const blocked = await run(sendJson, gate);
  assert.deepEqual(blocked.outcome, { kind: "unsupported", reason: PRICE_UNAVAILABLE_REASON });
  setPrices({ ETH: 4000, WETH: 4000 });
  const fresh = await run(sendJson, gate);
  assert.equal(fresh.outcome.kind, "unsupported");
  assert.match((fresh.outcome as any).reason, /Not enough ETH/, "with a fresh price the balance answer comes as before");
  _resetPriceFeedForTests();
  assert.equal((await run(chatJson, gate)).outcome.kind, "reply", "chat doesn't need a price");
});

test("the limits answer and the price answer are different, and the limits one wins", async () => {
  assert.notEqual(PRICE_UNAVAILABLE_REASON, LIMITS_UNREADABLE_REASON);
  assert.equal(PRICE_UNAVAILABLE_REASON, "I can't check the current price right now, so nothing was done. Please try again in a moment.");
  const both = await run(sendJson, async () => LIMITS_UNREADABLE_REASON);
  assert.deepEqual(both.outcome, { kind: "unsupported", reason: LIMITS_UNREADABLE_REASON });
});

test("a failed refresh does not make the cache usable (no fallback to a stub)", async () => {
  _resetPriceFeedForTests();
  await withFault("price-read", () => refreshPrices());
  assert.equal(pricesUsable(), false);
  assert.equal(getPriceUsd("ETH"), 0);
});

test("fault names: price-read and price-stale are accepted, unknown ones still refused", async () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
  assert.equal(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "price-read,price-stale" })), null);
  assert.match(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "price-typo" }))!, /unknown/);
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    out(`  ✓ ${name}`);
  }
  out(`\n${passed} passed`);
})().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
