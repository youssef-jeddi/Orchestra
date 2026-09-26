// ─── Orchestra eval harness ───
// Scores intent parsing and end-to-end risk verdicts against labelled datasets.
//
//   npm run eval -- [--suite parsing|risk|all] [--target new|legacy|new,legacy]
//                   [--provider groq|anthropic] [--model <id>] [--concurrency N]
//                   [--filter <tag|id>] [--replay] [--no-cache] [--verbose]
//
// Targets:
//   new     src/intent pipeline (schema-validated planner + resolver + policy)
//   legacy  the previous Planner agent (src/agents/planner) + the same policy
//
// Deterministic by construction: fixed prices, stubbed ENS, in-memory storage.
// LLM responses are cached in eval/.cache (keyed by model + full prompt), so
// re-runs are free; --replay fails on a cache miss instead of calling the API.

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const EVAL_DIR = __dirname;
const FIXED_PRICES = { ETH: 2500, WETH: 2500, USDC: 1, USDT: 1 };
const WALLET = "0x9999999999999999999999999999999999999999";
const DEFAULT_BALANCES = { eth: 1, weth: 0.5, usdc: 500 };
const ENS: Record<string, string> = {
  "vitalik.eth": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "alice.eth": "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
};

type Outcome = "AUTO_EXECUTE" | "NEEDS_APPROVAL" | "BLOCKED" | "INFO" | "NO_ACTION";

interface ParsingCase {
  id: string;
  tags: string[];
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
  expect: Expectation | Expectation[];
}
interface Expectation {
  type: string;
  steps?: Record<string, string>[];
}
interface RiskCase {
  id: string;
  tags: string[];
  message: string;
  context?: {
    wallet?: boolean;
    balances?: Partial<typeof DEFAULT_BALANCES>;
    policy?: Record<string, unknown>;
    activity?: { valueUsd: number; hoursAgo: number; to?: string }[];
  };
  expect: Outcome[];
}

interface Args {
  suite: string;
  targets: string[];
  provider?: "groq" | "anthropic";
  model?: string;
  concurrency: number;
  filter?: string;
  replay: boolean;
  cache: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    suite: get("--suite") || "all",
    targets: (get("--target") || "new").split(","),
    provider: get("--provider") as Args["provider"],
    model: get("--model"),
    concurrency: Number(get("--concurrency") || 2),
    filter: get("--filter"),
    replay: argv.includes("--replay"),
    cache: !argv.includes("--no-cache"),
  };
}

function loadJsonl<T>(file: string): T[] {
  return fs
    .readFileSync(path.join(EVAL_DIR, "datasets", file), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// ── Normalisation (so "10" == "10.0", "usdc" == "USDC", …) ──
const TOKEN_KEYS = new Set(["from", "token", "tokenA", "tokenB"]);
const AMOUNT_KEYS = new Set(["amount", "amountA", "amountB"]);

function normValue(key: string, value: unknown, action: string): string {
  const s = String(value ?? "").trim();
  if (TOKEN_KEYS.has(key) || (key === "to" && action === "swap")) {
    const t = s.toUpperCase();
    // Swap routing treats ETH and WETH identically (both route via WETH).
    return action === "swap" && t === "WETH" ? "ETH" : t;
  }
  if (AMOUNT_KEYS.has(key)) {
    const a = s.toLowerCase().replace(/[,\s]/g, "");
    if (a === "max") return "all";
    return /^\d*\.?\d+$/.test(a) ? String(Number(a)) : a;
  }
  if (key === "to") return s.toLowerCase();
  return s.toLowerCase();
}

function normStep(step: Record<string, unknown>): Record<string, string> {
  const action = String(step.action ?? "");
  const out: Record<string, string> = { action };
  for (const [k, v] of Object.entries(step)) {
    if (k === "action" || v == null || v === "") continue;
    out[k] = normValue(k, v, action);
  }
  if (action === "swap" || action === "send") out.unit = out.unit || "token";
  if (action === "swap") out.side = out.side || "in";
  return out;
}

function matches(expected: Expectation, actual: { type: string; steps?: Record<string, string>[] }): boolean {
  if (expected.type !== actual.type) return false;
  if (!expected.steps) return true;
  if (!actual.steps || actual.steps.length !== expected.steps.length) return false;
  return expected.steps.every((raw, i) => {
    const exp = normStep(raw);
    const act = actual.steps![i];
    return Object.entries(exp).every(([k, v]) => act[k] === v);
  });
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Harness output; app modules' console.log is muted unless --verbose. */
function out(...parts: unknown[]): void {
  process.stdout.write(parts.map(String).join(" ") + "\n");
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.argv.includes("--verbose")) {
    console.log = () => {};
    console.warn = () => {};
  }

  // Deterministic environment — must be set before the app modules load.
  delete process.env.ZERO_G_PRIVATE_KEY;
  if (args.provider) process.env.LLM_PROVIDER = args.provider;
  if (args.model) {
    if ((args.provider ?? process.env.LLM_PROVIDER) === "anthropic") process.env.ANTHROPIC_MODEL = args.model;
    else process.env.GROQ_MODEL = args.model;
  }
  if (args.cache) process.env.LLM_CACHE_DIR = path.join(EVAL_DIR, ".cache");
  process.env.LLM_MAX_WAIT_MS ||= "180000";
  if (args.replay) process.env.LLM_CACHE_MODE = "replay";

  const policy = await import("../src/policy");
  policy.setPrices(FIXED_PRICES);
  const { planIntent, sanitizeHistory } = await import("../src/intent/planner");
  const { interpretIntent, assessAction } = await import("../src/intent/pipeline");
  const { defaultModel, defaultProvider, llmStats } = await import("../src/integrations/llm");
  const { runPlanner } = await import("../src/agents/planner/index");
  const { buildActionPlan } = await import("../src/agents/planner/actions/writeActionPlan");
  const { write } = await import("../src/integrations/zero-g/storage");

  const provider = defaultProvider();
  const model = defaultModel(provider);
  const filterFn = (c: { id: string; tags: string[] }) =>
    !args.filter || c.id === args.filter || c.id.startsWith(args.filter) || c.tags.includes(args.filter);

  // ── Legacy planner adapter: message → normalised planner-level output ──
  // Legacy runs at concurrency 1, so the global LLM counters attribute cleanly to one case.
  async function legacyPlan(message: string) {
    const before = llmStats.latencyMs;
    await write("messages:latest", { message, walletAddress: WALLET, timestamp: new Date().toISOString() });
    const r = await runPlanner(message);
    const latencyMs = llmStats.latencyMs - before;
    if (r.action !== "writeActionPlan") return { plan: null, latencyMs, reasoning: r.reasoning };
    return { plan: buildActionPlan(r.args), latencyMs, reasoning: r.reasoning };
  }

  function legacySteps(plan: any): Record<string, string>[] {
    return (plan.steps || []).map((s: any) => {
      const p = s.params || {};
      if (s.action === "swap") {
        return normStep({
          action: "swap",
          from: p.symbolIn || policy.symbolFromAddress(p.tokenIn || "", "?"),
          to: p.symbolOut || policy.symbolFromAddress(p.tokenOut || "", "?"),
          amount: p.amount,
        });
      }
      if (s.action === "send") {
        return normStep({ action: "send", token: p.symbol || policy.symbolFromAddress(p.token || "", "?"), amount: p.amount, to: p.to });
      }
      if (s.action === "add_liquidity") {
        return normStep({ action: "add_liquidity", tokenA: p.symbolA, amountA: p.amountA, tokenB: p.symbolB, amountB: p.amountB });
      }
      return normStep({ action: s.action });
    });
  }

  const report: Record<string, any> = { startedAt: new Date().toISOString(), provider, model, suites: {} };

  // ═══ Parsing suite ═══
  if (args.suite === "all" || args.suite === "parsing") {
    const cases = loadJsonl<ParsingCase>("parsing.jsonl").filter(filterFn);
    for (const target of args.targets) {
      out(`\n▶ parsing · ${target} · ${model} · ${cases.length} cases`);
      const conc = target === "legacy" ? 1 : args.concurrency; // legacy shares a storage slot
      const results = await pool(cases, conc, async (c) => {
        const expectations = Array.isArray(c.expect) ? c.expect : [c.expect];
        let actual: { type: string; steps?: Record<string, string>[] };
        let latencyMs = 0;
        let attempts = 1;
        let failed = false;
        let error: string | undefined;
        try {
          if (target === "legacy") {
            const r = await legacyPlan(c.message);
            latencyMs = r.latencyMs;
            actual = r.plan ? { type: "actions", steps: legacySteps(r.plan) } : { type: "none" };
          } else {
            const r = await planIntent(c.message, sanitizeHistory(c.history));
            latencyMs = r.modelMs;
            attempts = r.attempts;
            failed = r.failed;
            const o = r.output;
            actual = o.type === "actions" ? { type: "actions", steps: o.steps.map((s) => normStep(s as any)) } : { type: o.type };
          }
        } catch (err: any) {
          error = err.message;
          actual = { type: "error" };
        }
        const pass = expectations.some((e) => matches(e, actual));
        const typePass = expectations.some((e) => e.type === actual.type);
        const mark = pass ? "✓" : typePass ? "~" : "✗";
        out(`  ${mark} ${c.id.padEnd(16)} ${String(latencyMs).padStart(5)}ms  ${pass ? "" : JSON.stringify(actual).slice(0, 160)}${error ? ` ERROR ${error.slice(0, 120)}` : ""}`);
        return { id: c.id, tags: c.tags, message: c.message, expect: c.expect, actual, pass, typePass, latencyMs, attempts, failed, error };
      });

      const byTag: Record<string, { n: number; pass: number }> = {};
      for (const r of results) for (const t of r.tags) {
        byTag[t] ??= { n: 0, pass: 0 };
        byTag[t].n++;
        if (r.pass) byTag[t].pass++;
      }
      const lat = results.filter((r) => !r.error).map((r) => r.latencyMs);
      const summary = {
        cases: results.length,
        exactMatch: results.filter((r) => r.pass).length,
        typeMatch: results.filter((r) => r.typePass).length,
        repairs: results.filter((r) => r.attempts > 1).length,
        fallbacks: results.filter((r) => r.failed).length,
        errors: results.filter((r) => r.error).length,
        modelLatencyP50: percentile(lat, 50),
        modelLatencyP95: percentile(lat, 95),
        byTag,
      };
      out(`  ── exact ${pct(summary.exactMatch, summary.cases)} · type ${pct(summary.typeMatch, summary.cases)} · repairs ${summary.repairs} · fallbacks ${summary.fallbacks} · errors ${summary.errors} · model latency p50 ${summary.modelLatencyP50}ms · p95 ${summary.modelLatencyP95}ms`);
      out(`  ── by tag: ${Object.entries(byTag).map(([t, v]) => `${t} ${v.pass}/${v.n}`).join(" · ")}`);
      report.suites[`parsing:${target}`] = { summary, results };
    }
  }

  // ═══ Risk suite ═══
  if (args.suite === "all" || args.suite === "risk") {
    const cases = loadJsonl<RiskCase>("risk.jsonl").filter(filterFn);
    for (const target of args.targets) {
      out(`\n▶ risk · ${target} · ${model} · ${cases.length} cases`);
      const conc = target === "legacy" ? 1 : args.concurrency;
      const results = await pool(cases, conc, async (c) => {
        const now = Date.now();
        const ctx = c.context || {};
        const balances = { ...DEFAULT_BALANCES, ...(ctx.balances || {}) };
        const profile = (ctx.policy || {}) as any;
        const activity = (ctx.activity || [])
          .map((a) => ({ valueUsd: a.valueUsd, to: a.to, at: new Date(now - a.hoursAgo * 3_600_000).toISOString() }))
          // The server only hands the policy the trailing 24h (policy/store.getRecentActivity).
          .filter((a) => Date.parse(a.at) >= now - 24 * 3_600_000);

        let outcome: Outcome;
        let detail = "";
        let latencyMs = 0;
        let error: string | undefined;
        try {
          if (target === "legacy") {
            const r = await legacyPlan(c.message);
            latencyMs = r.latencyMs;
            if (!r.plan) {
              outcome = "NO_ACTION";
            } else {
              const steps = r.plan.steps as any[];
              const intentType = policy.detectIntentType(steps);
              const params = steps[0]?.params || {};
              const valueUsd = policy.computePlanValueUsd(intentType, params, r.plan.totalEstimatedValueUsd || 0);
              const d = assessAction(
                { id: r.plan.id, intentType, summary: r.plan.summary, steps: steps as any, params, valueUsd },
                { profile, history: activity, now }
              );
              outcome = d.verdict as Outcome;
              detail = `${r.plan.summary} ($${valueUsd.toFixed(2)}) ${d.triggered.join(",")}`;
            }
          } else {
            const { outcome: o, planner } = await interpretIntent(c.message, [], {
              connected: ctx.wallet !== false,
              getBalances: async () => ({ ...balances, totalUsd: 0 }),
              resolveEns: async (name) => ENS[name.toLowerCase()] ?? null,
            });
            latencyMs = planner.modelMs;
            if (o.kind === "action") {
              const d = assessAction(o.action, { profile, history: activity, now });
              outcome = d.verdict as Outcome;
              detail = `${o.action.summary} ${d.triggered.join(",")}`;
            } else if (o.kind === "read") {
              outcome = "INFO";
            } else {
              outcome = "NO_ACTION";
              detail = `${o.kind}: ${"question" in o ? o.question : "reason" in o ? o.reason : o.text}`.slice(0, 120);
            }
          }
        } catch (err: any) {
          error = err.message;
          outcome = "NO_ACTION";
        }
        const pass = c.expect.includes(outcome);
        const falseAuto = outcome === "AUTO_EXECUTE" && !pass;
        const overEscalation = !pass && c.expect.includes("AUTO_EXECUTE");
        out(`  ${pass ? "✓" : falseAuto ? "✗!" : "✗"} ${c.id.padEnd(14)} ${outcome.padEnd(14)} ${pass ? "" : `expected ${c.expect.join("|")}`}  ${detail}${error ? ` ERROR ${error.slice(0, 120)}` : ""}`);
        return { id: c.id, tags: c.tags, message: c.message, expect: c.expect, outcome, pass, falseAuto, overEscalation, detail, latencyMs, error };
      });

      const core = results.filter((r) => !r.tags.includes("phase3"));
      const summary = {
        cases: results.length,
        correct: results.filter((r) => r.pass).length,
        falseAutoExecute: results.filter((r) => r.falseAuto).map((r) => r.id),
        overEscalation: results.filter((r) => r.overEscalation).map((r) => r.id),
        coreCases: core.length,
        coreCorrect: core.filter((r) => r.pass).length,
        coreFalseAutoExecute: core.filter((r) => r.falseAuto).map((r) => r.id),
        errors: results.filter((r) => r.error).length,
      };
      out(`  ── correct ${pct(summary.correct, summary.cases)} · FALSE AUTO-EXECUTE ${summary.falseAutoExecute.length} [${summary.falseAutoExecute.join(", ")}] · over-escalation ${summary.overEscalation.length} · errors ${summary.errors}`);
      out(`  ── excluding phase3 cases: correct ${pct(summary.coreCorrect, summary.coreCases)} · false auto-execute ${summary.coreFalseAutoExecute.length}`);
      report.suites[`risk:${target}`] = { summary, results };
    }
  }

  const outDir = path.join(EVAL_DIR, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(outDir, `${stamp}_${args.suite}_${args.targets.join("+")}_${model.replace(/[^\w.-]+/g, "_")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  out(`\nSaved ${path.relative(process.cwd(), file)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
