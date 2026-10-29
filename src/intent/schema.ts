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

/** Withdraw a share of a liquidity position. Tokens / positionId narrow down which one. */
export const RemoveLiquidityStep = z.object({
  action: z.literal("remove_liquidity"),
  amount: Amount.default("all"),
  tokenA: TokenSymbol.optional(),
  tokenB: TokenSymbol.optional(),
  positionId: z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().regex(/^\d+$/, "positionId must be a number")).optional(),
});

/** List the user's liquidity positions. */
export const PositionsStep = z.object({ action: z.literal("positions") });

/** Show the user's own addresses (wallet and Safe). The server fills them in, never the model. */
export const AddressStep = z.object({ action: z.literal("address") });

// ── Planned DeFi actions (ORC-20) ──
// Understood but not run yet: the pipeline answers them in plain words before any
// resolution, limit check, approval or adapter (see ./comingSoon). Amount and token are
// optional because nothing is built from them, so a missing one isn't worth a question.

/** Planned actions the planner can recognise but Orchestra can't carry out yet. */
export const COMING_SOON_ACTIONS = [
  "stake", "unstake", "lend", "withdraw_lend", "borrow", "repay", "deposit_yield", "withdraw_yield",
] as const;
export type ComingSoonAction = (typeof COMING_SOON_ACTIONS)[number];

const comingSoonStep = <A extends ComingSoonAction>(action: A) =>
  z.object({
    action: z.literal(action),
    token: TokenSymbol.optional(),
    amount: Amount.optional(),
    unit: Unit,
    /** The protocol the user named ("lido", "aave"), if any. Only ever echoed from a fixed list. */
    protocol: z.string().min(1).max(40).optional(),
  });

/** Stake ETH (planned: Lido) / take it back. */
export const StakeStep = comingSoonStep("stake");
export const UnstakeStep = comingSoonStep("unstake");
/** Lend (supply) a token / withdraw it / borrow against it / repay a loan (planned: Aave). */
export const LendStep = comingSoonStep("lend");
export const WithdrawLendStep = comingSoonStep("withdraw_lend");
export const BorrowStep = comingSoonStep("borrow");
export const RepayStep = comingSoonStep("repay");
/** Put a token in a yield vault / take it out (planned: an ERC-4626 vault). */
export const DepositYieldStep = comingSoonStep("deposit_yield");
export const WithdrawYieldStep = comingSoonStep("withdraw_yield");

export const Step = z.discriminatedUnion("action", [
  SwapStep, SendStep, BalanceStep, PriceStep, AddLiquidityStep, DepositStep, RemoveLiquidityStep, PositionsStep, AddressStep,
  StakeStep, UnstakeStep, LendStep, WithdrawLendStep, BorrowStep, RepayStep, DepositYieldStep, WithdrawYieldStep,
]);

export const PlannerOutput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("actions"),
    steps: z.array(Step).min(1).max(5),
    /** Language the user wrote in ("en", "fr", …). Used for coming-soon replies; English fallback. */
    language: z.string().min(2).max(16).optional(),
  }),
  z.object({ type: z.literal("clarify"), question: z.string().min(1).max(500) }),
  z.object({ type: z.literal("reply"), text: z.string().min(1).max(1500) }),
  z.object({ type: z.literal("unsupported"), reason: z.string().min(1).max(500) }),
]);

export type StepT = z.infer<typeof Step>;
export type ComingSoonStepT = Extract<StepT, { action: ComingSoonAction }>;

/** True for a planned action that must be answered in words and never resolved or executed. */
export function isComingSoonStep(step: StepT): step is ComingSoonStepT {
  return (COMING_SOON_ACTIONS as readonly string[]).includes(step.action);
}
export type PlannerOutputT = z.infer<typeof PlannerOutput>;

/** Compact, model-readable list of validation problems (for the repair retry). */
export function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}
