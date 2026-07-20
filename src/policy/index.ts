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
  /** Optional per-user policy for the extended deterministic rules. */
  profile?: PolicyProfile;
  /** Recent auto-approved/executed activity, for velocity + habit rules. */
  history?: ActivityRecord[];
  /** Injectable clock (ms) for deterministic velocity tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Per-user deterministic policy. Every field is optional — an absent field
 * disables its rule, so a bare profile (or no profile) reproduces the original
 * amount-vs-limit behaviour exactly.
 */
export interface PolicyProfile {
  /** Destination allow-list for `send` (any case; compared lowercased). */
  knownAddresses?: string[];
  /** Token allow-list. If non-empty, any token NOT listed forces approval. */
  verifiedTokens?: string[];
  /** Rolling 24h cap on auto-approved USD. Exceeding it forces approval. */
  dailyLimitUsd?: number;
  /** Rolling 24h cap on number of auto-approvals. Reaching it forces approval. */
  maxAutoTxPerDay?: number;
  /** Habit baseline: the user's typical max single-tx USD. */
  typicalMaxUsd?: number;
}

/** One past auto-approved/executed action, used by velocity + habit rules. */
export interface ActivityRecord {
  valueUsd: number;
  /** ISO timestamp. */
  at: string;
  to?: string;
  token?: string;
}

export interface PolicyDecision {
  verdict: Verdict;
  riskScore: number;
  /** Deterministic, human-readable explanation of the rule(s) that fired. */
  reason: string;
  requiresLedger: boolean;
  /** Machine-readable slugs of every rule that pushed toward approval. */
  triggered: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A tx this many times the user's typical max is flagged as anomalous. */
const HABIT_ANOMALY_MULTIPLE = 10;

interface Escalation {
  rule: string;
  reason: string;
  risk: number;
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

/** First token in the plan not present in the verified allow-list, or null. */
function findUnverifiedToken(steps: any[], verified: string[]): string | null {
  const allow = new Set(verified.map((a) => a.toLowerCase()));
  for (const step of steps) {
    const p = step?.params || {};
    for (const addr of [p.tokenIn, p.tokenOut, p.token, p.tokenA, p.tokenB]) {
      if (typeof addr === "string" && !allow.has(addr.toLowerCase())) {
        return addr;
      }
    }
  }
  return null;
}

/** Recipient address of a `send` plan, or null. */
function sendRecipient(steps: any[]): string | null {
  const to = steps?.[0]?.params?.to;
  return typeof to === "string" && to ? to : null;
}

/**
 * The authoritative verdict. Deterministic, explainable, fail-closed.
 *
 * Order:
 *   1. balance                 → INFO (read-only)
 *   2. malformed plan          → BLOCKED
 *   3. denylisted token        → BLOCKED
 *   4. unrecognized action     → NEEDS_APPROVAL (fail closed)
 *   5. escalation rules        → each can force NEEDS_APPROVAL, none can weaken:
 *        · amount over limit
 *        · unverified token        (profile.verifiedTokens)
 *        · unknown recipient       (profile.knownAddresses, send only)
 *        · daily USD velocity      (profile.dailyLimitUsd + history)
 *        · daily count velocity    (profile.maxAutoTxPerDay + history)
 *        · habit anomaly           (profile.typicalMaxUsd)
 *   6. otherwise               → AUTO_EXECUTE
 */
export function decide(input: DecisionInput): PolicyDecision {
  const { intentType, valueUsd, autoApproveLimit, plan, profile, history, now } = input;

  // 1. Read-only query.
  if (intentType === "balance") {
    return { verdict: "INFO", riskScore: 0, reason: "Read-only query — no funds move.", requiresLedger: false, triggered: [] };
  }

  // 2. Malformed plan.
  if (!plan || typeof plan.summary !== "string" || plan.summary.trim() === "") {
    return { verdict: "BLOCKED", riskScore: 100, reason: "Plan is malformed (missing summary).", requiresLedger: false, triggered: ["malformed"] };
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (intentType !== "unknown" && steps.length === 0) {
    return { verdict: "BLOCKED", riskScore: 100, reason: "Plan has no executable steps.", requiresLedger: false, triggered: ["malformed"] };
  }

  // 3. Denylisted token.
  const denied = findDenylistedToken(steps);
  if (denied) {
    return { verdict: "BLOCKED", riskScore: 100, reason: `Token ${denied} is denylisted.`, requiresLedger: false, triggered: ["denylist"] };
  }

  // 4. Unrecognized action — fail closed.
  if (intentType === "unknown") {
    return { verdict: "NEEDS_APPROVAL", riskScore: 60, reason: "Unrecognized action type — requires manual approval.", requiresLedger: true, triggered: ["unknown-intent"] };
  }

  // 5. Value-bearing intents (swap / send / add_liquidity): accumulate escalations.
  const escalations: Escalation[] = [];

  // 5a. Amount vs auto-approve limit.
  if (valueUsd > autoApproveLimit) {
    escalations.push({
      rule: "over-limit",
      reason: `$${valueUsd} exceeds your $${autoApproveLimit} auto-approve limit — approval required.`,
      risk: 70,
    });
  }

  if (profile) {
    // 5b. Token allow-list.
    if (profile.verifiedTokens && profile.verifiedTokens.length > 0) {
      const unverified = findUnverifiedToken(steps, profile.verifiedTokens);
      if (unverified) {
        escalations.push({
          rule: "unverified-token",
          reason: `Token ${unverified} is not in your verified list — approval required.`,
          risk: 65,
        });
      }
    }

    // 5c. Destination allow-list (send only).
    if (intentType === "send" && profile.knownAddresses && profile.knownAddresses.length > 0) {
      const to = sendRecipient(steps);
      const allow = new Set(profile.knownAddresses.map((a) => a.toLowerCase()));
      if (to && !allow.has(to.toLowerCase())) {
        escalations.push({
          rule: "unknown-recipient",
          reason: `Recipient ${to} is not a known address — approval required.`,
          risk: 60,
        });
      }
    }

    // 5d + 5e. Velocity (needs history).
    if (history && history.length > 0) {
      const cutoff = (now ?? Date.now()) - DAY_MS;
      const recent = history.filter((h) => {
        const t = Date.parse(h.at);
        return !Number.isNaN(t) && t >= cutoff;
      });

      if (profile.dailyLimitUsd != null) {
        const spent = recent.reduce((s, h) => s + (h.valueUsd || 0), 0);
        if (spent + valueUsd > profile.dailyLimitUsd) {
          escalations.push({
            rule: "daily-usd-velocity",
            reason: `This would exceed your $${profile.dailyLimitUsd} daily auto-approve limit ($${spent} already used today) — approval required.`,
            risk: 68,
          });
        }
      }

      if (profile.maxAutoTxPerDay != null && recent.length >= profile.maxAutoTxPerDay) {
        escalations.push({
          rule: "daily-count-velocity",
          reason: `You've reached your ${profile.maxAutoTxPerDay} auto-approvals per day — approval required.`,
          risk: 60,
        });
      }
    }

    // 5f. Habit anomaly — unusually large vs the user's typical tx size.
    if (profile.typicalMaxUsd != null && profile.typicalMaxUsd > 0 && valueUsd > profile.typicalMaxUsd * HABIT_ANOMALY_MULTIPLE) {
      escalations.push({
        rule: "habit-anomaly",
        reason: `$${valueUsd} is unusually large versus your typical $${profile.typicalMaxUsd} — approval required.`,
        risk: 55,
      });
    }
  }

  // 6. Verdict.
  if (escalations.length > 0) {
    return {
      verdict: "NEEDS_APPROVAL",
      riskScore: Math.max(...escalations.map((e) => e.risk)),
      reason: escalations.map((e) => e.reason).join(" "),
      requiresLedger: true,
      triggered: escalations.map((e) => e.rule),
    };
  }

  return {
    verdict: "AUTO_EXECUTE",
    riskScore: 15,
    reason: `$${valueUsd} is within your $${autoApproveLimit} auto-approve limit.`,
    requiresLedger: false,
    triggered: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Habit profile — derive a baseline from recorded activity ("learns habits")
// ═══════════════════════════════════════════════════════════════════════
// Boring statistics, deliberately: no ML, no training. The median of recent
// tx sizes is a robust "typical" value; the habit-anomaly rule then flags
// anything HABIT_ANOMALY_MULTIPLE× above it. Because that rule only escalates,
// an auto-derived baseline is always safe (fail-closed).

/** Minimum samples before we trust a derived baseline (avoids overfitting). */
export const HABIT_MIN_SAMPLES = 5;

export interface HabitProfile {
  sampleSize: number;
  medianUsd: number | null;
  meanUsd: number | null;
  maxUsd: number | null;
  /** Baseline for the habit-anomaly rule; null until there's enough data. */
  typicalMaxUsd: number | null;
}

export function computeHabitProfile(history: ActivityRecord[]): HabitProfile {
  const vals = (history || [])
    .map((h) => h.valueUsd)
    .filter((v) => typeof v === "number" && v > 0)
    .sort((a, b) => a - b);

  const n = vals.length;
  if (n === 0) {
    return { sampleSize: 0, medianUsd: null, meanUsd: null, maxUsd: null, typicalMaxUsd: null };
  }

  const median = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const max = vals[n - 1];

  return {
    sampleSize: n,
    medianUsd: median,
    meanUsd: mean,
    maxUsd: max,
    typicalMaxUsd: n >= HABIT_MIN_SAMPLES ? median : null,
  };
}

export * from "./prices";
