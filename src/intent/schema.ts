// ─── Intent — planner output schema ───
// The exact shapes the planner LLM may return. Anything else is rejected (one
// repair retry, then a clarification) — the model's JSON is never trusted as-is.
//
// Adding a capability = add a step schema here, handle it in ./resolve, and
// describe it in ./prompt.

import { z } from "zod";

/** "0.5", "all", "50%". Numbers are coerced; commas and whitespace are stripped. */
const Amount = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().toLowerCase().replace(/[,\s]/g, "") : v),
  z
    .string()
    .regex(/^(\d+(\.\d+)?|\.\d+|all|max|\d+(\.\d+)?%)$/, 'amount must be a decimal like "0.5", "all", or a percentage like "50%"')
);

const Unit = z.enum(["token", "usd"]).default("token");
const TokenSymbol = z.string().min(1).max(20);

export const SwapStep = z.object({
  action: z.literal("swap"),
  from: TokenSymbol,
  to: TokenSymbol,
  amount: Amount,
  unit: Unit,
  /** "in": amount is what's spent (default). "out": amount is what's received. */
  side: z.enum(["in", "out"]).default("in"),
});

export const SendStep = z.object({
  action: z.literal("send"),
  token: TokenSymbol,
  amount: Amount,
  unit: Unit,
  to: z.string().min(1).max(100),
});

export const BalanceStep = z.object({
  action: z.literal("balance"),
  token: TokenSymbol.optional(),
});

export const PriceStep = z.object({
  action: z.literal("price"),
  token: TokenSymbol,
});

export const AddLiquidityStep = z.object({
  action: z.literal("add_liquidity"),
  tokenA: TokenSymbol,
  amountA: Amount,
  tokenB: TokenSymbol,
  amountB: Amount,
});

/** Move funds from the user's own wallet into their Safe (signed by the user). */
export const DepositStep = z.object({
  action: z.literal("deposit"),
  token: TokenSymbol,
  amount: Amount,
  unit: Unit,
});

export const Step = z.discriminatedUnion("action", [SwapStep, SendStep, BalanceStep, PriceStep, AddLiquidityStep, DepositStep]);

export const PlannerOutput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("actions"), steps: z.array(Step).min(1).max(5) }),
  z.object({ type: z.literal("clarify"), question: z.string().min(1).max(500) }),
  z.object({ type: z.literal("reply"), text: z.string().min(1).max(1500) }),
  z.object({ type: z.literal("unsupported"), reason: z.string().min(1).max(500) }),
]);

export type StepT = z.infer<typeof Step>;
export type PlannerOutputT = z.infer<typeof PlannerOutput>;

/** Compact, model-readable list of validation problems (for the repair retry). */
export function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}
