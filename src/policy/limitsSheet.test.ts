// ─── Limits sheet — wording and form logic (frontend helpers, no browser) ───
// Run with `npm run test:limits-sheet`. ORC-69.

import assert from "node:assert/strict";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import * as l from "../../frontend/src/lib/limits.js";

const JARGON = /\b(safe|multisig|nonce|calldata|eip-?\d+|gas|hash|slug|policy|typical ?max|velocity|passkey assertion|typed data)\b/i;

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("wording is plain: no jargon, 0 means always ask, no count limit when empty", () => {
  for (const text of [...Object.values(l.LIMITS_TEXT), l.LIMITS_BUTTON_HINT, l.confirmingText("passkey"), l.confirmingText("wallet")]) {
    assert.ok(!JARGON.test(String(text)), String(text));
  }
  assert.match(l.LIMITS_TEXT.dailyHint, /0 .*always ask/);
  assert.match(l.LIMITS_TEXT.countHint, /empty for no limit/);
  assert.match(l.LIMITS_TEXT.noAddresses, /first time you send to a new address/);
  assert.match(l.confirmingText("passkey"), /passkey/);
  assert.match(l.confirmingText("wallet"), /wallet/);
  assert.equal(l.LIMITS_TEXT.cancelled, "Nothing was changed.");
});

test("each field is one clear label with its hint under it — the label is never split around the box", () => {
  assert.equal(l.LIMITS_TEXT.daily, "Most I can send a day without asking you ($)");
  assert.equal(l.LIMITS_TEXT.count, "Automatic payments a day before I ask you");
  assert.equal(l.LIMITS_TEXT.countHint, "Leave empty for no limit.");
  for (const label of [l.LIMITS_TEXT.daily, l.LIMITS_TEXT.count]) assert.ok(!/\.\.\.|_{2,}|\[|\]/.test(label), label);
});

test("removing a saved address asks first, inline, in plain words, with Remove / Keep", () => {
  assert.equal(l.removeConfirmText("0x5879…5723"), "Remove 0x5879…5723? The next time you send to it, I'll ask you first.");
  assert.ok(!JARGON.test(l.removeConfirmText("0x5879…5723")));
  assert.deepEqual([l.LIMITS_TEXT.remove, l.LIMITS_TEXT.keep], ["Remove", "Keep"]);
});

test("a cancelled or refused raise puts the saved numbers back in the form; a saved one shows the new numbers", () => {
  const saved = { dailyLimitUsd: 20, maxAutoTxPerDay: 3 };
  assert.deepEqual(l.formAfterSave({ saved: false, cancelled: true }, saved), { daily: "20", count: "3" });
  assert.deepEqual(l.formAfterSave(null, saved), { daily: "20", count: "3" }, "an error resets too");
  assert.deepEqual(l.formAfterSave(null, {}), { daily: "100", count: "" });
  assert.deepEqual(l.formAfterSave({ saved: true, limits: { policy: { dailyLimitUsd: 50 } } }, saved), { daily: "50", count: "" });
});

test("habit line: one plain sentence, never the raw number of samples or a rule name", () => {
  assert.match(l.habitLine(null), /still learning/);
  assert.match(l.habitLine({ typicalMaxUsd: null }), /still learning/);
  const line = l.habitLine({ typicalMaxUsd: 12.5, sampleSize: 9 });
  assert.equal(line, "You usually send around $12.50, so I'll ask before anything much bigger.");
  assert.ok(!JARGON.test(line));
});

test("form: starts from the stored values; an unset daily limit shows the $100 default", () => {
  assert.deepEqual(l.formFrom({}), { daily: "100", count: "" });
  assert.deepEqual(l.formFrom({ dailyLimitUsd: 0, maxAutoTxPerDay: 4 }), { daily: "0", count: "4" });
});

test("form: only changed fields are sent; blank count removes the cap; 0 is a valid daily limit", () => {
  assert.deepEqual(l.changesFrom({ daily: "100", count: "" }, {}), { policy: {} });
  assert.deepEqual(l.changesFrom({ daily: "0", count: "" }, {}), { policy: { dailyLimitUsd: 0 } });
  assert.deepEqual(l.changesFrom({ daily: "250", count: "5" }, { dailyLimitUsd: 250 }), { policy: { maxAutoTxPerDay: 5 } });
  assert.deepEqual(l.changesFrom({ daily: "50", count: "" }, { dailyLimitUsd: 50, maxAutoTxPerDay: 5 }), { policy: { maxAutoTxPerDay: null } });
  assert.deepEqual(l.changesFrom({ daily: "1000", count: "100" }, {}), { policy: { dailyLimitUsd: 1000, maxAutoTxPerDay: 100 } });
});

test("form: bad entries get a plain sentence, with the highest limit $1,000", () => {
  for (const daily of ["", "abc", "-5", "1001", "1e3", "5.555"]) {
    const r = l.changesFrom({ daily, count: "" }, {});
    assert.match(r.error, /Enter an amount from \$0 to \$1,000/, daily);
  }
  for (const count of ["-1", "1.5", "101", "x"]) {
    assert.match(l.changesFrom({ daily: "10", count }, {}).error, /whole number from 0 to 100/, count);
  }
});

test("cancelling the passkey or wallet prompt is recognised, other errors are not", () => {
  assert.equal(l.isCancel({ name: "NotAllowedError" }), true);
  assert.equal(l.isCancel({ code: 4001 }), true);
  assert.equal(l.isCancel(new Error("User rejected the request.")), true);
  assert.equal(l.isCancel(new Error("Raising a limit needs your passkey.")), false);
});

console.log("limits sheet");
for (const [name, fn] of tests) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
console.log(`\n${passed} passed`);
