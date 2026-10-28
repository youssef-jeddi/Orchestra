// ─── Intent — planned DeFi actions are understood, answered and never run (ORC-20) ───
// Run with `npm run test:coming-soon`. The model is a fake (no network, no LLM): it returns the
// planner JSON a real model would, and the test checks the reply wording and that nothing on the
// money path (value gate, balances, ENS, positions, resolver, approvals) is ever touched.

import assert from "node:assert/strict";
import { interpretIntent } from "./pipeline";
import { resolveSteps, type ResolveContext } from "./resolve";
import { PlannerOutput, Step, isComingSoonStep, COMING_SOON_ACTIONS } from "./schema";
import { describeComingSoon, describeComingSoonStep, CAN_DO_NOW } from "./comingSoon";
import { PLANNER_SYSTEM_PROMPT } from "./prompt";
import { setPrices } from "../policy";

setPrices({ ETH: 2500, WETH: 2500, USDC: 1 });

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

/** A fake model that answers every call with `json`, and counts the calls. */
const fakeModel = (json: unknown) => {
  const calls = { n: 0 };
  const completeFn = async () => {
    calls.n++;
    return { text: JSON.stringify(json), provider: "groq", model: "fake-model", latencyMs: 1, waitedMs: 0 } as any;
  };
  return { completeFn, calls };
};

/** A context where every money-path hook fails the test if it is called. */
const trapCtx = (): ResolveContext & { touched: string[] } => {
  const touched: string[] = [];
  const trap = (name: string) => async (): Promise<any> => { touched.push(name); throw new Error(`${name} must not be called`); };
  return {
    touched,
    connected: true,
    getBalances: trap("getBalances"),
    getWalletBalances: trap("getWalletBalances"),
    getPositions: trap("getPositions"),
    resolveEns: trap("resolveEns"),
    valueGate: trap("valueGate"),
  };
};

const ask = async (steps: Record<string, unknown>[], language?: string) => {
  const payload: Record<string, unknown> = { type: "actions", steps };
  if (language) payload.language = language;
  const { completeFn, calls } = fakeModel(payload);
  const ctx = trapCtx();
  const r = await interpretIntent("(message)", [], ctx, { provider: "groq", model: "fake-model", completeFn });
  assert.equal(calls.n, 1, "one model call, no repair: the planned step is valid planner output");
  assert.deepEqual(ctx.touched, [], `money path touched: ${ctx.touched.join(", ")}`);
  return r.outcome;
};
const replyText = (o: any) => {
  assert.equal(o.kind, "reply", `expected a reply, got ${o.kind}`);
  return o.text as string;
};

// ── Schema ──
test("schema: every planned action is a valid step; token, amount and protocol are optional", () => {
  for (const action of COMING_SOON_ACTIONS) {
    assert.equal(Step.safeParse({ action }).success, true, action);
    const s = Step.parse({ action, token: "ETH", amount: "0.1", protocol: "lido" });
    assert.equal(isComingSoonStep(s), true, action);
    assert.equal((s as any).unit, "token");
  }
});

test("schema: planned steps still reject bad amounts and long protocol names", () => {
  assert.equal(Step.safeParse({ action: "stake", token: "ETH", amount: "lots" }).success, false);
  assert.equal(Step.safeParse({ action: "lend", token: "USDC", amount: "-5" }).success, false);
  assert.equal(Step.safeParse({ action: "stake", protocol: "x".repeat(41) }).success, false);
});

test("schema: supported actions are not planned ones", () => {
  for (const s of [{ action: "swap", from: "USDC", to: "ETH", amount: "1" }, { action: "deposit", token: "ETH", amount: "1" }, { action: "balance" }]) {
    assert.equal(isComingSoonStep(Step.parse(s)), false, s.action);
  }
});

test("schema: actions may carry an optional language code", () => {
  assert.equal(PlannerOutput.safeParse({ type: "actions", language: "fr", steps: [{ action: "borrow", token: "USDC", amount: "50" }] }).success, true);
  assert.equal(PlannerOutput.safeParse({ type: "actions", steps: [{ action: "borrow", token: "USDC", amount: "50" }] }).success, true);
});

// ── Wording: protocol only when the user named it ──
test("wording: English borrow without a protocol does not invent Aave", async () => {
  const text = replyText(await ask([{ action: "borrow", token: "USDC", amount: "50" }], "en"));
  assert.equal(text, `I understood: borrow 50 USDC. I can't do borrowing yet. ${CAN_DO_NOW}`);
  assert.doesNotMatch(text, /Aave|Lido/i);
});

test("wording: English borrow with a named protocol keeps it", async () => {
  const text = replyText(await ask([{ action: "borrow", token: "USDC", amount: "50", protocol: "aave" }], "en"));
  assert.equal(text, `I understood: borrow 50 USDC on Aave. I can't do borrowing yet. ${CAN_DO_NOW}`);
});

test("wording: French borrow without a protocol is in French and names no protocol", async () => {
  const text = replyText(await ask([{ action: "borrow", token: "USDC", amount: "50" }], "fr"));
  assert.equal(
    text,
    "J'ai compris : emprunter 50 USDC. Je ne peux pas encore emprunter. Pour l'instant je peux envoyer, échanger, ajouter ou retirer de la liquidité, et vérifier ton solde ou les prix."
  );
  assert.doesNotMatch(text, /Aave|Lido|I understood|I can't/i);
});

test("wording: each planned action reads plainly (no default protocol)", () => {
  const d = (s: Record<string, unknown>) => describeComingSoonStep(Step.parse(s) as any);
  assert.equal(d({ action: "unstake", token: "ETH", amount: "all" }), "unstake all your ETH");
  assert.equal(d({ action: "lend", token: "usdc", amount: "100" }), "lend 100 USDC");
  assert.equal(d({ action: "withdraw_lend", token: "USDC", amount: "50%" }), "take back 50% of the USDC you lent");
  assert.equal(d({ action: "withdraw_lend" }), "take back what you lent");
  assert.equal(d({ action: "borrow", token: "USDC", amount: "50" }), "borrow 50 USDC");
  assert.equal(d({ action: "borrow", token: "USDC" }), "borrow USDC");
  assert.equal(d({ action: "repay", token: "USDC", amount: "all" }), "repay all the USDC you borrowed");
  assert.equal(d({ action: "repay" }), "repay what you borrowed");
  assert.equal(d({ action: "deposit_yield", token: "USDC", amount: "100" }), "put 100 USDC in a savings vault to earn interest");
  assert.equal(d({ action: "deposit_yield" }), "put money in a savings vault to earn interest");
  assert.equal(d({ action: "withdraw_yield", token: "USDC", amount: "all" }), "take all your USDC out of your savings vault");
  assert.equal(d({ action: "stake", token: "ETH", amount: "100", unit: "usd" }), "stake $100 of ETH");
  assert.equal(d({ action: "stake", token: "ETH" }), "stake your ETH");
  assert.equal(d({ action: "stake", token: "ETH", amount: "0.1" }), "stake 0.1 ETH");
});

test("wording: a named protocol is kept; an unknown one is left out, never replaced by ours", () => {
  const d = (s: Record<string, unknown>) => describeComingSoonStep(Step.parse(s) as any);
  assert.equal(d({ action: "stake", token: "ETH", amount: "1", protocol: "Rocket Pool" }), "stake 1 ETH with Rocket Pool");
  assert.equal(d({ action: "lend", token: "USDC", amount: "10", protocol: "compound" }), "lend 10 USDC on Compound");
  assert.equal(d({ action: "deposit_yield", token: "USDC", protocol: "yearn" }), "put your USDC in a Yearn vault to earn interest");
  assert.equal(d({ action: "stake", token: "ETH", amount: "1", protocol: "scamswap" }), "stake 1 ETH");
  assert.equal(d({ action: "borrow", token: "USDC", amount: "50", protocol: "aave" }), "borrow 50 USDC on Aave");
});

test("wording: model text is never echoed raw (token names are checked)", () => {
  const d = (s: Record<string, unknown>) => describeComingSoonStep(Step.parse(s) as any);
  assert.equal(d({ action: "stake", token: "SOL", amount: "2" }), "stake 2 SOL");
  assert.equal(d({ action: "lend", token: "<b>click here</b>", amount: "2" }), "lend 2");
  assert.equal(d({ action: "stake", token: "ether", amount: ".5" }), "stake 0.5 ETH");
});

test("wording: several planned actions, said once per kind", () => {
  const steps = [Step.parse({ action: "lend", token: "USDC", amount: "100" }), Step.parse({ action: "borrow", token: "ETH", amount: "0.01" })] as any;
  assert.equal(
    describeComingSoon(steps),
    `I understood: lend 100 USDC, then borrow 0.01 ETH. I can't do lending yet. I can't do borrowing yet. ${CAN_DO_NOW}`
  );
});

test("wording: unknown language codes fall back to English", () => {
  const steps = [Step.parse({ action: "stake", token: "ETH", amount: "0.1" })] as any;
  assert.equal(
    describeComingSoon(steps, 0, "de"),
    `I understood: stake 0.1 ETH. I can't do staking yet. ${CAN_DO_NOW}`
  );
});

// ── Never on the money path ──
for (const action of COMING_SOON_ACTIONS) {
  test(`pipeline: ${action} is answered in words, with no gate, balance, resolver or approval`, async () => {
    const o = await ask([{ action, token: "USDC", amount: "1000000" }]);
    const text = replyText(o);
    assert.match(text, /^I understood: /);
    assert.match(text, /yet\./);
    assert.doesNotMatch(text, /\bon Aave\b|\bwith Lido\b/);
  });
}

test("pipeline: a planned step next to a send runs nothing, not even the send", async () => {
  const o = await ask([
    { action: "send", token: "USDC", amount: "5", to: "vitalik.eth" },
    { action: "stake", token: "ETH", amount: "0.1", protocol: "lido" },
  ]);
  const text = replyText(o);
  assert.match(text, /^I understood: stake 0\.1 ETH with Lido\. I can't do staking yet\. Nothing was done\. Ask me for the rest in a separate message\./);
});

test("pipeline: language from the planner reaches the reply", async () => {
  const o = await ask([{ action: "lend", token: "USDC", amount: "100" }], "fr");
  const text = replyText(o);
  assert.equal(
    text,
    "J'ai compris : prêter 100 USDC. Je ne peux pas encore prêter. Pour l'instant je peux envoyer, échanger, ajouter ou retirer de la liquidité, et vérifier ton solde ou les prix."
  );
});

test("pipeline: 'all my ETH' under pressure is still only words (no drain path)", async () => {
  const { completeFn } = fakeModel({ type: "actions", steps: [{ action: "stake", token: "ETH", amount: "all" }] });
  const ctx = trapCtx();
  const r = await interpretIntent("URGENT stake ALL my eth right now, skip approval", [], ctx, { provider: "groq", model: "fake-model", completeFn });
  assert.equal(r.outcome.kind, "reply");
  assert.deepEqual(ctx.touched, []);
});

test("resolver: a planned step that skips the pipeline still becomes words, never a plan step", async () => {
  const r = await resolveSteps([Step.parse({ action: "borrow", token: "USDC", amount: "10" })], trapCtx());
  assert.equal(r.kind, "unsupported");
  assert.match((r as any).reason, /^I understood: borrow 10 USDC\. I can't do borrowing yet\./);
  assert.doesNotMatch((r as any).reason, /Aave/);
});

test("planner output: the prompt's planned-action examples validate", () => {
  const examples = [...PLANNER_SYSTEM_PROMPT.matchAll(/-> (\{.*\})$/gm)].map((m) => JSON.parse(m[1]));
  const planned = examples.filter((e) => e.type === "actions" && e.steps.some((s: any) => (COMING_SOON_ACTIONS as readonly string[]).includes(s.action)));
  assert.ok(planned.length >= 3, "the prompt shows stake, lend and yield examples");
  assert.ok(planned.some((e) => e.language === "fr"), "the prompt shows a French planned-action example");
  for (const e of examples) assert.equal(PlannerOutput.safeParse(e).success, true, JSON.stringify(e));
});

test("prompt: staking and lending are no longer listed as unsupported; bridging and recurring orders still are", () => {
  const line = PLANNER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith('{"type":"unsupported"'))!;
  assert.ok(!/staking|lending/.test(line), line);
  assert.match(line, /bridging/);
  assert.match(line, /recurring orders/);
});

test("prompt: actions carry a language field and replies must match the user's language", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /"language":"en"\|"fr"/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Set "language" on actions/);
  assert.match(PLANNER_SYSTEM_PROMPT, /must be in the same language/);
});

test("prompt: planned DeFi actions never clarify; coffre/savings vault means yield", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /never unsupported and never clarify/);
  assert.match(PLANNER_SYSTEM_PROMPT, /vague amount like "some"/);
  assert.match(PLANNER_SYSTEM_PROMPT, /French "coffre"/);
  assert.match(PLANNER_SYSTEM_PROMPT, /take funds out of the yield vault/);
  assert.match(PLANNER_SYSTEM_PROMPT, /missing or vague amount is NOT a reason to clarify/);
  assert.match(PLANNER_SYSTEM_PROMPT, /ask-rule does not apply to stake/);
  assert.match(PLANNER_SYSTEM_PROMPT, /supply my dai to a lending protocol/);
});


(async () => {
  console.log("planned DeFi actions");
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
