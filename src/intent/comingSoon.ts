// ─── Intent — planned DeFi actions, answered in words (ORC-20) ───
// Staking (planned: Lido), lending and borrowing (planned: Aave) and savings vaults
// (planned: an ERC-4626 vault) are understood by the planner but not built yet. The
// pipeline answers them here, before the resolver, the limits, approvals or any adapter
// run, so a planned action can never move funds. The reply only repeats what was
// understood, in plain words, so the user knows they were heard.
//
// Nothing the model wrote is shown verbatim: amounts are already schema-checked, token
// names go through the registry (or a strict symbol pattern) and protocol names come
// from a fixed list.

import { lookupToken } from "./tokens";
import type { ComingSoonStepT, ComingSoonAction } from "./schema";

/** Protocols the user may name, keyed by a squashed lowercase form. Anything else isn't echoed. */
const KNOWN_PROTOCOLS: Record<string, string> = {
  lido: "Lido",
  rocketpool: "Rocket Pool",
  etherfi: "ether.fi",
  eigenlayer: "EigenLayer",
  aave: "Aave",
  compound: "Compound",
  spark: "Spark",
  morpho: "Morpho",
  yearn: "Yearn",
};

/** The protocol each family is planned on, named when the user didn't name one. */
const PLANNED = { staking: "Lido", lending: "Aave" } as const;

const CANT: Record<ComingSoonAction, string> = {
  stake: "I can't do staking yet.",
  unstake: "I can't do staking yet.",
  lend: "I can't do lending yet.",
  withdraw_lend: "I can't do lending yet.",
  borrow: "I can't do borrowing yet.",
  repay: "I can't do borrowing yet.",
  deposit_yield: "I can't use savings vaults yet.",
  withdraw_yield: "I can't use savings vaults yet.",
};

/** What Orchestra can do today, so the answer ends on something useful. */
export const CAN_DO_NOW = "For now I can send, swap, add or remove liquidity, and check your balance or prices.";

function protocolName(raw: string | undefined): string | null {
  if (!raw) return null;
  return KNOWN_PROTOCOLS[raw.toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

/** Registry symbol, or a short plain symbol ("SOL"); anything stranger is left out. */
function tokenName(raw: string | undefined): string | null {
  if (!raw) return null;
  const known = lookupToken(raw);
  if (known) return known.symbol;
  const t = raw.trim().replace(/^\$/, "").toUpperCase();
  return /^[A-Z0-9]{1,10}$/.test(t) ? t : null;
}

/** "0.1 ETH", "$100 of USDC", "all your ETH", "50% of your USDC", "your ETH", or "" when nothing was given. */
function amountPhrase(step: ComingSoonStepT): string {
  const token = tokenName(step.token);
  const a = step.amount;
  if (!a) return token ? `your ${token}` : "";
  if (a === "all" || a === "max") return token ? `all your ${token}` : "everything";
  if (a.endsWith("%")) return token ? `${a} of your ${token}` : `${a} of your funds`;
  const n = a.startsWith(".") ? `0${a}` : a;
  if (step.unit === "usd") return token ? `$${n} of ${token}` : `$${n}`;
  return token ? `${n} ${token}` : n;
}

/** One planned step in plain words, e.g. "stake 0.1 ETH with Lido". */
export function describeComingSoonStep(step: ComingSoonStepT): string {
  const named = protocolName(step.protocol);
  // An unknown protocol the user named isn't swapped for ours: leave the name out instead.
  const on = (planned: string) => (named ? ` ${named}` : step.protocol ? "" : ` ${planned}`);
  const what = amountPhrase(step);
  const sp = (s: string) => (s ? ` ${s}` : "");
  const withOn = (word: string, planned: string) => (on(planned) ? ` ${word}${on(planned)}` : "");
  // "take back the USDC you lent", not "take back your USDC you lent".
  const the = (s: string) => s.replace(/\byour\b/, "the");

  switch (step.action) {
    case "stake":
      return `stake${sp(what)}${withOn("with", PLANNED.staking)}`;
    case "unstake":
      return `unstake${sp(what)}${withOn("from", PLANNED.staking)}`;
    case "lend":
      return `lend${sp(what)}${withOn("on", PLANNED.lending)}`;
    case "withdraw_lend":
      return `take back ${the(what) || "what"} you lent${withOn("on", PLANNED.lending)}`;
    case "borrow":
      return `borrow${sp(what.replace(/^your /, ""))}${withOn("on", PLANNED.lending)}`;
    case "repay":
      return `repay ${the(what) || "what"} you borrowed${withOn("on", PLANNED.lending)}`;
    case "deposit_yield":
      return `put ${what || "money"} in ${named ? `a ${named} vault` : "a savings vault"} to earn interest`;
    case "withdraw_yield":
      return `take ${what || "your money"} out of ${named ? `your ${named} vault` : "your savings vault"}`;
  }
}

/**
 * The whole answer to a message with planned actions. `others` is how many supported steps
 * came with them: nothing in the message runs, so the user is told to ask for those separately.
 */
export function describeComingSoon(steps: ComingSoonStepT[], others = 0): string {
  const understood = steps.map(describeComingSoonStep);
  const list = understood.length > 1
    ? `${understood.slice(0, -1).join(", ")}, then ${understood[understood.length - 1]}`
    : understood[0];
  const cants = [...new Set(steps.map((s) => CANT[s.action]))];
  const parts = [`I understood: ${list}.`, ...cants];
  if (others > 0) parts.push("Nothing was done. Ask me for the rest in a separate message.");
  parts.push(CAN_DO_NOW);
  return parts.join(" ");
}
