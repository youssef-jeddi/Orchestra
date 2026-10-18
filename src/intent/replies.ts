// ─── Intent — plain-language answers to read-only requests ───
// The texts the chat shows for "what's my balance" and "what's my address". Written
// for people new to crypto: the Safe is "your account", the user's own wallet is
// "your wallet". Kept here (not in serve.ts) so the wording can be tested.

import type { Balances } from "../executor/adapters";

/** Addresses come from the session and the account lookup, never from the model. */
export function describeAddresses(wallet: string, account: string | null): string {
  const lines = [`Your wallet: ${wallet}`];
  lines.push(account
    ? `Your account (where Orchestra trades for you): ${account}\nTo add money, send it to this address.`
    : "Your account isn't set up yet. It's created when you sign in, so try signing in again.");
  return lines.join("\n");
}

export function describeBalances(b: Balances | null, token?: string): string {
  if (!b) return "I couldn't read your balance right now (the network didn't answer). Try again in a moment.";
  if (token === "ETH") return `You have ${b.eth.toFixed(4)} ETH`;
  if (token === "WETH") return `You have ${b.weth.toFixed(4)} WETH (wrapped ETH)`;
  if (token === "USDC") return `You have ${b.usdc.toFixed(2)} USDC`;
  return `You have ${b.eth.toFixed(4)} ETH, ${b.weth.toFixed(4)} WETH (wrapped ETH) and ${b.usdc.toFixed(2)} USDC, about $${b.totalUsd.toFixed(2)} in total`;
}
