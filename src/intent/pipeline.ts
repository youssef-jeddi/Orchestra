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
} from "../policy";
import { planIntent, type PlanOptions, type PlanResult } from "./planner";
import { resolveSteps, type ResolveContext, type ResolvedStep, type PlanStep } from "./resolve";

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
}

export interface InterpretResult {
  outcome: IntentOutcome;
  planner: PlanResult;
}

const VALUE_BEARING = new Set(["swap", "send", "add_liquidity", "deposit"]);

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

  const resolved = await resolveSteps(out.steps, ctx);
  if (resolved.kind === "clarify") return { planner, outcome: { kind: "clarify", question: resolved.question } };
  if (resolved.kind === "unsupported") return { planner, outcome: { kind: "unsupported", reason: resolved.reason } };

  const actions = resolved.steps.filter((s) => VALUE_BEARING.has(s.action));
  if (actions.length === 0) return { planner, outcome: { kind: "read", steps: resolved.steps } };

  if (actions.length > 1) {
    const list = actions.map((s, i) => `${i + 1}. ${s.summary}`).join("\n");
    return {
      planner,
      outcome: { kind: "clarify", question: `I can only do one transaction per message for now. Which one should I do first?\n${list}` },
    };
  }

  const step = actions[0];
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
      },
    },
  };
}

export interface AssessInput {
  profile?: PolicyProfile;
  history?: ActivityRecord[];
  now?: number;
}

/** Deterministic verdict for an action. The LLM has no input here beyond the resolved plan. */
export function assessAction(action: ActionPlan, input: AssessInput = {}): PolicyDecision & { typicalMaxUsd?: number } {
  // A deposit is the user's own wallet funding their own Safe, signed in that
  // wallet. The agent never moves it, so the agent limits don't apply.
  if (action.intentType === "deposit") {
    return {
      verdict: "NEEDS_APPROVAL",
      riskScore: 0,
      reason: "Your own funds moving into your own Safe. You sign it in your wallet; it doesn't count toward your daily limit.",
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
  });
  return { ...decision, typicalMaxUsd };
}
