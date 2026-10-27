// ─── Executor — multi-step plan tests (mocked model and chain, no network) ───
// Run with `npm run test:plans`. Covers ORC-21: a message with 2 or 3 money-moving steps becomes
// one plan with one verdict and one approval, run one step after another; a dependent amount is
// filled in from what actually happened and only goes down; a failure stops the plan and only the
// steps that ran count; over the limit asks; 4 steps and an over-ceiling plan with a swap are refused;
// an over-ceiling plan of sends only goes to owner-sign, one plain send at a time.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { interpretIntent, assessPlan, MAX_PLAN_STEPS, TOO_MANY_STEPS_REASON, PLAN_WITH_DEPOSIT_REASON, type MultiStepPlan, type PlanAction } from "../intent/pipeline";
import type { ResolveContext } from "../intent/resolve";
import { setPrices } from "../policy";
import { getAdapter, type AdapterResult, type Balances } from "./adapters";
import {
  buildPlanSteps, runPlan, ceilingCheck, executionPayload, fillAmount, withAmount, payloadAmount, planOutcomeText,
  OVER_CEILING_PLAN_WITH_SWAP, OVER_CEILING_PLAN_SENDS, overCeilingOwnerSignText, ownerSends, type PlanStepRecord,
} from "./plan";
import { OverCapError } from "../utils/userFacing";
import { fitsDailyCeiling } from "../integrations/safe/accountExec";
import { createApproval, claim, getApproval, _resetApprovals } from "../approvals";
import { executePlanApprovalFlow } from "../approvals/flows";
import { reviewOf } from "../approvals/describe";
import { getRecentActivity, _resetPolicyStoreCache } from "../policy/store";
import { USDC_SEPOLIA, WETH_SEPOLIA } from "../integrations/uniswap/types";

setPrices({ ETH: 2500, WETH: 2500, USDC: 1 });

const ALICE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BOB = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B";
const SAFE = "0x00000000000000000000000000000000000000Sa".replace("Sa", "5a");
let walletN = 0;
const freshWallet = () => ethers.getAddress(`0x${(0xa0000 + ++walletN).toString(16).padStart(40, "0")}`);

const BAL: Balances = { eth: 0.05, weth: 0, usdc: 20, totalUsd: 145 };
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  connected: true,
  getBalances: async () => BAL,
  resolveEns: async (name) => (name === "alice.eth" ? ALICE : null),
  ...over,
});

/** interpretIntent with the model replaced by a fixed planner output. */
async function interpret(output: unknown, c: ResolveContext = ctx(), message = "do these things") {
  const r = await interpretIntent(message, [], c, {
    provider: "groq", model: "test-model",
    completeFn: async () => ({ text: JSON.stringify(output), provider: "groq", model: "test-model", latencyMs: 1, waitedMs: 0 }) as any,
  });
  return r.outcome;
}
const actions = (...steps: unknown[]) => ({ type: "actions", steps });
const swap = (from: string, to: string, amount: string, extra: object = {}) => ({ action: "swap", from, to, amount, unit: "token", side: "in", ...extra });
const send = (token: string, amount: string, to: string, extra: object = {}) => ({ action: "send", token, amount, unit: "token", to, ...extra });

async function planOf(output: unknown, c?: ResolveContext): Promise<MultiStepPlan> {
  const o = await interpret(output, c);
  assert.equal(o.kind, "plan", JSON.stringify(o));
  return (o as any).plan;
}

const profile = (over: object = {}) => ({ dailyLimitUsd: 100, knownAddresses: [ALICE, BOB], ...over });

/** A swap build that quotes at `rate` of market without touching the network; sends use the real (pure) adapter. */
function fakeBuild(rate = 1) {
  return async (step: PlanAction): Promise<AdapterResult> => {
    if (step.intentType === "swap") {
      const p = step.params;
      const decimals = p.symbolIn === "USDC" ? 6 : 18;
      const outUsd = Number(p.amount) * (p.symbolIn === "USDC" ? 1 : 2500) * rate;
      const expectedOut = p.symbolOut === "USDC" ? outUsd : outUsd / 2500;
      return {
        plan: { id: "q", summary: `Swap ${p.amount} ${p.symbolIn} for ~${expectedOut.toFixed(6)} ${p.symbolOut}`, steps: [], totalEstimatedValueUsd: step.valueUsd },
        // Like the real adapter: native ETH is quoted as the zero address, not WETH.
        payload: { quoteData: { tokenIn: p.symbolIn === "ETH" ? ethers.ZeroAddress : p.tokenIn, tokenOut: p.symbolOut === "ETH" ? ethers.ZeroAddress : p.tokenOut, amount: ethers.parseUnits(String(p.amount), decimals).toString(), symbolIn: p.symbolIn, symbolOut: p.symbolOut, expectedOut } },
      };
    }
    return getAdapter(step.intentType)!.build({
      safeAddress: SAFE, balanceAddress: SAFE, provider: null as any, params: step.params,
      planSummary: step.summary, planSteps: step.steps, totalEstimatedValueUsd: step.valueUsd, balances: null,
    });
  };
}

async function built(plan: MultiStepPlan, rate = 1): Promise<PlanStepRecord[]> {
  const b = await buildPlanSteps(plan.steps, { build: fakeBuild(rate), execution: executionPayload });
  assert.ok("steps" in b, JSON.stringify(b));
  return (b as any).steps;
}

/** A chain stand-in: balances move as steps "run"; `fail` makes that step index throw. */
function fakeChain(start: Balances, opts: { fail?: number; swapGives?: (step: PlanStepRecord) => number } = {}) {
  const bal = { ...start };
  const ran: PlanStepRecord[] = [];
  const key = (s: string) => (s === "ETH" ? "eth" : s === "WETH" ? "weth" : "usdc") as "eth" | "weth" | "usdc";
  return {
    ran,
    bal,
    deps: {
      readBalances: async () => ({ ...bal }),
      execute: async (step: PlanStepRecord) => {
        if (opts.fail === ran.length) { ran.push(step); throw new Error("execution reverted"); }
        ran.push(step);
        const e = step.execution as any;
        if (step.intentType === "send") bal[key(e.sendData.symbol)] -= Number(e.sendData.amount);
        if (step.intentType === "swap") {
          const q = e.quoteData;
          bal[key(q.symbolIn)] -= Number(ethers.formatUnits(BigInt(q.amount), q.symbolIn === "USDC" ? 6 : 18));
          bal[key(q.symbolOut)] += opts.swapGives ? opts.swapGives(step) : q.expectedOut;
        }
        return { txHash: `0x${String(ran.length).padStart(64, "0")}`, explorerUrl: `https://sepolia.etherscan.io/tx/${ran.length}` };
      },
      errorText: (err: unknown) => (err instanceof Error && err.message === "execution reverted" ? "The transaction was refused by the network. Nothing was taken from that step" : String((err as any)?.message ?? err)),
    },
  };
}

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ── Understanding: plans instead of "one thing per message" ──

test("a 2-step message becomes one plan with both steps, in order, and a total", async () => {
  const plan = await planOf(actions(swap("USDC", "ETH", "2"), send("USDC", "1", "alice.eth")));
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps.map((s) => s.intentType), ["swap", "send"]);
  assert.equal(plan.valueUsd, 3);
  assert.match(plan.summary, /^I'll do these 2 things, one after another:\n1\. Swap 2 USDC for ETH\n2\. Send 1 USDC to alice\.eth/);
});

test("a 3-step message becomes one plan; a 4-step one is refused with a plain 'split it' message", async () => {
  const three = await planOf(actions(send("USDC", "1", ALICE), send("USDC", "1", BOB), swap("USDC", "ETH", "1")));
  assert.equal(three.steps.length, MAX_PLAN_STEPS);
  const four = await interpret(actions(send("USDC", "1", ALICE), send("USDC", "1", BOB), swap("USDC", "ETH", "1"), send("ETH", "0.001", ALICE)));
  assert.deepEqual(four, { kind: "unsupported", reason: TOO_MANY_STEPS_REASON(4) });
  assert.match(TOO_MANY_STEPS_REASON(4), /up to 3 in one message\. Please split it/);
});

test("a later step is resolved against what the earlier ones leave: not enough is answered before anything runs", async () => {
  const o = await interpret(actions(send("USDC", "15", ALICE), send("USDC", "10", BOB)));
  assert.equal(o.kind, "unsupported");
  assert.match((o as any).reason, /Not enough USDC: you have 5 USDC/);
});

test("a deposit can't be one of a plan's steps (the user signs it in their own wallet)", async () => {
  const o = await interpret(actions({ action: "deposit", token: "ETH", amount: "0.01", unit: "token" }, send("USDC", "1", ALICE)));
  assert.deepEqual(o, { kind: "unsupported", reason: PLAN_WITH_DEPOSIT_REASON });
});

test("fails closed: with the limits unreadable, a plan is answered with the gate's reason and nothing is resolved", async () => {
  let balanceReads = 0;
  const o = await interpret(actions(send("USDC", "1", ALICE), send("USDC", "1", BOB)), ctx({
    getBalances: async () => { balanceReads++; return BAL; },
    valueGate: async () => "I can't check your limits right now, so I won't move anything.",
  }));
  assert.deepEqual(o, { kind: "unsupported", reason: "I can't check your limits right now, so I won't move anything." });
  assert.equal(balanceReads, 0);
});

// ── Policy: each step and the total ──

test("2 small steps to known addresses run on their own", async () => {
  const plan = await planOf(actions(send("USDC", "1", ALICE), send("USDC", "2", BOB)));
  const d = assessPlan(plan, { profile: profile(), history: [] });
  assert.equal(d.verdict, "AUTO_EXECUTE", d.reason);
});

test("a plan over the limit needs an OK even when every step alone is under it (the total counts)", async () => {
  // $60 + $50 = $110 against a $100 limit; each step alone is under.
  const plan = await planOf(actions(send("ETH", "0.024", ALICE), send("USDC", "50", BOB)), ctx({ getBalances: async () => ({ ...BAL, usdc: 100 }) }));
  for (const s of plan.steps) assert.ok(s.valueUsd < 100);
  assert.ok(plan.valueUsd > 100);
  const d = assessPlan(plan, { profile: profile(), history: [] });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.ok(d.triggered.includes("daily-limit"));
  // Spent earlier today counts too: $98 already + a $3 plan.
  const small = await planOf(actions(send("USDC", "1", ALICE), send("USDC", "2", BOB)));
  const later = assessPlan(small, { profile: profile(), history: [{ valueUsd: 98, at: new Date().toISOString() }] });
  assert.equal(later.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(later.triggered, ["daily-limit"]);
});

test("one step to a new address makes the whole plan need an OK; paused plans always ask", async () => {
  const plan = await planOf(actions(send("USDC", "1", ALICE), send("USDC", "1", BOB)));
  const d = assessPlan(plan, { profile: profile({ knownAddresses: [ALICE] }), history: [] });
  assert.equal(d.verdict, "NEEDS_APPROVAL");
  assert.deepEqual(d.triggered, ["unknown-recipient"]);
  const paused = assessPlan(plan, { profile: profile(), history: [], paused: { cause: "user" } as any });
  assert.equal(paused.verdict, "NEEDS_APPROVAL");
  assert.ok(paused.triggered.includes("auto-paused"));
});

test("a recipient typed in the message counts as planned when a later step pays it (no 'unplanned address' on the swap)", async () => {
  const o = await interpretIntent(`swap 2 usdc to eth and send 1 usdc to ${BOB}`, [], ctx(), {
    provider: "groq", model: "t",
    completeFn: async () => ({ text: JSON.stringify(actions(swap("USDC", "ETH", "2"), send("USDC", "1", BOB))), provider: "groq", model: "t", latencyMs: 1, waitedMs: 0 }) as any,
  });
  const d = assessPlan((o.outcome as any).plan, { profile: profile(), history: [] });
  assert.equal(d.verdict, "AUTO_EXECUTE", d.reason);
});

// ── Running: one after another ──

test("a 2-step plan runs both steps in order, each as its own transaction", async () => {
  const plan = await planOf(actions(swap("USDC", "ETH", "2"), send("USDC", "1", ALICE)));
  const steps = await built(plan);
  const chain = fakeChain(BAL);
  const done: number[] = [];
  const r = await runPlan(steps, { ...chain.deps, onStepDone: async (_s, o) => { done.push(o.index); } });
  assert.equal(r.complete, true);
  assert.deepEqual(chain.ran.map((s) => s.intentType), ["swap", "send"]);
  assert.deepEqual(done, [0, 1]);
  assert.equal(r.text, "All 2 steps went through.");
  assert.ok(r.steps.every((s) => s.txHash && s.explorerUrl));
});

test("a 3-step plan runs all three, and the swap step is never bundled with the sends", async () => {
  const plan = await planOf(actions(send("USDC", "1", ALICE), swap("USDC", "ETH", "2"), send("USDC", "1", BOB)));
  const steps = await built(plan);
  const chain = fakeChain(BAL);
  const r = await runPlan(steps, chain.deps);
  assert.equal(r.complete, true);
  assert.equal(chain.ran.length, 3);
  for (const s of chain.ran) assert.equal(Object.keys(s.execution).length, 1); // one payload per transaction
  assert.equal(chain.bal.usdc, 16);
});

test("a dependent amount ('send half of what I get') uses what the swap actually brought in, never more than the quote promised", async () => {
  const plan = await planOf(actions(swap("USDC", "ETH", "10"), send("ETH", "50%", ALICE, { of: "previous" })));
  assert.deepEqual(plan.steps[1].amounts, [{ field: "amount", symbol: "ETH", kind: "output", fraction: 0.5, fromStep: 0 }]);
  // Market estimate 0.004 ETH → half is 0.002. The quote promises 3% less: the send is capped at half of that.
  const steps = await built(plan, 0.97);
  const approved = Number((steps[1].execution as any).sendData.amount);
  assert.ok(approved <= 0.00194 + 1e-12, String(approved));
  // The swap actually brings in only 0.0036 ETH: the send becomes half of that, to the same recipient.
  const chain = fakeChain(BAL, { swapGives: () => 0.0036 });
  const r = await runPlan(steps, chain.deps);
  assert.equal(r.complete, true);
  const sent = (chain.ran[1].execution as any).sendData;
  // Half of 0.0036, rounded down (never up) to what the token can hold.
  assert.ok(Number(sent.amount) <= 0.0018 && Number(sent.amount) > 0.0018 - 1e-7, sent.amount);
  assert.equal(sent.to, ALICE);
  assert.equal(sent.unsignedTx.to, ALICE);
  assert.equal(sent.unsignedTx.value, ethers.parseEther(sent.amount).toString());
  assert.match(r.steps[1].summary, /\(used 0\.001799\d* ETH\)/);
  // More than promised arrives: still only the approved amount.
  const lucky = fakeChain(BAL, { swapGives: () => 0.01 });
  await runPlan(steps, lucky.deps);
  assert.equal(Number((lucky.ran[1].execution as any).sendData.amount), approved);
});

test("'the rest' is what the account holds when the step runs, capped at the approved amount", async () => {
  const plan = await planOf(actions(send("USDC", "5", ALICE), send("USDC", "all", BOB)));
  assert.equal(plan.steps[1].amounts[0].kind, "balance");
  assert.equal(plan.steps[1].params.amount, "15"); // resolved against what step 1 leaves
  const steps = await built(plan);
  const chain = fakeChain({ ...BAL, usdc: 18 }); // less arrived than expected by the time it runs
  const r = await runPlan(steps, chain.deps);
  assert.equal(r.complete, true);
  assert.equal(Number((chain.ran[1].execution as any).sendData.amount), 13);
  assert.equal(r.steps[1].valueUsd, 13);
  // Never raised: fillAmount can't go above what was approved.
  assert.equal(fillAmount({ field: "amount", symbol: "USDC", kind: "balance", fraction: 1 }, 15, { ...BAL, usdc: 500 }), 15);
});

test("withAmount only lowers the amount; recipient and token stay", async () => {
  const plan = await planOf(actions(send("USDC", "5", ALICE), send("USDC", "all", BOB)));
  const [, step] = await built(plan);
  const lower = withAmount(step, step.amounts[0], 7.5);
  assert.equal(payloadAmount(lower, step.amounts[0]), 7.5);
  const d = (lower.execution as any).sendData;
  assert.equal(d.to, BOB);
  assert.equal(d.unsignedTx.to, USDC_SEPOLIA);
  assert.deepEqual(new ethers.Interface(["function transfer(address,uint256)"]).decodeFunctionData("transfer", d.unsignedTx.data).map(String), [BOB, "7500000"]);
  assert.equal((step.execution as any).sendData.amount, "15"); // the stored payload is untouched
});

test("a failure partway stops the plan: later steps don't run and the reply says which steps went through", async () => {
  const plan = await planOf(actions(send("USDC", "1", ALICE), send("USDC", "1", BOB), swap("USDC", "ETH", "1")));
  const steps = await built(plan);
  const chain = fakeChain(BAL, { fail: 1 });
  const counted: number[] = [];
  const r = await runPlan(steps, { ...chain.deps, onStepDone: async (_s, o) => { counted.push(o.index); } });
  assert.equal(r.complete, false);
  assert.deepEqual(r.steps.map((s) => s.status), ["done", "failed", "not-run"]);
  assert.equal(chain.ran.length, 2);
  assert.deepEqual(counted, [0]); // only the step that ran counts
  assert.deepEqual(r.steps.map((s) => s.valueUsd), [1, 0, 0]);
  assert.match(r.text, /^Step 2 didn't go through: The transaction was refused by the network\. Nothing was taken from that step\. I stopped there\./);
  assert.match(r.text, /✓ 1\. Send 1 USDC/);
  assert.match(r.text, /✗ 2\. Send 1 USDC.*\(didn't go through\)/);
  assert.match(r.text, /– 3\. Swap 1 USDC.*\(not started\)/);
});

test("an approved plan that fails partway records activity only for the step that ran, and the approval says what happened", async () => {
  _resetApprovals();
  _resetPolicyStoreCache();
  const wallet = freshWallet();
  const plan = await planOf(actions(send("USDC", "2", ALICE), send("USDC", "3", BOB)));
  const steps = await built(plan);
  const a = await createApproval({
    wallet, safeAddress: SAFE, intentType: "plan", summary: plan.summary, valueUsd: plan.valueUsd,
    reason: "test", triggered: ["daily-limit"], execution: { planData: { steps } },
  });
  await claim(a.id, wallet);
  const chain = fakeChain(BAL, { fail: 1 });
  await assert.rejects(
    executePlanApprovalFlow(a, (_a, onStepDone) => runPlan(steps, { ...chain.deps, onStepDone })),
    /Step 2 didn't go through/,
  );
  const after = getApproval(a.id)!;
  assert.equal(after.status, "failed");
  assert.deepEqual(after.steps!.map((s) => s.status), ["done", "failed"]);
  const activity = await getRecentActivity(wallet);
  assert.deepEqual(activity.map((x) => x.valueUsd), [2]);
  assert.equal(activity[0].source, "approved");
});

test("an approved plan that completes is executed with the last receipt; every step counts once", async () => {
  _resetApprovals();
  const wallet = freshWallet();
  const plan = await planOf(actions(send("USDC", "2", ALICE), send("USDC", "3", BOB)));
  const steps = await built(plan);
  const a = await createApproval({
    wallet, safeAddress: SAFE, intentType: "plan", summary: plan.summary, valueUsd: plan.valueUsd,
    reason: "test", triggered: [], execution: { planData: { steps } },
  });
  await claim(a.id, wallet);
  const chain = fakeChain(BAL);
  const res = await executePlanApprovalFlow(a, (_a, onStepDone) => runPlan(steps, { ...chain.deps, onStepDone }));
  assert.equal(res.explorerUrl, "https://sepolia.etherscan.io/tx/2");
  assert.equal(getApproval(a.id)!.status, "executed");
  assert.deepEqual((await getRecentActivity(wallet)).map((x) => x.valueUsd).sort(), [2, 3]);
});

test("the second screen (Telegram, phone) decodes every step from the stored payloads", async () => {
  const plan = await planOf(actions(swap("USDC", "ETH", "2"), send("USDC", "1", ALICE)));
  const steps = await built(plan);
  const review = reviewOf({
    id: "x", wallet: "w", safeAddress: SAFE, intentType: "plan", summary: "s", valueUsd: 3, reason: "r", triggered: [],
    execution: { planData: { steps } }, hash: "0x1234567890", createdAt: 0, expiresAt: 0, status: "pending",
  });
  assert.equal(review.decoded, true);
  assert.equal(review.title, "2 steps, approved together");
  const text = review.details.map((d) => `${d.label} ${d.value}`).join("\n");
  assert.match(text, /Step 1: Swap 2 USDC → ETH/);
  assert.match(text, /Step 2: Send 1 USDC/);
  assert.match(text, new RegExp(ALICE));
  // A step whose payload can't be decoded makes the whole plan undecodable.
  const broken = reviewOf({
    id: "x", wallet: "w", safeAddress: SAFE, intentType: "plan", summary: "s", valueUsd: 3, reason: "r", triggered: [],
    execution: { planData: { steps: [steps[0], { ...steps[1], execution: { sendData: {} } }] } }, hash: "0x1234567890", createdAt: 0, expiresAt: 0, status: "pending",
  });
  assert.equal(broken.decoded, false);
});

// ── Over the account's on-chain daily ceiling (owner-sign territory) ──

const overCeiling = { enabled: () => true, remainingCents: async () => 100n }; // $1 left today

test("an over-ceiling plan with a swap is refused in plain words before anything runs (it can't be owner-signed)", async () => {
  const plan = await planOf(actions(swap("USDC", "ETH", "2"), send("USDC", "1", ALICE)));
  const steps = await built(plan);
  const chain = fakeChain(BAL);
  const r = await runPlan(steps, { ...chain.deps, beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, overCeiling)) });
  assert.equal(r.refused, true);
  assert.equal(r.text, OVER_CEILING_PLAN_WITH_SWAP);
  assert.equal(chain.ran.length, 0);
  assert.deepEqual(r.steps.map((s) => s.status), ["not-run", "not-run"]);
});

test("an over-ceiling plan of sends only goes to owner-sign like a single send: one plain transfer per send, nothing run by the agent", async () => {
  const plan = await planOf(actions(send("USDC", "1", ALICE), send("ETH", "0.001", BOB)));
  const steps = await built(plan);
  const chain = fakeChain(BAL);
  const offered: any[] = [];
  const offer = async (sends: any[]) => { offered.push(sends); return { kind: "safe-owner", id: "o1" }; };
  await assert.rejects(
    runPlan(steps, { ...chain.deps, beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, overCeiling), offer) }),
    (e: any) => e instanceof OverCapError && e.code === "over_daily_cap" && e.message === overCeilingOwnerSignText(2) && (e.ownerSign as any)?.id === "o1",
  );
  assert.equal(chain.ran.length, 0);
  assert.equal(offered.length, 1);
  const [usdc, eth] = offered[0];
  // Each send is its own plain payment (no MultiSend), carrying what it claims to send for the browser check.
  assert.equal(usdc.batch.length, 1);
  assert.equal(usdc.batch[0].to, USDC_SEPOLIA);
  assert.equal(usdc.batch[0].value, "0");
  assert.deepEqual({ to: usdc.meta.to, amount: usdc.meta.amount, symbol: usdc.meta.symbol }, { to: ALICE, amount: "1", symbol: "USDC" });
  assert.equal(usdc.meta.valueUsd, 1);
  assert.deepEqual(eth.batch, [{ to: BOB, value: ethers.parseEther("0.001").toString(), data: "0x" }]);
  assert.equal(eth.meta.symbol, "ETH");
});

test("an over-ceiling plan of sends only without an offer (none possible) is answered in plain words; under the ceiling it runs; unreadable fails closed", async () => {
  const plan = await planOf(actions(send("USDC", "1", ALICE), send("USDC", "1", BOB)));
  const steps = await built(plan);
  const refused = await runPlan(steps, { ...fakeChain(BAL).deps, beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, overCeiling)) });
  assert.equal(refused.refused, true);
  assert.equal(refused.text, OVER_CEILING_PLAN_SENDS);
  const noOffer = await runPlan(steps, { ...fakeChain(BAL).deps, beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, overCeiling), async () => null) });
  assert.equal(noOffer.text, OVER_CEILING_PLAN_SENDS);
  const failing = await runPlan(steps, { ...fakeChain(BAL).deps, beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, overCeiling), async () => { throw new Error("rpc"); }) });
  assert.equal(failing.text, OVER_CEILING_PLAN_SENDS);
  const roomy = { enabled: () => true, remainingCents: async () => 100_000n };
  let asked = 0;
  const ok = await runPlan(steps, { ...fakeChain(BAL).deps, beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, roomy), async () => { asked++; return { id: "x" }; }) });
  assert.equal(ok.complete, true);
  assert.equal(asked, 0, "under the ceiling nothing is offered");
  const unreadable = { enabled: () => true, remainingCents: async () => { throw new Error("rpc down"); } };
  const closed = await runPlan(steps, { ...fakeChain(BAL).deps, beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, unreadable), async () => { asked++; return { id: "x" }; }) });
  assert.equal(closed.refused, true);
  assert.match(closed.text, /couldn't check your account's daily ceiling/);
  assert.equal(asked, 0, "an unreadable ceiling offers nothing");
});

test("an over-ceiling plan with a swap is never offered to owner-sign, even with an offer available (ORC-113 stays strict)", async () => {
  const plan = await planOf(actions(swap("USDC", "ETH", "2"), send("USDC", "1", ALICE)));
  const steps = await built(plan);
  let asked = 0;
  const r = await runPlan(steps, { ...fakeChain(BAL).deps, beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, overCeiling), async () => { asked++; return { id: "x" }; }) });
  assert.equal(r.text, OVER_CEILING_PLAN_WITH_SWAP);
  assert.equal(asked, 0);
  assert.throws(() => ownerSends(steps), /Only a plan of sends/);
});

test("an approved sends-only plan over the ceiling: the approval fails with the owner-sign answer, nothing is recorded, and Telegram gets the link", async () => {
  _resetApprovals();
  _resetPolicyStoreCache();
  const wallet = freshWallet();
  const plan = await planOf(actions(send("USDC", "2", ALICE), send("USDC", "3", BOB)));
  const steps = await built(plan);
  const a = await createApproval({
    wallet, safeAddress: SAFE, intentType: "plan", summary: plan.summary, valueUsd: plan.valueUsd,
    reason: "test", triggered: ["daily-limit"], execution: { planData: { steps } },
  });
  a.channel = "telegram";
  a.telegram = { chatId: 42, messageId: 7 } as any;
  await claim(a.id, wallet);
  const chain = fakeChain(BAL);
  const links: string[] = [];
  const notifier = { link: async (_c: number, _t: string, _b: string, url: string) => { links.push(url); }, text: async () => {} };
  const prev = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = "https://app.example";
  try {
    await assert.rejects(
      executePlanApprovalFlow(a, (_a, onStepDone) => runPlan(steps, {
        ...chain.deps, onStepDone,
        beforeStart: ceilingCheck(steps, (v) => fitsDailyCeiling(SAFE, v, overCeiling), async () => ({ kind: "safe-owner", id: "held-1" })),
      }), notifier),
      (e: any) => e instanceof OverCapError && (e.ownerSign as any)?.id === "held-1",
    );
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = prev;
  }
  assert.equal(chain.ran.length, 0);
  assert.equal(getApproval(a.id)!.status, "failed");
  assert.deepEqual(links, ["https://app.example/simple?ownerSign=held-1"]);
  assert.deepEqual(await getRecentActivity(wallet), [], "nothing counts until the owner's sends go through");
});

test("planOutcomeText: nothing ran when the first step fails", () => {
  const t = planOutcomeText([
    { index: 0, summary: "Send 1 USDC to A", status: "failed", error: "Not enough USDC.", valueUsd: 0 },
    { index: 1, summary: "Send 1 USDC to B", status: "not-run", valueUsd: 0 },
  ]);
  assert.match(t, /^Step 1 didn't go through: Not enough USDC\. Nothing was done\./);
});

test("the token addresses in a plan come from the registry, never the model", async () => {
  const plan = await planOf(actions(swap("ETH", "USDC", "0.001"), send("USDC", "1", ALICE)));
  assert.equal(plan.steps[0].params.tokenIn, WETH_SEPOLIA);
  assert.equal(plan.steps[1].params.token, USDC_SEPOLIA);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`);
      throw err;
    }
  }
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
