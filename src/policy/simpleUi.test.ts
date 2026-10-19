// ─── /simple wording and readability — approval card, Limits sheet, header (frontend helpers, no browser) ───
// Run with `npm run test:simple-ui`. ORC-79.

import assert from "node:assert/strict";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import * as card from "../../frontend/src/lib/approvalCard.js";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import * as activity from "../../frontend/src/lib/activity.js";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import * as limits from "../../frontend/src/lib/limits.js";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { HINT_COLOR, HINT_SIZE, SURFACES, contrastRatio } from "../../frontend/src/lib/contrast.js";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { headerState, CONNECTING_GIVE_UP_MS } from "../../frontend/src/lib/connection.js";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { PASSKEY_MEANS } from "../../frontend/src/lib/plainLanguage.js";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { SIGN_REFUSED } from "../../frontend/src/lib/emailPasskey.js";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("the dollar value is shown once, for every kind of action", () => {
  assert.equal(card.valueSuffix("Send 0.0001 ETH to 0x5879…5723 (~$0.24)", 0.24), "", "already in the summary: nothing added");
  assert.equal(card.valueSuffix("Swap 10 USDC for ETH ($10.00)", 10), "");
  assert.equal(card.valueSuffix("Add liquidity to the ETH/USDC pool", 25.5), " — $25.50", "not in the summary: shown once, after it");
  assert.equal(card.valueSuffix("Send 5 USDC to 0xabc", 5), " — $5.00");
  assert.equal(card.valueSuffix("Send something", 0), "", "no value, no suffix");
  assert.equal(card.valueSuffix("Send something", undefined), "");
  const shown = (s: string, v: number) => (s + card.valueSuffix(s, v)).match(/\$\d/g)?.length ?? 0;
  for (const [s, v] of [["Send 0.0001 ETH to 0x1…2 (~$0.24)", 0.24], ["Remove liquidity from ETH/USDC", 7], ["Swap 1 WETH for USDC (~$2,500.00)", 2500]] as const) {
    assert.equal(shown(s, v), 1, s);
  }
});

test("a stale status line is cleared by the next action, but a load failure stays", () => {
  const saved = { text: limits.LIMITS_TEXT.saved, bad: false };
  const nothing = { text: limits.LIMITS_TEXT.cancelled, bad: false };
  assert.deepEqual(limits.noteAfterAction(nothing, true), limits.NO_NOTE, "edit / ask to remove / keep → cleared");
  assert.deepEqual(limits.noteAfterAction(saved, true), limits.NO_NOTE);
  const loadFailed = { text: "Couldn't load your limits: offline", bad: true };
  assert.deepEqual(limits.noteAfterAction(loadFailed, false), loadFailed, "nothing was loaded: the failure is still true");
  assert.deepEqual(limits.NO_NOTE, { text: "", bad: false });
});

test("blocked send for a user with no passkey: plain, names the exact button, Telegram/phone as the other way", () => {
  const c = card.approvalControls({ intentType: "send", approval: { id: "a" }, passkeyReg: false });
  assert.equal(c.mode, "need-passkey", "the decided behaviour is unchanged");
  assert.equal(c.canDecline, true);
  assert.equal(card.declineLabel("send"), "Don't send");
  assert.match(c.text, /Face ID/);
  assert.match(c.text, /fingerprint/);
  assert.match(c.text, /screen lock/);
  assert.ok(c.text.includes("“🔑 Add passkey”"), "the button as it is labelled");
  assert.match(c.text, /Telegram/);
  assert.match(c.text, /phone/);
  assert.ok(c.text.indexOf("Add passkey") < c.text.indexOf("Telegram"), "passkey first, Telegram as the other option");
  assert.doesNotMatch(c.text, /personal wallet|your wallet/i, "never offers paying from the personal wallet");
});

test("anywhere the UI asks a beginner for a passkey it says what that means", () => {
  assert.equal(PASSKEY_MEANS, "Face ID, your fingerprint or your device's screen lock");
  for (const t of [card.NEEDS_PASSKEY_TEXT, SIGN_REFUSED, limits.confirmingText("passkey")]) assert.ok(t.includes(PASSKEY_MEANS), t);
  assert.equal(limits.confirmingText("wallet").includes("passkey"), false);
});

test("hint text meets WCAG AA (4.5:1) on the page and on a card, at 12px or more", () => {
  for (const [name, bg] of Object.entries(SURFACES)) {
    const ratio = contrastRatio(HINT_COLOR, bg as string);
    assert.ok(ratio >= 4.5, `${HINT_COLOR} on ${name} ${bg}: ${ratio.toFixed(2)}:1`);
  }
  assert.ok(HINT_SIZE >= 12);
  assert.ok(contrastRatio("#666666", SURFACES.card) < 4.5, "the old hint colour did not meet it");
  assert.ok(contrastRatio("#777777", SURFACES.card) < 4.5);
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 1e-9, "the helper is the standard formula");
  assert.ok(Math.abs(contrastRatio("#ffffff", "#ffffff") - 1) < 1e-9);
});

test("the automatic-payments box and its hint agree: empty means no limit", () => {
  assert.equal(limits.LIMITS_TEXT.countPlaceholder, "No limit");
  assert.match(limits.LIMITS_TEXT.countHint, /empty for no limit/);
});

test("header: nothing is shown until the connection state is known, then the right controls", () => {
  const base = { connected: false, privyConfigured: true, privyReady: false, privyAuthenticated: false, gaveUp: false };
  assert.equal(headerState(base), "connecting", "first load: not the sign-in buttons yet");
  assert.equal(headerState({ ...base, privyReady: true, privyAuthenticated: true }), "connecting", "signed in, wallet being attached");
  assert.equal(headerState({ ...base, privyReady: true }), "signed-out", "known to be signed out");
  assert.equal(headerState({ ...base, privyReady: true, privyAuthenticated: true, connected: true }), "connected");
  assert.equal(headerState({ ...base, connected: true }), "connected");
  assert.equal(headerState({ ...base, privyConfigured: false }), "signed-out", "MetaMask/Ledger only: known at once");
  assert.equal(headerState({ ...base, gaveUp: true }), "signed-out", "never stuck on Connecting…");
  assert.ok(CONNECTING_GIVE_UP_MS >= 3000 && CONNECTING_GIVE_UP_MS <= 15000);
});

test("the activity list says in plain words who allowed each spend, and links the receipt", () => {
  assert.equal(activity.sourceLabel("auto"), "Sent automatically");
  assert.equal(activity.sourceLabel("approved"), "You approved");
  assert.equal(activity.sourceLabel("owner"), "You signed");
  assert.equal(activity.sourceLabel(undefined), "Sent", "older records have no source");
  const row = activity.activityRow({ valueUsd: 12.5, at: "2026-10-19T10:30:00.000Z", to: "0x1234567890abcdef1234567890abcdef12345678", token: "USDC", txHash: "0xabc", source: "owner" });
  assert.equal(row.amount, "USDC ~$12.50");
  assert.equal(row.to, "0x1234…5678");
  assert.equal(row.source, "You signed");
  assert.equal(row.receiptUrl, "https://sepolia.etherscan.io/tx/0xabc");
  const bare = activity.activityRow({ valueUsd: 3, at: "2026-10-19T10:30:00.000Z", token: "0x00000000000000000000000000000000000000e5" });
  assert.equal(bare.amount, "~$3", "a contract address isn't shown as the token");
  assert.equal(bare.receiptUrl, null);
  assert.equal(bare.to, "");
});

test("the Telegram link's id is only read when it looks like a request id", () => {
  assert.equal(activity.ownerSignIdFromSearch("?ownerSign=11111111-2222-3333-4444-555555555555"), "11111111-2222-3333-4444-555555555555");
  assert.equal(activity.ownerSignIdFromSearch("?x=1"), null);
  assert.equal(activity.ownerSignIdFromSearch("?ownerSign=<script>"), null);
  assert.match(activity.EXPIRED_OWNER_SIGN, /expired.*daily reset/);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}
console.log(`\n${passed} passed${passed === tests.length ? "" : `, ${tests.length - passed} failed`}`);
