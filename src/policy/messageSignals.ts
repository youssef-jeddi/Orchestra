// ─── Policy — wording signals in the user's message ───
// Pure, deterministic reading of the raw message, used only to ESCALATE: pressure wording
// ("pre-approved", "urgent", "system override") and addresses the user typed. The model can't
// hide either from this, because the signals come from the message, not from the planner output.
// Only slugs and normalised addresses/names are kept, never the message text (ORC-90).

export interface MessageSignals {
  /** Slugs of the wording groups that matched: "override", "skip-approval", "urgency". */
  pressure: string[];
  /** Lowercased 0x addresses and ENS names written in the message, deduplicated. */
  mentions: string[];
  /** The wording says all or most of the funds ("all my usdc", "everything", "max"). */
  allFunds: boolean;
}

const ALL_FUNDS = [
  /\ball (of )?my\b/,
  /\ball (the |my )?(eth|usdc|weth|usdt|funds|money|balance|tokens|coins)\b/,
  /\beverything\b/,
  /\b(entire|whole) (balance|account)\b/,
  /\b(max|maximum)\b/,
];

const GROUPS: [string, RegExp[]][] = [
  ["override", [
    /\b(system|admin|administrator|developer|dev|root)\s+(override|mode|command|instruction|instructions|message)\b/,
    /\bignore\s+(?:\w+\s+){0,2}(previous|prior|all|above|earlier)\s+(?:\w+\s+){0,2}(rules?|instructions?|limits?|checks?|policy|policies|guidelines)\b/,
    /\b(override|bypass|disable|skip|turn off)\s+(?:\w+\s+){0,2}(rules?|limits?|checks?|approvals?|confirmations?|security|policy|policies)\b/,
    /\bauto[- ]?(execute|approve)\b/,
    /\bverdict\b/,
    /["']\s*(verdict|approved|approval|decision)\s*["']\s*:/,
  ]],
  ["skip-approval", [
    /\b(pre-?approved|already approved|approved by)\b/,
    /\bno need to (confirm|approve|ask|check)\b/,
    /\b(don'?t|do not|dont|without)\s+(ask|asking|confirm|confirming|confirmation|approval|check|checking)\b/,
    /\b(orchestra|support|security|admin) team\b/,
  ]],
  ["urgency", [
    /\b(urgent|urgently|emergency|compromised|hacked|stolen)\b/,
    /\bsecure (it|them|my|your|the)\b/,
  ]],
];

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
// Same shape as the ENS check in intent/resolve.ts, but unanchored to find names inside a sentence.
const ENS = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth\b/gi;

function normalise(message: string): string {
  return message
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pressure wording and typed addresses/names in a message. Never includes the message itself. */
export function messageSignals(message: string): MessageSignals {
  const text = normalise(String(message ?? ""));
  const pressure = GROUPS.filter(([, res]) => res.some((re) => re.test(text))).map(([slug]) => slug);
  const found = [...text.matchAll(ADDRESS), ...text.matchAll(ENS)].map((m) => m[0].toLowerCase());
  return { pressure, mentions: [...new Set(found)], allFunds: ALL_FUNDS.some((re) => re.test(text)) };
}
