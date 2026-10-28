// ─── Executor — multi-step plans: build, then run the steps one after another (ORC-21) ───
// A message with up to three money-moving steps ("swap half my ETH to USDC and send 5 USDC to
// alice.eth") becomes one plan, approved once. Each step stays its own transaction through the
// account, run in order and never bundled into one MultiSend, so every step keeps its own guards
// (balance, quote re-check, pool price). Over the account's daily ceiling, a plan of sends only is
// signed by the owner one send at a time, so the owner-sign browser check (ORC-113) still only ever
// sees a plain transfer.
//
// What was approved is the most each step may spend. A step whose amount depends on an earlier one
// ("the rest", "half of what I got") is filled in when it runs, from what is actually in the account
// and what the earlier step actually produced, and it can only go down: never above the approved
// amount, the quote's promise or the balance. Recipients and tokens never change. If a step fails,
// the plan stops there and says which steps went through. Pure apart from the injected `deps`, so
// tests run without a chain (src/executor/plan.test.ts).

import { ethers } from "ethers";
import { TOKENS, type TokenDef } from "../intent/tokens";
import { ETH_GAS_RESERVE, type AmountRule } from "../intent/resolve";
import type { PlanAction } from "../intent/pipeline";
import type { AdapterResult, Balances } from "./adapters";
import { UserFacingError, OverCapError } from "../utils/userFacing";

/** One step as held server-side (in the approval record, or in memory for an automatic run). */
export interface PlanStepRecord {
  intentType: "swap" | "send" | "add_liquidity" | "remove_liquidity";
  summary: string;
  /** The most this step counts toward the daily limit (its approved amounts). */
  valueUsd: number;
  amounts: AmountRule[];
  /** Exactly what the adapter's execute() receives: { quoteData } / { sendData } / { lpData } / { lpRemoveData }. */
  execution: Record<string, unknown>;
  /** What a swap's quote promised to bring in: the ceiling for a step that uses its output. */
  promisedOut?: { symbol: string; amount: number };
}

export interface StepOutcome {
  index: number;
  summary: string;
  status: "done" | "failed" | "not-run";
  txHash?: string;
  explorerUrl?: string;
  error?: string;
  /** What the step counted toward the daily limit (0 unless it ran). */
  valueUsd: number;
}

export interface PlanRunResult {
  steps: StepOutcome[];
  /** Every step went through. */
  complete: boolean;
  /** Plain words for the chat: what went through and what didn't. */
  text: string;
  /** Refused before the first step (e.g. over the account's daily ceiling): nothing ran. */
  refused?: boolean;
}

const SPENDING = new Set(["swap", "add_liquidity"]);

/** Plans with a swap or a liquidity step can't be signed by the owner (ORC-113 refuses bundles). */
export function hasSwapOrLiquidity(steps: { intentType: string }[]): boolean {
  return steps.some((s) => SPENDING.has(s.intentType) || s.intentType === "remove_liquidity");
}

export const OVER_CEILING_PLAN_WITH_SWAP =
  "This would go past what your account lets me move on my own today. Plans with a swap or a liquidity change can't be signed by you yet, so nothing was done. Try smaller amounts, or try again after the daily reset.";
/** A sends-only plan over the ceiling when the owner-sign offer couldn't be prepared. */
export const OVER_CEILING_PLAN_SENDS =
  "This would go past what your account lets me move on my own today, so nothing was done. Try smaller amounts, or try again after the daily reset.";

/** A sends-only plan over the ceiling (ORC-21): the owner signs its sends with their wallet, one after another. */
export function overCeilingOwnerSignText(count: number): string {
  return `This would go past what your account lets me move on my own today, so nothing was sent yet. You can sign the ${count} sends yourself with your wallet as the account owner, one after another, or try again after the daily reset.`;
}

/** The plain answer when a plan's total is over the account's on-chain daily ceiling and no owner-sign is offered. */
export function overCeilingReason(steps: { intentType: string }[]): string {
  return hasSwapOrLiquidity(steps) ? OVER_CEILING_PLAN_WITH_SWAP : OVER_CEILING_PLAN_SENDS;
}

/** A sends-only plan's sends as owner-sign payments: each a plain transfer, with what it claims to send. */
export function ownerSends(steps: PlanStepRecord[]): Array<{ summary: string; batch: Array<{ to: string; value: string; data: string }>; meta: { valueUsd: number; to?: string; token?: string; amount?: string; symbol?: string } }> {
  return steps.map((s) => {
    const d = (s.execution as any)?.sendData;
    if (s.intentType !== "send" || !d?.unsignedTx) throw new UserFacingError("Only a plan of sends can be signed by you.");
    const tx = d.unsignedTx;
    return {
      summary: s.summary,
      batch: [{ to: tx.to, value: String(tx.value || "0"), data: tx.data || "0x" }],
      meta: { valueUsd: s.valueUsd, to: d.to, token: d.token, amount: String(d.amount), symbol: d.symbol },
    };
  });
}

function tokenOf(symbol: string): TokenDef {
  const t = (TOKENS as Record<string, TokenDef>)[String(symbol).toUpperCase()];
  if (!t) throw new UserFacingError(`I don't know the token ${symbol}, so I stopped here.`);
  return t;
}

/** A positive amount as a decimal string the token can hold, rounded down. */
function decimalString(value: number, token: TokenDef): string {
  const places = Math.min(token.decimals, 8);
  const factor = 10 ** places;
  return (Math.floor(value * factor) / factor).toFixed(places).replace(/\.?0+$/, "");
}

const ERC20 = new ethers.Interface(["function transfer(address to, uint256 amount)"]);

/** The amount a step's payload currently spends for `rule`, in tokens. */
export function payloadAmount(step: PlanStepRecord, rule: AmountRule): number {
  const token = tokenOf(rule.symbol);
  const e = step.execution as any;
  if (step.intentType === "send") return Number(e.sendData.amount);
  if (step.intentType === "swap") return Number(ethers.formatUnits(BigInt(e.quoteData.amount), token.decimals));
  if (step.intentType === "add_liquidity") return Number(ethers.formatUnits(BigInt(e.lpData[rule.field]), token.decimals));
  throw new UserFacingError("This step has no amount to fill in.");
}

/**
 * The step's payload with `rule`'s amount lowered to `amount` (never raised: the caller passes
 * at most `payloadAmount`). Only the amount changes; the recipient, tokens and pool stay.
 */
export function withAmount(step: PlanStepRecord, rule: AmountRule, amount: number): PlanStepRecord {
  const token = tokenOf(rule.symbol);
  const str = decimalString(amount, token);
  const e = structuredClone(step.execution) as any;
  const before = payloadAmount(step, rule);
  if (step.intentType === "send") {
    const d = e.sendData;
    d.amount = str;
    d.unsignedTx = token.native
      ? { to: d.to, data: "0x", value: ethers.parseEther(str).toString() }
      : { to: d.token, data: ERC20.encodeFunctionData("transfer", [d.to, ethers.parseUnits(str, token.decimals)]), value: "0" };
  } else if (step.intentType === "swap") {
    const q = e.quoteData;
    q.amount = ethers.parseUnits(str, token.decimals).toString();
    if (typeof q.expectedOut === "number" && before > 0) q.expectedOut = (q.expectedOut * Number(str)) / before;
  } else if (step.intentType === "add_liquidity") {
    e.lpData[rule.field] = ethers.parseUnits(str, token.decimals).toString();
  }
  const ratio = before > 0 ? Number(str) / before : 1;
  return { ...step, execution: e, valueUsd: step.valueUsd * Math.min(1, ratio) };
}

function held(b: Balances, symbol: string): number {
  return symbol === "ETH" ? b.eth : symbol === "WETH" ? b.weth : symbol === "USDC" ? b.usdc : 0;
}

const spendable = (b: Balances, symbol: string) => Math.max(0, held(b, symbol) - (symbol === "ETH" ? ETH_GAS_RESERVE : 0));

/**
 * What a dependent amount comes to when its step runs: at most the approved amount, the share of
 * what is in the account, and (for "output") the share of what the earlier step actually brought in.
 */
export function fillAmount(
  rule: AmountRule,
  approved: number,
  now: Balances,
  received?: number,
): number {
  if (rule.kind === "fixed") return approved;
  const caps = [approved, spendable(now, rule.symbol) * (rule.kind === "balance" ? rule.fraction : 1)];
  if (rule.kind === "output") caps.push(Math.max(0, received ?? 0) * rule.fraction);
  return Math.max(0, Math.min(...caps));
}

/** The payload an approval stores for an agent-executed intent (what execute() reads), or null if there's nothing to execute. */
export function executionPayload(intentType: string, payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (intentType === "swap" && payload?.quoteData) return { quoteData: payload.quoteData };
  if (intentType === "send" && payload?.sendData) return { sendData: payload.sendData };
  if (intentType === "add_liquidity" && payload?.lpData) return { lpData: payload.lpData };
  if (intentType === "remove_liquidity" && payload?.lpRemoveData) return { lpRemoveData: payload.lpRemoveData };
  return null;
}

export interface BuildDeps {
  /** The adapter's build() for one step (quotes, pool reads). */
  build(step: PlanAction): Promise<AdapterResult>;
  /** The payload an approval / execute() needs from a build, or null when there's nothing to run. */
  execution(intentType: string, payload: Record<string, unknown> | undefined): Record<string, unknown> | null;
}

/**
 * Build every step in order. A step that uses a swap's output is set to that share of what the quote
 * promised (raised or lowered from the market estimate): this runs before any approval card is shown,
 * so the amount on the card is already the quote-based one and is never raised after an OK. At run
 * time, fillAmount can only go down from that approved amount. Any refusal, or a step with nothing
 * to run, refuses the whole plan.
 */
export async function buildPlanSteps(
  steps: PlanAction[],
  deps: BuildDeps,
): Promise<{ steps: PlanStepRecord[] } | { refusal: string }> {
  const out: PlanStepRecord[] = [];
  for (const [i, original] of steps.entries()) {
    let step = original;
    for (const rule of step.amounts) {
      if (rule.kind !== "output" || rule.fromStep == null) continue;
      const promised = out[rule.fromStep]?.promisedOut;
      if (!promised || promised.symbol !== rule.symbol) continue;
      // The quote is the planning number once we have it (Sepolia pools can be far from market).
      const target = promised.amount * rule.fraction;
      const current = Number(step.params[rule.field]);
      if (!(current > 0) || !(target > 0)) {
        return { refusal: `Step ${i + 1} would use too little ${rule.symbol} from the swap before it, so nothing was done.` };
      }
      const str = decimalString(target, tokenOf(rule.symbol));
      if (!(Number(str) > 0)) return { refusal: `Step ${i + 1} would use too little ${rule.symbol} from the swap before it, so nothing was done.` };
      if (str !== String(step.params[rule.field])) {
        const params = { ...step.params, [rule.field]: str };
        step = {
          ...step, params, valueUsd: step.valueUsd * (Number(str) / current),
          steps: step.steps.map((s) => ({ ...s, params })),
          summary: step.summary.replace(String(step.params[rule.field]), str),
        };
      }
    }
    const built = await deps.build(step);
    if (built.refusal) return { refusal: `Step ${i + 1} (${step.summary}) can't go ahead: ${built.refusal}` };
    const execution = deps.execution(step.intentType, built.payload);
    if (!execution) return { refusal: `I couldn't prepare step ${i + 1} (${step.summary}), so nothing was done. Please try again in a moment.` };
    const q = (built.payload as any)?.quoteData;
    out.push({
      intentType: step.intentType as PlanStepRecord["intentType"],
      summary: built.plan?.summary || step.summary,
      valueUsd: step.valueUsd,
      amounts: step.amounts,
      execution,
      ...(step.intentType === "swap" && typeof q?.expectedOut === "number" && q.expectedOut > 0
        ? { promisedOut: { symbol: String(q.symbolOut), amount: q.expectedOut } }
        : {}),
    });
  }
  return { steps: out };
}

export interface RunDeps {
  /** Asked once before the first step; throwing refuses the whole plan with that message, nothing runs. */
  beforeStart?(): Promise<void>;
  /** The account's balances now (null when they can't be read). */
  readBalances(): Promise<Balances | null>;
  /** Run one step's payload through its adapter. Throws when it didn't go through. */
  execute(step: PlanStepRecord): Promise<{ txHash: string; explorerUrl: string }>;
  /** Called once per step that ran, before the next one starts: record it toward activity and the limit. */
  onStepDone?(step: PlanStepRecord, outcome: StepOutcome): Promise<void>;
  /** The plain sentence for a failed step. */
  errorText(err: unknown): string;
}

/** Run the steps one after another; stop at the first that doesn't go through. */
export async function runPlan(steps: PlanStepRecord[], deps: RunDeps): Promise<PlanRunResult> {
  const outcomes: StepOutcome[] = steps.map((s, index) => ({ index, summary: s.summary, status: "not-run", valueUsd: 0 }));
  // Steps whose output a later step uses: their balance is read before and after they run.
  const sources = new Set(steps.flatMap((s) => s.amounts.filter((r) => r.kind === "output").map((r) => r.fromStep!)));
  const received: Record<number, Record<string, number>> = {};
  try {
    await deps.beforeStart?.();
  } catch (err) {
    // Over the ceiling with an owner-sign offer: the caller answers it like a single over-cap request.
    if (err instanceof OverCapError) throw err;
    return { steps: outcomes, complete: false, text: deps.errorText(err), refused: true };
  }

  for (const [i, planned] of steps.entries()) {
    const outcome = outcomes[i];
    try {
      let step = planned;
      const used: string[] = [];
      const dependent = step.amounts.filter((r) => r.kind !== "fixed");
      if (dependent.length) {
        const now = await deps.readBalances();
        if (!now) throw new UserFacingError("I couldn't check your balance before this step, so I stopped here");
        for (const rule of dependent) {
          const approved = payloadAmount(step, rule);
          const got = rule.kind === "output" ? received[rule.fromStep!]?.[rule.symbol] : undefined;
          if (rule.kind === "output" && got == null) throw new UserFacingError("I couldn't tell what the step before brought in, so I stopped here");
          const amount = fillAmount(rule, approved, now, got);
          if (!(amount > 0)) throw new UserFacingError(`There's no ${rule.symbol} left for this step, so I stopped here`);
          if (amount < approved) {
            step = withAmount(step, rule, amount);
            used.push(`${decimalString(amount, tokenOf(rule.symbol))} ${rule.symbol}`);
          }
        }
        if (used.length) step = { ...step, summary: `${planned.summary} (used ${used.join(" + ")})` };
      }
      const before = sources.has(i) ? await deps.readBalances() : null;
      const result = await deps.execute(step);
      Object.assign(outcome, { status: "done", txHash: result.txHash, explorerUrl: result.explorerUrl, valueUsd: step.valueUsd, summary: step.summary });
      if (sources.has(i)) {
        const after = await deps.readBalances();
        if (before && after) {
          received[i] = Object.fromEntries(["ETH", "WETH", "USDC"].map((sym) => [sym, held(after, sym) - held(before, sym)]));
        }
      }
      await deps.onStepDone?.(step, outcome);
    } catch (err) {
      outcome.status = "failed";
      outcome.error = deps.errorText(err);
      break;
    }
  }
  const complete = outcomes.every((o) => o.status === "done");
  return { steps: outcomes, complete, text: planOutcomeText(outcomes) };
}

/** "All 3 steps went through." or which went through, which failed (and why) and which didn't start. */
export function planOutcomeText(outcomes: StepOutcome[]): string {
  if (outcomes.every((o) => o.status === "done")) return `All ${outcomes.length} steps went through.`;
  const failed = outcomes.find((o) => o.status === "failed");
  const done = outcomes.filter((o) => o.status === "done").length;
  const head = failed
    ? `Step ${failed.index + 1} didn't go through: ${String(failed.error ?? "something went wrong").replace(/[.\s]+$/, "")}. ${done ? "I stopped there." : "Nothing was done."}`
    : "Not every step went through.";
  const lines = outcomes.map((o) => `${o.status === "done" ? "✓" : o.status === "failed" ? "✗" : "–"} ${o.index + 1}. ${o.summary}${
    o.status === "done" ? "" : o.status === "failed" ? " (didn't go through)" : " (not started)"}`);
  return [head, ...lines].join("\n");
}

/**
 * The check before a plan's first step: its total must fit in what the account still lets the
 * agent move today. Over it, a plan of sends only goes to owner-sign like a single over-cap send:
 * `offerSends` holds its sends for the owner's wallet, one at a time, and an OverCapError carries
 * the first (ORC-21). A plan with a swap or a liquidity step can't be owner-signed (ORC-113 only
 * lets the wallet sign a plain payment), so it is answered in plain words and nothing runs; so is a
 * sends-only plan when no offer could be prepared. `fits` is accountExec's fitsDailyCeiling.
 */
export function ceilingCheck(
  steps: PlanStepRecord[],
  fits: (valueUsd: number) => Promise<boolean>,
  offerSends?: (sends: ReturnType<typeof ownerSends>) => Promise<Record<string, unknown> | null>,
): () => Promise<void> {
  return async () => {
    const total = steps.reduce((sum, s) => sum + s.valueUsd, 0);
    if (await fits(total)) return;
    if (!hasSwapOrLiquidity(steps) && offerSends) {
      const offer = await offerSends(ownerSends(steps)).catch(() => null);
      if (offer) throw new OverCapError(overCeilingOwnerSignText(steps.length), offer);
    }
    throw new UserFacingError(overCeilingReason(steps), 409);
  };
}
