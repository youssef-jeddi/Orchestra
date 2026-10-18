// ─── Intent — plain-language wording tests (no LLM, no network) ───
// Everything the chat, Telegram and the phone approval page show to a person must be
// free of jargon, and the Safe is "your account". Run with `npm run test:plain`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Step } from "./schema";
import { resolveSteps, type ResolveContext } from "./resolve";
import { assessAction } from "./pipeline";
import { describeAddresses, describeBalances } from "./replies";
import { PLANNER_SYSTEM_PROMPT } from "./prompt";
import { decide, setPrices } from "../policy";
import { checkSwapQuote } from "../policy/quoteCheck";
import { lpPriceProblem } from "../integrations/uniswap/liquidity";
import { createApproval, type NewApproval } from "../approvals";
import { describeApproval, describeOutcome, reviewOf } from "../approvals/describe";
import { USDC_SEPOLIA } from "../integrations/uniswap/types";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import * as ui from "../../frontend/src/lib/plainLanguage.js";

setPrices({ ETH: 2500, WETH: 2500, USDC: 1 });

const JARGON = /\bSafe\b|\bgas\b|slippage|calldata|\bnonce\b|etherscan|denylist|malformed|\bquote\b|auto-?execut|verdict|\btx\b|hash\b|\bWETH9\b/i;
const clean = (what: string, text: string) => assert.doesNotMatch(text, JARGON, `${what}: "${text}"`);

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  connected: true,
  getBalances: async () => ({ eth: 1, weth: 0.5, usdc: 500, totalUsd: 0 }),
  resolveEns: async (name) => (name === "vitalik.eth" ? VITALIK : null),
  getPositions: async () => [],
  ...over,
});

/** Resolve one step and return every sentence it produces (summary, question or reason). */
async function words(raw: Record<string, unknown>, over: Partial<ResolveContext> = {}): Promise<string> {
  const r: any = await resolveSteps([Step.parse(raw)], ctx(over));
  return r.kind === "ok" ? r.steps.map((s: any) => s.summary).join(" ") : (r.question ?? r.reason);
}

test("resolver: summaries, questions and refusals are plain and never say Safe", async () => {
  const cases: [Record<string, unknown>, Partial<ResolveContext>?][] = [
    [{ action: "swap", from: "USDC", to: "ETH", amount: "10" }],
    [{ action: "swap", from: "USDC", to: "ETH", amount: "600" }],
    [{ action: "swap", from: "ETH", to: "WETH", amount: "0.1" }],
    [{ action: "swap", from: "USDC", to: "DOGE", amount: "1" }],
    [{ action: "send", token: "USDC", amount: "5", to: "vitalik.eth" }],
    [{ action: "send", token: "USDC", amount: "5", to: "0x123" }],
    [{ action: "send", token: "USDC", amount: "5", to: "bob" }],
    [{ action: "send", token: "USDC", amount: "5", to: "nobody.eth" }],
    [{ action: "send", token: "ETH", amount: "all", to: "vitalik.eth" }, { getBalances: async () => ({ eth: 0.001, weth: 0, usdc: 0, totalUsd: 0 }) }],
    [{ action: "deposit", token: "USDC", amount: "5" }, { getWalletBalances: async () => ({ eth: 1, weth: 0, usdc: 50, totalUsd: 0 }) }],
    [{ action: "deposit", token: "ETH", amount: "1" }, { getWalletBalances: async () => ({ eth: 1, weth: 0, usdc: 50, totalUsd: 0 }) }],
    [{ action: "deposit", token: "USDC", amount: "5" }, { connected: false }],
    [{ action: "balance" }, { connected: false }],
    [{ action: "address" }, { connected: false }],
    [{ action: "add_liquidity", tokenA: "USDC", amountA: "25", tokenB: "ETH", amountB: "0.01" }],
    [{ action: "positions" }],
    [{ action: "remove_liquidity", amount: "all" }],
    [{ action: "remove_liquidity", amount: "50%", positionId: "9" }],
    [{ action: "price", token: "ETH" }],
  ];
  for (const [raw, over] of cases) clean(JSON.stringify(raw), await words(raw, over));
});

test("resolver: a deposit says it goes from your wallet into your account", async () => {
  const text = await words({ action: "deposit", token: "ETH", amount: "0.01" });
  assert.equal(text, "Move 0.01 ETH from your wallet into your account (~$25.00)");
});

test("policy: every reason shown to the user is plain", () => {
  const plan = (token = USDC_SEPOLIA, to = VITALIK) => ({ summary: "x", steps: [{ protocol: "native", action: "send" as const, params: { token, to }, estimatedGasWei: "0", order: 0 }] });
  const profile = { dailyLimitUsd: 100, verifiedTokens: ["0x0000000000000000000000000000000000000001"], knownAddresses: ["0x0000000000000000000000000000000000000002"], maxAutoTxPerDay: 1, typicalMaxUsd: 1 };
  const history = [{ valueUsd: 10, at: new Date().toISOString() }];
  const reasons = [
    decide({ intentType: "send", valueUsd: 500, dailyLimitUsd: 100, plan: plan(), profile, history }).reason,
    decide({ intentType: "send", valueUsd: 5, dailyLimitUsd: 100, plan: plan() }).reason,
    decide({ intentType: "balance", valueUsd: 0, dailyLimitUsd: 100, plan: plan() }).reason,
    decide({ intentType: "send", valueUsd: 5, dailyLimitUsd: 100, plan: { summary: "", steps: [] } }).reason,
    decide({ intentType: "send", valueUsd: 5, dailyLimitUsd: 100, plan: { summary: "x", steps: [] } }).reason,
    decide({ intentType: "unknown", valueUsd: 5, dailyLimitUsd: 100, plan: plan() }).reason,
    assessAction({ id: "1", intentType: "deposit", summary: "x", steps: [], params: {}, valueUsd: 1 }).reason,
  ];
  for (const r of reasons) clean("policy reason", r);
  assert.match(reasons[0], /needs your OK/);
});

test("guards: refusal texts for a bad swap price and a bad pool price are plain", () => {
  const c = checkSwapQuote({ symbolIn: "USDC", amountIn: 10, symbolOut: "ETH", amountOut: 0.0003 });
  clean("swap refusal", c!.reason!);
  const side = (symbol: string, decimals: number, address: string) => ({ symbol, decimals, address, native: false, amount: 1n });
  const msg = lpPriceProblem(2n ** 96n * 100n, side("USDC", 6, USDC_SEPOLIA), side("WETH", 18, "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"));
  if (msg) clean("pool refusal", msg);
});

const approval = (over: Partial<NewApproval>) => createApproval({
  wallet: "0xAbC0000000000000000000000000000000000001",
  safeAddress: "0x933f48ed12e2de3da82cc69c7a4f95c2adece3d1",
  intentType: "swap", summary: "x", valueUsd: 10, reason: "over limit",
  triggered: ["daily-limit", "daily-count-velocity", "unverified-token", "unknown-recipient", "habit-anomaly", "unknown-intent"],
  execution: { quoteData: { tokenIn: USDC_SEPOLIA, tokenOut: "0x0000000000000000000000000000000000000000", amount: "10000000", expectedOut: 0.004 } },
  ...over,
});
const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

test("telegram / phone page: every approval text says 'your account' and avoids jargon", () => {
  const list: NewApproval["intentType"][] = ["swap", "add_liquidity", "remove_liquidity"];
  const executions: Record<string, Record<string, unknown>> = {
    swap: { quoteData: { tokenIn: USDC_SEPOLIA, tokenOut: "0x0000000000000000000000000000000000000000", amount: "10000000", expectedOut: 0.004 } },
    add_liquidity: { lpData: { tokenA: WETH, symbolA: "ETH", amountA: "10000000000000000", tokenB: USDC_SEPOLIA, symbolB: "USDC", amountB: "25000000", feeTier: 3000, usedA: 0.01, usedB: 25 } },
    remove_liquidity: { lpRemoveData: { tokenId: "12", percent: 50, token0: USDC_SEPOLIA, token1: WETH, fee: 3000 } },
  };
  for (const t of list) {
    const a = approval({ intentType: t, execution: executions[t] });
    for (const phonePasskey of [false, true]) clean(`${t} message`, describeApproval(a, { phonePasskey }));
    const r = reviewOf(a);
    clean(`${t} review`, [r.title, r.why, r.network, ...r.details.flatMap((d) => [d.label, d.value])].join(" | "));
    assert.match(r.details.map((d) => d.value).join(" "), /your account/);
  }
  clean("undecodable", describeApproval(approval({ execution: { junk: 1 } })));
  assert.match(describeApproval(approval({})), /from your account/);
});

test("telegram: the reasons for asking read as sentences a newcomer understands", () => {
  const why = reviewOf(approval({})).why;
  assert.match(why, /daily limit for automatic actions/);
  assert.match(why, /bigger than you usually move/);
  clean("why", why);
});

test("telegram: outcome lines link to a receipt, not 'Etherscan'", () => {
  const done = approval({});
  done.status = "executed";
  done.result = { txHash: "0xabc", explorerUrl: "https://sepolia.etherscan.io/tx/0xabc" };
  const text = describeOutcome(done);
  assert.match(text, /View receipt/);
  assert.doesNotMatch(text.replace(/href="[^"]*"/, ""), /etherscan/i);
  for (const status of ["failed", "rejected", "expired", "executing"] as const) {
    done.status = status;
    done.error = "boom";
    clean(status, describeOutcome(done));
  }
});

test("replies: balance and address answers are plain, wrapped ETH is explained", () => {
  const b = { eth: 1, weth: 0.5, usdc: 500, totalUsd: 3000 };
  for (const t of [undefined, "ETH", "WETH", "USDC"]) clean(`balance ${t}`, describeBalances(b, t));
  clean("balance unreadable", describeBalances(null));
  assert.match(describeBalances(b, "WETH"), /wrapped ETH/);
  clean("address", describeAddresses(VITALIK, "0x933f48ed12e2de3da82cc69c7a4f95c2adece3d1"));
  clean("address, none yet", describeAddresses(VITALIK, null));
  assert.match(describeAddresses(VITALIK, "0x933f48ed12e2de3da82cc69c7a4f95c2adece3d1"), /Your account/);
});

test("planner prompt: still understands 'Safe' but tells the model to write plainly", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /"my Safe"/);
  assert.match(PLANNER_SYSTEM_PROMPT, /never "Safe"/);
});

// ── The chat's labels (frontend/src/lib/plainLanguage.js) ──
test("chat: the verdict pill is worded plainly for every verdict, and none says Safe", () => {
  assert.deepEqual(
    ["AUTO_EXECUTE", "NEEDS_APPROVAL", "BLOCKED", "INFO"].map(ui.verdictLabel),
    ["Done automatically", "Needs your OK", "Blocked", "Info"],
  );
  for (const label of Object.values(ui.VERDICT_LABELS) as string[]) clean("verdict label", label);
});

test("chat: a verdict we don't know never reads as 'done'", () => {
  assert.equal(ui.verdictLabel("UNKNOWN"), "Needs your OK");
  assert.equal(ui.verdictLabel(undefined), "Needs your OK");
});

test("chat: every rule the policy can trigger has a plain chip, never the raw slug", () => {
  const slugs = ["daily-limit", "daily-count-velocity", "unverified-token", "unknown-recipient", "habit-anomaly", "unknown-intent", "malformed", "denylist"];
  for (const slug of slugs) {
    const label: string = ui.ruleLabel(slug);
    assert.notEqual(label, slug);
    assert.ok(!label.includes("-"), label);
    clean("rule chip", label);
  }
  assert.equal(ui.ruleLabel("daily-limit"), "Over your daily limit");
  assert.equal(ui.ruleLabel("unknown-recipient"), "New recipient");
  assert.equal(ui.ruleLabel("something-new"), "Extra check");
});

test("chat: the suggested first actions are few, small and never mention the Safe", () => {
  const ex: string[] = ui.EXAMPLES;
  assert.ok(ex.length >= 4 && ex.length <= 6, `${ex.length} suggestions`);
  for (const e of ex) {
    clean("suggestion", e);
    for (const n of e.match(/\b\d+(\.\d+)?\b/g) ?? []) assert.ok(Number(n) <= 5, `"${e}" is not a small amount`);
  }
  assert.ok(ex.includes("What can I do here?") && ex.some((e) => /balance/i.test(e)));
  clean("welcome", `${ui.WELCOME.title} ${ui.WELCOME.intro}`);
  clean("receipt", ui.RECEIPT_LABEL);
});

test("chat: the welcome stays until the person has written something", () => {
  assert.equal(ui.showWelcome([]), true);
  // The agent's own messages (e.g. the passkey prompt for an email user) don't hide it.
  assert.equal(ui.showWelcome([{ role: "agent", passkeyPrompt: true }]), true);
  assert.equal(ui.showWelcome([{ role: "agent", passkeyPrompt: true }, { role: "user", text: "hi" }]), false);
});

test("chat and phone pages: no visible text says Safe, Etherscan or 'executed'", () => {
  const root = path.resolve(__dirname, "../../frontend/src");
  for (const file of ["app/simple/page.js", "app/phone/approve/[id]/page.js", "app/phone/setup/page.js", "lib/phone.js", "lib/plainLanguage.js"]) {
    const visible = fs.readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // comments and identifiers (SafeSetup, safe.deposit) are not what people read
      .join("\n")
      .replace(/\/\/ .*$/gm, "")
      .replace(/https?:\/\/\S+/g, "");
    assert.doesNotMatch(visible, /\bSafe\b|Etherscan|View on|\bExecuting\b|\bExecuted\b|Rejected\./, file);
  }
});

(async () => {
  console.log("plain language");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
