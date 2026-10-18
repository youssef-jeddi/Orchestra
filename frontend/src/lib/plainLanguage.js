// ── Plain-language labels for the /simple chat ──
// What the chat cards, chips and first-session welcome say, in everyday words and with "your
// account" instead of the Safe. Display text only: the server's verdict values and rule slugs
// are unchanged and still decide everything. Pure, so it's tested without a browser
// (src/intent/plainLanguage.test.ts).

/** The verdict pill on a chat card, by the server's verdict. */
export const VERDICT_LABELS = {
  AUTO_EXECUTE: 'Done automatically',
  NEEDS_APPROVAL: 'Needs your OK',
  BLOCKED: 'Blocked',
  INFO: 'Info',
};

/** An unknown verdict reads as "needs your OK" rather than as something that went through. */
export const verdictLabel = (verdict) => VERDICT_LABELS[verdict] ?? VERDICT_LABELS.NEEDS_APPROVAL;

/** The chips that say which rule applied, by the server's rule slug. */
export const RULE_LABELS = {
  'daily-limit': 'Over your daily limit',
  'daily-count-velocity': 'Lots of actions today',
  'unverified-token': "Token we haven't checked",
  'unknown-recipient': 'New recipient',
  'habit-anomaly': 'Bigger than usual',
  'unknown-intent': "Didn't understand",
  malformed: "Didn't understand",
  denylist: 'Token not allowed',
};

/** A slug we have no wording for still gets a readable chip, never the raw slug. */
export const ruleLabel = (slug) => RULE_LABELS[slug] ?? 'Extra check';

/** Suggested first actions: small amounts first, nothing that mentions the Safe. */
export const EXAMPLES = [
  'What can I do here?',
  "What's my balance?",
  'Show my account address',
  'Send 1 USDC to vitalik.eth',
  'Swap 1 USDC for ETH',
  "What's the price of ETH?",
];

export const WELCOME = {
  title: 'Welcome to Orchestra',
  intro: 'Tell me what you want to do with your money, in your own words. Small things happen right away; anything bigger or riskier waits for your OK. Try one of these to start:',
};

/** The welcome and suggestions stay until the person has said something themselves. */
export const showWelcome = (messages) => !messages.some((m) => m.role === 'user');

/** Link text for a finished action (instead of naming a block explorer). */
export const RECEIPT_LABEL = 'View receipt ↗';

/** The balance card's tiles: wrapped ETH only shows when the account holds some. */
export function balanceTiles(balances) {
  const tiles = [{ label: 'ETH', value: balances?.eth?.toFixed(4) }];
  if (balances?.weth > 0) tiles.push({ label: 'WETH', hint: TOKEN_HINTS.WETH, value: balances.weth.toFixed(4) });
  tiles.push({ label: 'USDC', value: balances?.usdc?.toFixed(2) });
  return tiles;
}

/** What a passkey is, in one phrase: the way a beginner confirms an action. Reused wherever the UI asks for one. */
export const PASSKEY_MEANS = "Face ID, your fingerprint or your device's screen lock";

/** Tooltip on the header "Add passkey" button for people who signed in with a wallet. */
export const ADD_PASSKEY_HINT = 'Approve bigger actions with Face ID or your fingerprint instead of your wallet';

/** Short, friendly name for a balance card; WETH is explained, not assumed. */
export const TOKEN_HINTS = { WETH: 'wrapped ETH' };
