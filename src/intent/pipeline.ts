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
import { resolveSteps, type ResolveContext, type ResolvedStep, type PlanStep } from "./resolve";
import { isComingSoonStep } from "./schema";
import { describeComingSoon } from "./comingSoon";

export type IntentOutcome =
  | { kind: "reply"; text: string }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "read"; steps: ResolvedStep[] }
  | { kind: "action"; action: ActionPlan };

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

  // Planned DeFi actions (stake, lend, borrow, savings vaults) are answered in words here, before
  // the value gate, the resolver, the limits or an approval: nothing in such a message is built or
  // run, not even a supported step next to it, so a planned action can never reach execution.
  const comingSoon = out.steps.filter(isComingSoonStep);
  if (comingSoon.length > 0) {
    return { planner, outcome: { kind: "reply", text: describeComingSoon(comingSoon, out.steps.length - comingSoon.length, out.language) } };
  }

  // Asked before resolution, so a balance answer ("not enough USDC") never takes the place of the
  // limits/price answer: with the limits unreadable or no fresh price, nothing about a spend is built.
  const gateReason = ctx.valueGate && out.steps.some((s) => VALUE_BEARING.has(s.action)) ? await ctx.valueGate() : null;
  if (gateReason) return { planner, outcome: { kind: "unsupported", reason: gateReason } };

  const resolved = await resolveSteps(out.steps, ctx);
  if (resolved.kind === "clarify") return { planner, outcome: { kind: "clarify", question: resolved.question } };
  if (resolved.kind === "unsupported") return { planner, outcome: { kind: "unsupported", reason: resolved.reason } };

  const actions = resolved.steps.filter((s) => VALUE_BEARING.has(s.action));
  if (actions.length === 0) return { planner, outcome: { kind: "read", steps: resolved.steps } };

  if (actions.length > 1) {
    const list = actions.map((s, i) => `${i + 1}. ${s.summary}`).join("\n");
    return {
      planner,
      outcome: { kind: "clarify", question: `I can only do one thing per message for now. Which one should I do first?\n${list}` },
    };
  }

  const step = actions[0];
  const signals = messageSignals(message);
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
