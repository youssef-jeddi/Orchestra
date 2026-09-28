// ─── Intent — server-side resolution ───
// Turns validated planner steps into concrete, executable steps: symbols →
// registry addresses, ENS → address, "all" / "50%" / "$20" → exact token
// amounts. Anything that can't be resolved becomes a clarifying question or an
// "unsupported" answer rather than a guess. Summaries are generated here from
// the resolved values, so what the user approves is exactly what executes.

import { ethers } from "ethers";
import type { Balances } from "../executor/adapters";
import { computePlanValueUsd, getPriceUsd, type IntentType } from "../policy";
import { lookupToken, SUPPORTED_SYMBOLS, type TokenDef } from "./tokens";
import type { StepT } from "./schema";

export interface ResolveContext {
  /** A wallet is connected (relative amounts and balances need one). */
  connected: boolean;
  /** Balances of the account actions spend from: the Safe if there is one, else the wallet. */
  getBalances(): Promise<Balances | null>;
  /** Balances of the connected wallet itself — the source of a deposit into the Safe. */
  getWalletBalances?(): Promise<Balances | null>;
  resolveEns(name: string): Promise<string | null>;
}

/** Legacy plan-step shape consumed by the policy engine and the executor adapters. */
export interface PlanStep {
  protocol: string;
  action: IntentType;
  params: Record<string, any>;
  estimatedGasWei: string;
  order: number;
}

export interface ResolvedStep {
  action: "swap" | "send" | "add_liquidity" | "deposit" | "balance" | "price";
  summary: string;
  plan: PlanStep;
  valueUsd: number;
  /** For price steps. */
  price?: { symbol: string; usd: number };
  /** For balance steps: the token asked about, if any. */
  token?: string;
}

export type ResolveResult =
  | { kind: "ok"; steps: ResolvedStep[] }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported"; reason: string };

class Stop extends Error {
  constructor(public result: Exclude<ResolveResult, { kind: "ok" }>) {
    super(result.kind);
  }
}
const clarify = (question: string) => new Stop({ kind: "clarify", question });
const unsupported = (reason: string) => new Stop({ kind: "unsupported", reason });

/** Keep a little native ETH for gas when the user sends or swaps "all" of it. */
export const ETH_GAS_RESERVE = 0.002;
const ENS_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;

export async function resolveSteps(steps: StepT[], ctx: ResolveContext): Promise<ResolveResult> {
  try {
    const out: ResolvedStep[] = [];
    for (const [i, step] of steps.entries()) out.push(await resolveStep(step, i, ctx));
    return { kind: "ok", steps: out };
  } catch (err) {
    if (err instanceof Stop) return err.result;
    throw err;
  }
}

async function resolveStep(step: StepT, order: number, ctx: ResolveContext): Promise<ResolvedStep> {
  switch (step.action) {
    case "price": {
      const token = requireToken(step.token);
      const usd = getPriceUsd(token.symbol);
      return {
        action: "price",
        summary: `${token.symbol} is $${formatUsd(usd)}`,
        plan: planStep("native", "balance", {}, order),
        valueUsd: 0,
        price: { symbol: token.symbol, usd },
      };
    }

    case "balance": {
      const token = step.token ? requireToken(step.token) : null;
      if (!ctx.connected) throw clarify("Connect a wallet first so I can check your balance.");
      return {
        action: "balance",
        summary: token ? `Your ${token.symbol} balance` : "Your balances",
        plan: planStep("native", "balance", {}, order),
        valueUsd: 0,
        token: token?.symbol,
      };
    }

    case "swap": {
      const from = requireToken(step.from);
      const to = requireToken(step.to);
      if (from.symbol === to.symbol) throw clarify(`You asked to swap ${from.symbol} for ${to.symbol}. Which token do you want to receive?`);
      if (from.address === to.address) throw unsupported("Wrapping and unwrapping between ETH and WETH isn't supported yet.");

      let amountIn: string;
      let summary: string;
      if (step.side === "out") {
        if (!/^\d*\.?\d+$/.test(step.amount)) throw clarify(`How much ${from.symbol} do you want to spend?`);
        const amountOut = await resolveAmount(step.amount, step.unit, to, ctx, "receive");
        const pIn = getPriceUsd(from.symbol);
        const pOut = getPriceUsd(to.symbol);
        if (!(pIn > 0 && pOut > 0)) throw clarify(`How much ${from.symbol} do you want to spend?`);
        amountIn = formatAmount((Number(amountOut) * pOut) / pIn, from);
        summary = `Swap ~${amountIn} ${from.symbol} for ~${amountOut} ${to.symbol}`;
      } else {
        amountIn = await resolveAmount(step.amount, step.unit, from, ctx, "swap");
        summary = `Swap ${amountIn} ${from.symbol} for ${to.symbol}`;
      }
      await requireBalance(amountIn, from, ctx, "swap");

      const params = {
        tokenIn: from.address, tokenOut: to.address, amount: amountIn,
        symbolIn: from.symbol, symbolOut: to.symbol,
      };
      const valueUsd = computePlanValueUsd("swap", params);
      return { action: "swap", summary: withUsd(summary, valueUsd, from), plan: planStep("uniswap", "swap", params, order, "300000"), valueUsd };
    }

    case "send": {
      const token = requireToken(step.token);
      const { address, label } = await resolveRecipient(step.to, ctx);
      const amount = await resolveAmount(step.amount, step.unit, token, ctx, "send");
      await requireBalance(amount, token, ctx, "send");
      const params = { token: token.address, to: address, amount, symbol: token.symbol };
      const valueUsd = computePlanValueUsd("send", params);
      const who = label ? `${label} (${address})` : address;
      return {
        action: "send",
        summary: withUsd(`Send ${amount} ${token.symbol} to ${who}`, valueUsd, token),
        plan: planStep("native", "send", params, order, "21000"),
        valueUsd,
      };
    }

    case "deposit": {
      const token = requireToken(step.token);
      if (!ctx.connected) throw clarify("Connect a wallet first so I can move funds from it into your Safe.");
      // The wallet funds the deposit and pays its gas, so amounts come from the wallet, not the Safe.
      const fromWallet = () => (ctx.getWalletBalances ? ctx.getWalletBalances() : Promise.resolve(null));
      const amount = await resolveAmount(step.amount, step.unit, token, ctx, "deposit", fromWallet);
      await requireBalance(amount, token, ctx, "deposit", { getBalances: fromWallet, gasReserve: token.native ? ETH_GAS_RESERVE : 0 });
      const params = { token: token.address, amount, symbol: token.symbol };
      const valueUsd = computePlanValueUsd("deposit", params);
      return {
        action: "deposit",
        summary: withUsd(`Move ${amount} ${token.symbol} from your wallet into your Safe`, valueUsd, token),
        plan: planStep("native", "deposit", params, order, token.native ? "21000" : "80000"),
        valueUsd,
      };
    }

    case "add_liquidity": {
      const a = requireToken(step.tokenA);
      const b = requireToken(step.tokenB);
      if (a.address === b.address) throw clarify("Liquidity needs two different tokens. Which pair do you want?");
      const amountA = await resolveAmount(step.amountA, "token", a, ctx, "deposit");
      const amountB = await resolveAmount(step.amountB, "token", b, ctx, "deposit");
      await requireBalance(amountA, a, ctx, "deposit");
      await requireBalance(amountB, b, ctx, "deposit");
      const params = {
        tokenA: a.address, tokenB: b.address, amountA, amountB,
        symbolA: a.symbol, symbolB: b.symbol, feeTier: 3000,
      };
      const valueUsd = computePlanValueUsd("add_liquidity", params);
      return {
        action: "add_liquidity",
        summary: `Add liquidity: ${amountA} ${a.symbol} + ${amountB} ${b.symbol} (~$${formatUsd(valueUsd)})`,
        plan: planStep("uniswap", "add_liquidity", params, order, "500000"),
        valueUsd,
      };
    }
  }
}

function requireToken(raw: string): TokenDef {
  const token = lookupToken(raw);
  if (!token) {
    throw unsupported(`I only support ${SUPPORTED_SYMBOLS.join(", ")} on Sepolia right now, and "${raw}" isn't one of them.`);
  }
  return token;
}

async function resolveRecipient(raw: string, ctx: ResolveContext): Promise<{ address: string; label?: string }> {
  const to = raw.trim();
  if (/^0x/i.test(to)) {
    if (!ethers.isAddress(to)) {
      throw clarify(`"${to}" isn't a valid Ethereum address (wrong length or checksum). Can you double-check it?`);
    }
    const address = ethers.getAddress(to);
    if (address === ethers.ZeroAddress) throw unsupported("I won't send to the zero address. Funds sent there are lost.");
    return { address };
  }
  if (ENS_NAME.test(to)) {
    const address = await ctx.resolveEns(to.toLowerCase());
    if (!address) throw clarify(`I couldn't find an address for ${to}. Can you give me the 0x address instead?`);
    return { address: ethers.getAddress(address), label: to.toLowerCase() };
  }
  throw clarify(`Who should I send it to? I need a 0x address or an ENS name, not "${to}".`);
}

type Purpose = "swap" | "send" | "deposit" | "receive";

async function resolveAmount(
  raw: string,
  unit: "token" | "usd",
  token: TokenDef,
  ctx: ResolveContext,
  purpose: Purpose,
  getBalances: () => Promise<Balances | null> = () => ctx.getBalances()
): Promise<string> {
  const relative = raw === "all" || raw === "max" || raw.endsWith("%");

  if (relative) {
    if (purpose === "receive") throw clarify(`How much ${token.symbol} do you want to receive?`);
    const fraction = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : 1;
    if (!(fraction > 0 && fraction <= 1)) throw clarify(`${raw} isn't a valid share of your balance. What percentage did you mean?`);
    if (!ctx.connected) throw clarify(`Connect a wallet so I can work out ${raw} of your ${token.symbol}, or give me an exact amount.`);

    const balances = await getBalances();
    if (!balances) throw clarify(`I couldn't read your ${token.symbol} balance right now. Can you give me an exact amount?`);
    const held = heldBalance(balances, token);
    const spendable = token.native ? Math.max(0, held - ETH_GAS_RESERVE) : held;
    const amount = spendable * fraction;
    if (!(amount > 0)) throw clarify(`You don't have any ${token.symbol} to ${purpose}${token.native ? " after keeping a little for gas" : ""}.`);
    return formatAmount(amount, token);
  }

  let value = Number(raw);
  if (unit === "usd") {
    const price = getPriceUsd(token.symbol);
    if (!(price > 0)) throw clarify(`How much ${token.symbol} is that in tokens?`);
    value = value / price;
  }
  if (!(value > 0)) throw clarify(`How much ${token.symbol} do you want to ${purpose}?`);
  return unit === "usd" ? formatAmount(value, token) : trimDecimals(raw.startsWith(".") ? `0${raw}` : raw, token.decimals);
}

function heldBalance(balances: Balances, token: TokenDef): number {
  return token.symbol === "ETH" ? balances.eth : token.symbol === "WETH" ? balances.weth : balances.usdc;
}

/**
 * Refuse an amount the account doesn't hold, before any quote or transaction is
 * built — otherwise the tx reverts on-chain and still burns gas. Skipped when no
 * wallet is connected or the balance can't be read (the RPC timed out).
 */
async function requireBalance(
  amount: string,
  token: TokenDef,
  ctx: ResolveContext,
  purpose: Purpose,
  opts: { getBalances?: () => Promise<Balances | null>; gasReserve?: number } = {}
): Promise<void> {
  if (!ctx.connected) return;
  const balances = await (opts.getBalances ?? (() => ctx.getBalances()))();
  if (!balances) return;
  const held = heldBalance(balances, token);
  const reserve = opts.gasReserve ?? 0;
  if (Number(amount) + reserve > held) {
    const have = held > 0 ? `${formatAmount(held, token)} ${token.symbol}` : `no ${token.symbol}`;
    const gas = reserve > 0 ? ` plus ~${reserve} ${token.symbol} for gas` : "";
    throw unsupported(`Not enough ${token.symbol}: you have ${have}, but this ${purpose} needs ${amount} ${token.symbol}${gas}.`);
  }
}

// ── Formatting ──

/** Round DOWN to the token's display precision (never exceeds what the user has). */
function formatAmount(value: number, token: TokenDef): string {
  const factor = 10 ** token.displayDecimals;
  const floored = Math.floor(value * factor) / factor;
  const precise = floored > 0 ? floored : Number(value.toPrecision(2));
  return stripZeros(precise.toFixed(Math.max(token.displayDecimals, decimalsOf(precise))));
}

function decimalsOf(n: number): number {
  const s = n.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]) + 2;
  return s.includes(".") ? s.split(".")[1].length : 0;
}

function trimDecimals(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.split(".");
  return stripZeros(frac ? `${whole}.${frac.slice(0, decimals)}` : whole);
}

function stripZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function formatUsd(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function withUsd(summary: string, valueUsd: number, token: TokenDef): string {
  return token.symbol === "USDC" || !(valueUsd > 0) ? summary : `${summary} (~$${formatUsd(valueUsd)})`;
}

function planStep(protocol: string, action: IntentType, params: Record<string, any>, order: number, gas = "0"): PlanStep {
  return { protocol, action, params, estimatedGasWei: gas, order };
}
