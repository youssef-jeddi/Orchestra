// ─── Intent — planned DeFi actions, answered in words (ORC-20) ───
// Staking (planned: Lido), lending and borrowing (planned: Aave) and savings vaults
// (planned: an ERC-4626 vault) are understood by the planner but not built yet. The
// pipeline answers them here, before the resolver, the limits, approvals or any adapter
// run, so a planned action can never move funds. The reply only repeats what was
// understood, in plain words, so the user knows they were heard.
//
// Nothing the model wrote is shown verbatim: amounts are already schema-checked, token
// names go through the registry (or a strict symbol pattern) and protocol names come
// from a fixed list. A protocol is named only when the user named one. The reply's
// language follows the planner's `language` field (English fallback).

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

type Locale = "en" | "fr";

type Copy = {
  understood: (list: string) => string;
  cant: Record<ComingSoonAction, string>;
  canDoNow: string;
  nothingDone: string;
  // Amount glue
  your: (token: string) => string;
  allYour: (token: string) => string;
  pctOfYour: (pct: string, token: string) => string;
  everything: string;
  pctOfFunds: (pct: string) => string;
  usdOf: (n: string, token: string) => string;
  usdOnly: (n: string) => string;
  // Step shapes. `on` is "" or " with Lido" / " sur Aave" etc.
  stake: (what: string, on: string) => string;
  unstake: (what: string, on: string) => string;
  lend: (what: string, on: string) => string;
  withdrawLend: (what: string, on: string) => string;
  borrow: (what: string, on: string) => string;
  repay: (what: string, on: string) => string;
  depositYield: (what: string, vault: string) => string;
  withdrawYield: (what: string, vault: string) => string;
  vaultNamed: (name: string) => string;
  vaultDefault: string;
  yourVaultNamed: (name: string) => string;
  yourVaultDefault: string;
  money: string;
  yourMoney: string;
  what: string;
  // Protocol prepositions (leading space included when non-empty)
  withProto: (name: string) => string;
  fromProto: (name: string) => string;
  onProto: (name: string) => string;
  // List join
  then: (head: string, last: string) => string;
};

const EN: Copy = {
  understood: (list) => `I understood: ${list}.`,
  cant: {
    stake: "I can't do staking yet.",
    unstake: "I can't do staking yet.",
    lend: "I can't do lending yet.",
    withdraw_lend: "I can't do lending yet.",
    borrow: "I can't do borrowing yet.",
    repay: "I can't do borrowing yet.",
    deposit_yield: "I can't use savings vaults yet.",
    withdraw_yield: "I can't use savings vaults yet.",
  },
  canDoNow: "For now I can send, swap, add or remove liquidity, and check your balance or prices.",
  nothingDone: "Nothing was done. Ask me for the rest in a separate message.",
  your: (t) => `your ${t}`,
  allYour: (t) => `all your ${t}`,
  pctOfYour: (p, t) => `${p} of your ${t}`,
  everything: "everything",
  pctOfFunds: (p) => `${p} of your funds`,
  usdOf: (n, t) => `$${n} of ${t}`,
  usdOnly: (n) => `$${n}`,
  stake: (w, on) => `stake${w ? ` ${w}` : ""}${on}`,
  unstake: (w, on) => `unstake${w ? ` ${w}` : ""}${on}`,
  lend: (w, on) => `lend${w ? ` ${w}` : ""}${on}`,
  withdrawLend: (w, on) => `take back ${w || "what"} you lent${on}`,
  borrow: (w, on) => `borrow${w ? ` ${w}` : ""}${on}`,
  repay: (w, on) => `repay ${w || "what"} you borrowed${on}`,
  depositYield: (w, vault) => `put ${w || "money"} in ${vault} to earn interest`,
  withdrawYield: (w, vault) => `take ${w || "your money"} out of ${vault}`,
  vaultNamed: (n) => `a ${n} vault`,
  vaultDefault: "a savings vault",
  yourVaultNamed: (n) => `your ${n} vault`,
  yourVaultDefault: "your savings vault",
  money: "money",
  yourMoney: "your money",
  what: "what",
  withProto: (n) => ` with ${n}`,
  fromProto: (n) => ` from ${n}`,
  onProto: (n) => ` on ${n}`,
  then: (head, last) => `${head}, then ${last}`,
};

const FR: Copy = {
  understood: (list) => `J'ai compris : ${list}.`,
  cant: {
    stake: "Je ne peux pas encore faire de staking.",
    unstake: "Je ne peux pas encore faire de staking.",
    lend: "Je ne peux pas encore prêter.",
    withdraw_lend: "Je ne peux pas encore prêter.",
    borrow: "Je ne peux pas encore emprunter.",
    repay: "Je ne peux pas encore emprunter.",
    deposit_yield: "Je ne peux pas encore utiliser les coffres d'épargne.",
    withdraw_yield: "Je ne peux pas encore utiliser les coffres d'épargne.",
  },
  canDoNow: "Pour l'instant je peux envoyer, échanger, ajouter ou retirer de la liquidité, et vérifier ton solde ou les prix.",
  nothingDone: "Rien n'a été fait. Demande-moi le reste dans un message séparé.",
  your: (t) => `ton ${t}`,
  allYour: (t) => `tout ton ${t}`,
  pctOfYour: (p, t) => `${p} de ton ${t}`,
  everything: "tout",
  pctOfFunds: (p) => `${p} de tes fonds`,
  usdOf: (n, t) => `${n} $ de ${t}`,
  usdOnly: (n) => `${n} $`,
  stake: (w, on) => `staker${w ? ` ${w}` : ""}${on}`,
  unstake: (w, on) => `retirer du staking${w ? ` ${w}` : ""}${on}`,
  lend: (w, on) => `prêter${w ? ` ${w}` : ""}${on}`,
  withdrawLend: (w, on) => `récupérer ${w || "ce"} que tu as prêté${on}`,
  borrow: (w, on) => `emprunter${w ? ` ${w}` : ""}${on}`,
  repay: (w, on) => `rembourser ${w || "ce"} que tu as emprunté${on}`,
  depositYield: (w, vault) => `placer ${w || "de l'argent"} dans ${vault} pour gagner des intérêts`,
  withdrawYield: (w, vault) => `retirer ${w || "ton argent"} de ${vault}`,
  vaultNamed: (n) => `un coffre ${n}`,
  vaultDefault: "un coffre d'épargne",
  yourVaultNamed: (n) => `ton coffre ${n}`,
  yourVaultDefault: "ton coffre d'épargne",
  money: "de l'argent",
  yourMoney: "ton argent",
  what: "ce",
  withProto: (n) => ` avec ${n}`,
  fromProto: (n) => ` de ${n}`,
  onProto: (n) => ` sur ${n}`,
  then: (head, last) => `${head}, puis ${last}`,
};

const LOCALES: Record<Locale, Copy> = { en: EN, fr: FR };

/** What Orchestra can do today (English). Prefer `describeComingSoon` for user replies. */
export const CAN_DO_NOW = EN.canDoNow;

function localeOf(language: string | undefined): Locale {
  if (!language) return "en";
  const code = language.trim().toLowerCase().slice(0, 2);
  return code === "fr" ? "fr" : "en";
}

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
function amountPhrase(step: ComingSoonStepT, copy: Copy): string {
  const token = tokenName(step.token);
  const a = step.amount;
  if (!a) return token ? copy.your(token) : "";
  if (a === "all" || a === "max") return token ? copy.allYour(token) : copy.everything;
  if (a.endsWith("%")) return token ? copy.pctOfYour(a, token) : copy.pctOfFunds(a);
  const n = a.startsWith(".") ? `0${a}` : a;
  if (step.unit === "usd") return token ? copy.usdOf(n, token) : copy.usdOnly(n);
  return token ? `${n} ${token}` : n;
}

/** Strip a leading "your "/"ton " so borrow doesn't say "borrow your USDC". */
function bareAmount(phrase: string, copy: Copy): string {
  if (phrase.startsWith("your ")) return phrase.slice(5);
  if (phrase.startsWith("ton ")) return phrase.slice(4);
  return phrase;
}

/** "take back the USDC you lent", not "take back your USDC you lent". */
function theAmount(phrase: string): string {
  return phrase.replace(/\byour\b/, "the").replace(/\bton\b/, "le");
}

/** One planned step in plain words, e.g. "stake 0.1 ETH with Lido" or "emprunter 50 USDC". */
export function describeComingSoonStep(step: ComingSoonStepT, language?: string): string {
  const copy = LOCALES[localeOf(language)];
  const named = protocolName(step.protocol);
  // Only name a protocol the user named (and that we recognise). Never invent Lido/Aave.
  const withOn = named ? copy.withProto(named) : "";
  const fromOn = named ? copy.fromProto(named) : "";
  const onOn = named ? copy.onProto(named) : "";
  const what = amountPhrase(step, copy);

  switch (step.action) {
    case "stake":
      return copy.stake(what, withOn);
    case "unstake":
      return copy.unstake(what, fromOn);
    case "lend":
      return copy.lend(what, onOn);
    case "withdraw_lend":
      return copy.withdrawLend(theAmount(what), onOn);
    case "borrow":
      return copy.borrow(bareAmount(what, copy), onOn);
    case "repay":
      return copy.repay(theAmount(what), onOn);
    case "deposit_yield":
      return copy.depositYield(what || "", named ? copy.vaultNamed(named) : copy.vaultDefault);
    case "withdraw_yield":
      return copy.withdrawYield(what || "", named ? copy.yourVaultNamed(named) : copy.yourVaultDefault);
  }
}

/**
 * The whole answer to a message with planned actions. `others` is how many supported steps
 * came with them: nothing in the message runs, so the user is told to ask for those separately.
 * `language` is the planner's language code ("fr", "en", …); unknown codes fall back to English.
 */
export function describeComingSoon(steps: ComingSoonStepT[], others = 0, language?: string): string {
  const copy = LOCALES[localeOf(language)];
  const understood = steps.map((s) => describeComingSoonStep(s, language));
  const list = understood.length > 1
    ? copy.then(understood.slice(0, -1).join(", "), understood[understood.length - 1])
    : understood[0];
  const cants = [...new Set(steps.map((s) => copy.cant[s.action]))];
  const parts = [copy.understood(list), ...cants];
  if (others > 0) parts.push(copy.nothingDone);
  parts.push(copy.canDoNow);
  return parts.join(" ");
}
