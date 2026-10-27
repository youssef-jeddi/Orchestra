// ─── Intent — pipeline ───
// message → planner (1 LLM call) → resolution → outcome, and the deterministic
// risk assessment of an action outcome. Shared by the /intent endpoint and the
// eval harness so both measure exactly the same code path.

import crypto from "crypto";
import type { ChatMessage } from "../integrations/llm";
import {
  decide,
  resolveDailyLimit,
  computeHabitProfile,
  type PolicyDecision,
  type PolicyProfile,
  type ActivityRecord,
  type IntentType,
  type PauseInfo,
} from "../policy";
import { messageSignals, type MessageSignals } from "../policy/messageSignals";
import { planIntent, type PlanOptions, type PlanResult } from "./planner";
import { resolveSteps, type ResolveContext, type ResolvedStep, type PlanStep, type AmountRule } from "./resolve";

export type IntentOutcome =
  | { kind: "reply"; text: string }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "read"; steps: ResolvedStep[] }
  | { kind: "action"; action: ActionPlan }
  | { kind: "plan"; plan: MultiStepPlan };

export interface ActionPlan {
  id: string;
  intentType: IntentType;
  summary: string;
  steps: PlanStep[];
  params: Record<string, any>;
  valueUsd: number;
  /** Pressure wording and addresses from the raw message. Signals only, never the text (ORC-90). */
  signals?: MessageSignals;
  /** All or most of the account's funds in this one action (see movesMostFunds). Decided by code, not the model. */
  movesAllFunds?: boolean;
}

/** One step of a multi-step plan: an action of its own, plus how its amounts are filled in when it runs. */
export interface PlanAction extends ActionPlan {
  /** See AmountRule. `fromStep` is an index into the plan's steps. */
  amounts: AmountRule[];
  /** What a swap step is expected to bring in (market estimate; the quote refines it). */
  output?: { symbol: string; amount: number };
}

/** Up to MAX_PLAN_STEPS money-moving steps, approved together and run one after another (ORC-21). */
export interface MultiStepPlan {
  id: string;
  summary: string;
  steps: PlanAction[];
  /** The total of the steps: what the plan counts toward the daily limit at most. */
  valueUsd: number;
  signals?: MessageSignals;
  movesAllFunds?: boolean;
}

/**
 * The most money-moving steps one message may hold. Each runs as its own transaction and each
 * waits for the one before, so a long plan keeps the user waiting and widens what one OK covers.
 */
export const MAX_PLAN_STEPS = 3;

export const TOO_MANY_STEPS_REASON = (n: number) =>
  `That's ${n} things to do at once, and I can do up to ${MAX_PLAN_STEPS} in one message. Please split it into smaller requests.`;
export const PLAN_WITH_DEPOSIT_REASON =
  "Moving money from your wallet into your account is something you confirm yourself in your wallet. Ask for that on its own first, then for the rest.";

/** "I'll do these 2 things, one after another:\n1. …\n2. …" (the plan's card and approval summary). */
export function planSummary(summaries: string[]): string {
  return `I'll do these ${summaries.length} things, one after another:\n${summaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}

export interface InterpretResult {
  outcome: IntentOutcome;
  planner: PlanResult;
}

/**
 * At or above this share of a balance an action counts as moving "most of the funds". A
 * pressured message that empties an account is the shape of a drain, and 90% leaves no room
 * to dodge the check by asking for "all but a few dollars".
 */
export const MOST_OF_BALANCE = 0.9;

const SYMBOL_KEY: Record<string, "eth" | "weth" | "usdc"> = { ETH: "eth", WETH: "weth", USDC: "usdc" };

/** True when the planner step asks for everything: "all", "max" or a percentage of 90 or more. */
function isAllAmount(amount: unknown): boolean {
  if (typeof amount !== "string") return false;
  if (amount === "all" || amount === "max") return true;
  return amount.endsWith("%") && Number(amount.slice(0, -1)) / 100 >= MOST_OF_BALANCE;
}

/**
 * Whether the action moves all or most of the funds: the planner step says all/max/90%+, the
 * message says so, or the resolved amount is 90%+ of the balance. Balances are read only when the
 * message has pressure wording; an unreadable balance counts as "not all" (the pressure rule still asks).
 */
async function movesMostFunds(
  planned: { action: string; amount?: unknown; amountA?: unknown; amountB?: unknown } | undefined,
  step: ResolvedStep,
  signals: MessageSignals,
  ctx: ResolveContext
): Promise<boolean> {
  if (signals.allFunds) return true;
  if (step.action === "remove_liquidity") return false; // the user's own position, it comes back to the account
  if (planned && [planned.amount, planned.amountA, planned.amountB].some(isAllAmount)) return true;
  if (signals.pressure.length === 0) return false;

  const p = step.plan.params;
  const spends: [unknown, unknown][] =
    step.action === "swap" ? [[p.amount, p.symbolIn]]
    : step.action === "send" ? [[p.amount, p.symbol]]
    : step.action === "add_liquidity" ? [[p.amountA, p.symbolA], [p.amountB, p.symbolB]]
    : [];
  if (spends.length === 0) return false;
  try {
    const balances = await ctx.getBalances();
    if (!balances) return false;
    return spends.some(([amount, symbol]) => {
      const held = (balances as any)[SYMBOL_KEY[String(symbol).toUpperCase()]];
      return typeof held === "number" && held > 0 && Number(amount) >= held * MOST_OF_BALANCE;
    });
  } catch {
    return false;
  }
}

const VALUE_BEARING = new Set(["swap", "send", "add_liquidity", "remove_liquidity", "deposit"]);

export async function interpretIntent(
  message: string,
  history: ChatMessage[],
  ctx: ResolveContext,
  opts: PlanOptions = {}
): Promise<InterpretResult> {
  const planner = await planIntent(message, history, opts);
  const out = planner.output;

  if (out.type === "reply") return { planner, outcome: { kind: "reply", text: out.text } };
  if (out.type === "clarify") return { planner, outcome: { kind: "clarify", question: out.question } };
  if (out.type === "unsupported") return { planner, outcome: { kind: "unsupported", reason: out.reason } };

  // Asked before resolution, so a balance answer ("not enough USDC") never takes the place of the
  // limits/price answer: with the limits unreadable or no fresh price, nothing about a spend is built.
  const gateReason = ctx.valueGate && out.steps.some((s) => VALUE_BEARING.has(s.action)) ? await ctx.valueGate() : null;
  if (gateReason) return { planner, outcome: { kind: "unsupported", reason: gateReason } };

  const resolved = await resolveSteps(out.steps, ctx);
  if (resolved.kind === "clarify") return { planner, outcome: { kind: "clarify", question: resolved.question } };
  if (resolved.kind === "unsupported") return { planner, outcome: { kind: "unsupported", reason: resolved.reason } };

  const actions = resolved.steps.filter((s) => VALUE_BEARING.has(s.action));
  if (actions.length === 0) return { planner, outcome: { kind: "read", steps: resolved.steps } };

  const signals = messageSignals(message);
  if (actions.length > 1) {
    if (actions.length > MAX_PLAN_STEPS) return { planner, outcome: { kind: "unsupported", reason: TOO_MANY_STEPS_REASON(actions.length) } };
    // A deposit is signed in the user's own wallet, not run by the agent: it can't be one of the agent's steps.
    if (actions.some((s) => s.action === "deposit")) return { planner, outcome: { kind: "unsupported", reason: PLAN_WITH_DEPOSIT_REASON } };
    const steps: PlanAction[] = [];
    for (const s of actions) {
      const index = resolved.steps.indexOf(s);
      steps.push({
        id: crypto.randomUUID(),
        intentType: s.plan.action,
        summary: s.summary,
        steps: [s.plan],
        params: s.plan.params,
        valueUsd: s.valueUsd,
        signals,
        movesAllFunds: await movesMostFunds(out.steps[index], s, signals, ctx),
        // `fromStep` pointed at the message's steps; the plan holds only the money-moving ones.
        amounts: (s.amounts ?? []).map((r) => (r.fromStep == null ? r : { ...r, fromStep: actions.indexOf(resolved.steps[r.fromStep]) })),
        ...(s.output ? { output: s.output } : {}),
      });
    }
    return {
      planner,
      outcome: {
        kind: "plan",
        plan: {
          id: crypto.randomUUID(),
          summary: planSummary(steps.map((s) => s.summary)),
          steps,
          valueUsd: steps.reduce((sum, s) => sum + s.valueUsd, 0),
          signals,
          movesAllFunds: steps.some((s) => s.movesAllFunds),
        },
      },
    };
  }

  const step = actions[0];
  const movesAllFunds = await movesMostFunds(out.steps[resolved.steps.indexOf(step)], step, signals, ctx);
  return {
    planner,
    outcome: {
      kind: "action",
      action: {
        id: crypto.randomUUID(),
        intentType: step.plan.action,
        summary: step.summary,
        steps: [step.plan],
        params: step.plan.params,
        valueUsd: step.valueUsd,
        signals,
        movesAllFunds,
      },
    },
  };
}

export interface AssessInput {
  profile?: PolicyProfile;
  history?: ActivityRecord[];
  now?: number;
  /** The kill switch (ORC-39): while set, nothing runs on its own. Deposits are signed by the user and unaffected. */
  paused?: PauseInfo | null;
}

/** Deterministic verdict for an action. The LLM has no input here beyond the resolved plan. */
export function assessAction(action: ActionPlan, input: AssessInput = {}): PolicyDecision & { typicalMaxUsd?: number } {
  // A deposit is the user's own wallet funding their own account, signed in that
  // wallet. The agent never moves it, so the agent limits don't apply.
  if (action.intentType === "deposit") {
    return {
      verdict: "NEEDS_APPROVAL",
      riskScore: 0,
      reason: "Your own money moving from your wallet into your own account. You confirm it in your wallet, and it doesn't count toward your daily limit.",
      requiresLedger: false,
      triggered: [],
      approvalMethod: "wallet",
    };
  }

  let profile = input.profile;
  let typicalMaxUsd: number | undefined;

  // Learn the habit baseline from activity when not explicitly configured.
  // Fail-closed: the anomaly rule only escalates, so a derived baseline is safe.
  if (profile && input.history && profile.typicalMaxUsd == null) {
    const habit = computeHabitProfile(input.history);
    if (habit.typicalMaxUsd != null) {
      typicalMaxUsd = habit.typicalMaxUsd;
      profile = { ...profile, typicalMaxUsd };
    }
  }

  const decision = decide({
    intentType: action.intentType,
    valueUsd: action.valueUsd,
    dailyLimitUsd: resolveDailyLimit(profile?.dailyLimitUsd),
    // The Ledger tier is off unless LEDGER_APPROVAL=on: every approval is then a passkey
    // (or a wallet signature when no passkey is registered), whatever the amount.
    hardwareThresholdUsd: process.env.LEDGER_APPROVAL === "on" ? profile?.hardwareThresholdUsd : Infinity,
    plan: { summary: action.summary, steps: action.steps },
    profile,
    history: input.history,
    now: input.now,
    signals: action.signals,
    movesAllFunds: action.movesAllFunds,
    paused: input.paused,
  });
  return { ...decision, typicalMaxUsd };
}

const VERDICT_RANK: Record<string, number> = { AUTO_EXECUTE: 0, INFO: 0, NEEDS_APPROVAL: 1, BLOCKED: 2 };
const METHOD_RANK: Record<string, number> = { none: 0, wallet: 1, passkey: 2, ledger: 3 };

/**
 * Deterministic verdict for a multi-step plan (ORC-21). Every step is checked on its own, with the
 * steps before it counted as already spent (so the daily limit and the count of automatic actions
 * see the whole plan), and the plan's total is checked as one action. The strictest answer wins:
 * one step that needs an OK makes the whole plan need it, one refused step refuses the plan.
 */
export function assessPlan(plan: MultiStepPlan, input: AssessInput = {}): PolicyDecision & { typicalMaxUsd?: number } {
  const now = input.now ?? Date.now();
  // The habit baseline comes from what really ran, never from this plan's own steps.
  let profile = input.profile;
  let typicalMaxUsd: number | undefined;
  if (profile && input.history && profile.typicalMaxUsd == null) {
    const habit = computeHabitProfile(input.history);
    if (habit.typicalMaxUsd != null) {
      typicalMaxUsd = habit.typicalMaxUsd;
      profile = { ...profile, typicalMaxUsd };
    }
  }
  // A recipient typed in the message is "planned" when any step pays it, not only the step being checked.
  const signals = plan.signals && planSignals(plan, profile);
  const allSteps = plan.steps.flatMap((s) => s.steps);

  const total = assessAction(
    { ...plan, intentType: "swap", steps: allSteps, params: {}, signals },
    { ...input, profile, now },
  );
  const decisions: PolicyDecision[] = [total];
  let history = [...(input.history ?? [])];
  for (const step of plan.steps) {
    decisions.push(assessAction({ ...step, signals }, { ...input, profile, history, now }));
    history = [...history, { valueUsd: step.valueUsd, at: new Date(now).toISOString(), source: "auto" }];
  }

  const worst = decisions.reduce((a, b) => (VERDICT_RANK[b.verdict] > VERDICT_RANK[a.verdict] ? b : a));
  if (worst.verdict === "BLOCKED") return { ...worst, typicalMaxUsd };
  if (worst.verdict !== "NEEDS_APPROVAL") return { ...total, typicalMaxUsd };

  // One reason per rule, the plan-wide one first, so the card doesn't repeat itself.
  const held = decisions.filter((d) => d.verdict === "NEEDS_APPROVAL");
  const triggered = [...new Set(held.flatMap((d) => d.triggered))];
  const reasons = [...new Set(held.map((d) => d.reason))];
  const approvalMethod = held.map((d) => d.approvalMethod).reduce((a, b) => ((METHOD_RANK[b] ?? 0) > (METHOD_RANK[a] ?? 0) ? b : a));
  return {
    verdict: "NEEDS_APPROVAL",
    riskScore: Math.max(...held.map((d) => d.riskScore)),
    reason: reasons.join(" "),
    requiresLedger: approvalMethod === "ledger",
    triggered,
    approvalMethod,
    typicalMaxUsd,
  };
}

/** The message's signals with the mentions every step accounts for removed (a step's recipient, a label in the summary). */
function planSignals(plan: MultiStepPlan, profile: PolicyProfile | undefined): MessageSignals {
  const s = plan.signals!;
  const recipients = new Set(plan.steps.map((st) => String(st.params.to ?? "").toLowerCase()).filter(Boolean));
  const known = new Set((profile?.knownAddresses ?? []).filter((a) => typeof a === "string").map((a) => a.toLowerCase()));
  const summary = plan.summary.toLowerCase();
  const mentions = s.mentions.filter((m) => (m.startsWith("0x") ? !recipients.has(m) && !known.has(m) : !summary.includes(m)));
  return { ...s, mentions };
}
