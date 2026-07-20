// ─── Policy — Deterministic risk engine ───
// The authoritative, side-effect-free layer that decides what happens to a plan.
//
// This is the "server-side safety net" extracted verbatim from the /intent
// handler. It takes the AI's advisory verdict and the plan's value, and applies
// deterministic rules that the AI can never override. Keep this pure and tested:
// it is the last line of defense before funds move.
//
// STEP 1 (this file): behaviour-identical extraction of the existing logic.
// Later steps will grow this into a full policy engine (limits, allow-lists,
// velocity caps) that replaces — rather than patches — the Gatekeeper LLM verdict.

import { estimateUsd, symbolFromAddress } from "./prices";

export type Verdict = "AUTO_EXECUTE" | "NEEDS_APPROVAL" | "BLOCKED" | "INFO";

export type IntentType = "swap" | "send" | "add_liquidity" | "balance" | "unknown";

export const DEFAULT_AUTO_APPROVE_LIMIT = 100;

// ─── Intent classification (from AI plan steps) ───
export function detectIntentType(steps: any[]): IntentType {
  if (!steps || steps.length === 0) return "unknown";
  const action = steps[0]?.action;
  if (action === "swap") return "swap";
  if (action === "send") return "send";
  if (action === "add_liquidity") return "add_liquidity";
  if (action === "balance") return "balance";
  return "unknown";
}

// ─── Spending limit resolution ───
// Trust a positive numeric client limit; otherwise fall back to the default.
export function resolveAutoApproveLimit(clientLimit: unknown): number {
  return typeof clientLimit === "number" && clientLimit > 0
    ? clientLimit
    : DEFAULT_AUTO_APPROVE_LIMIT;
}

// ─── Server-side USD recomputation ───
// Never trust the AI's estimate — recompute from the step params for swap/send.
// For any other intent type, fall back to the plan's declared value.
export function computePlanValueUsd(
  intentType: IntentType,
  params: Record<string, any>,
  fallbackUsd: number
): number {
  if (intentType === "swap") {
    const sym = params.symbolIn || symbolFromAddress(params.tokenIn || "", "ETH");
    return estimateUsd(sym, Number(params.amount || 0));
  }
  if (intentType === "send") {
    return estimateUsd(params.symbol || "ETH", Number(params.amount || 0));
  }
  return fallbackUsd || 0;
}

export interface PolicyInput {
  intentType: IntentType;
  valueUsd: number;
  autoApproveLimit: number;
  aiVerdict: Verdict;
  aiRiskScore: number;
}

export interface PolicyResult {
  verdict: Verdict;
  riskScore: number;
  /** Human-readable note when the deterministic engine overrode the AI, else null. */
  override: string | null;
}

// ─── The safety net ───
// Deterministic rules that override the AI verdict when it's clearly wrong.
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { intentType, valueUsd, autoApproveLimit, aiVerdict, aiRiskScore } = input;

  let verdict: Verdict = aiVerdict;
  let riskScore = aiRiskScore;
  let override: string | null = null;

  if (intentType === "balance") {
    verdict = "INFO";
    riskScore = 0;
  } else if (intentType === "swap" || intentType === "send") {
    // AI said AUTO_EXECUTE but amount is over the limit → override up.
    if (valueUsd > autoApproveLimit && verdict === "AUTO_EXECUTE") {
      verdict = "NEEDS_APPROVAL";
      riskScore = Math.max(riskScore, 70);
      override = `overrode AUTO_EXECUTE → NEEDS_APPROVAL ($${valueUsd} > $${autoApproveLimit})`;
    }
    // AI said NEEDS_APPROVAL but amount is under the limit → override down.
    if (valueUsd <= autoApproveLimit && verdict === "NEEDS_APPROVAL") {
      verdict = "AUTO_EXECUTE";
      riskScore = Math.min(riskScore, 15);
      override = `overrode NEEDS_APPROVAL → AUTO_EXECUTE ($${valueUsd} <= $${autoApproveLimit})`;
    }
  }

  return { verdict, riskScore, override };
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 2 — Authoritative deterministic decision
// ═══════════════════════════════════════════════════════════════════════
// `decide` computes the verdict from scratch — no AI verdict as input. This is
// what lets the /intent pipeline drop the second (Gatekeeper) LLM call entirely:
// interpretation stays with the Planner LLM, the verdict is pure code.
//
// `evaluatePolicy` above is retained as the "reconcile an advisory AI verdict"
// helper (and to pin the original safety-net semantics under test). The hot path
// uses `decide`.

/** Denylisted token addresses (lowercased). Hook for a future threat feed. */
export const DENYLISTED_TOKENS = new Set<string>([]);

export interface PlanShape {
  summary?: unknown;
  steps?: any[];
}

export interface DecisionInput {
  intentType: IntentType;
  valueUsd: number;
  autoApproveLimit: number;
  plan: PlanShape;
}

export interface PolicyDecision {
  verdict: Verdict;
  riskScore: number;
  /** Deterministic, human-readable explanation of the rule that fired. */
  reason: string;
  requiresLedger: boolean;
}

/** Scan plan steps for any token address on the denylist. Returns it, or null. */
function findDenylistedToken(steps: any[]): string | null {
  for (const step of steps) {
    const p = step?.params || {};
    for (const addr of [p.tokenIn, p.tokenOut, p.token, p.tokenA, p.tokenB]) {
      if (typeof addr === "string" && DENYLISTED_TOKENS.has(addr.toLowerCase())) {
        return addr;
      }
    }
  }
  return null;
}

/**
 * The authoritative verdict. Deterministic, explainable, fail-closed.
 * Rule order mirrors the old Gatekeeper prompt, but as code:
 *   1. balance          → INFO (read-only)
 *   2. malformed plan    → BLOCKED
 *   3. denylisted token  → BLOCKED
 *   4. value vs limit    → AUTO_EXECUTE / NEEDS_APPROVAL
 *   5. unrecognized      → NEEDS_APPROVAL (fail closed)
 */
export function decide(input: DecisionInput): PolicyDecision {
  const { intentType, valueUsd, autoApproveLimit, plan } = input;

  // 1. Read-only query.
  if (intentType === "balance") {
    return { verdict: "INFO", riskScore: 0, reason: "Read-only query — no funds move.", requiresLedger: false };
  }

  // 2. Malformed plan.
  if (!plan || typeof plan.summary !== "string" || plan.summary.trim() === "") {
    return { verdict: "BLOCKED", riskScore: 100, reason: "Plan is malformed (missing summary).", requiresLedger: false };
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (intentType !== "unknown" && steps.length === 0) {
    return { verdict: "BLOCKED", riskScore: 100, reason: "Plan has no executable steps.", requiresLedger: false };
  }

  // 3. Denylisted token.
  const denied = findDenylistedToken(steps);
  if (denied) {
    return { verdict: "BLOCKED", riskScore: 100, reason: `Token ${denied} is denylisted.`, requiresLedger: false };
  }

  // 4. Value-bearing intents — amount vs the user's auto-approve limit.
  if (intentType === "swap" || intentType === "send" || intentType === "add_liquidity") {
    if (valueUsd > autoApproveLimit) {
      return {
        verdict: "NEEDS_APPROVAL",
        riskScore: 70,
        reason: `$${valueUsd} exceeds your $${autoApproveLimit} auto-approve limit — approval required.`,
        requiresLedger: true,
      };
    }
    return {
      verdict: "AUTO_EXECUTE",
      riskScore: 15,
      reason: `$${valueUsd} is within your $${autoApproveLimit} auto-approve limit.`,
      requiresLedger: false,
    };
  }

  // 5. Unrecognized action — fail closed.
  return {
    verdict: "NEEDS_APPROVAL",
    riskScore: 60,
    reason: "Unrecognized action type — requires manual approval.",
    requiresLedger: true,
  };
}

export * from "./prices";
