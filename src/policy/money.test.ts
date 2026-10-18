// ─── Policy — dollar amounts in reasons (no network) ───
// Run with `npm run test:money`. No float noise in anything the user reads.

import assert from "node:assert/strict";
import { formatUsd, decide, DEFAULT_DAILY_LIMIT } from "./index";
import { describeLoosening } from "./limits";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { formatUsd as uiUsd } from "../../frontend/src/lib/money.js";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const CASES: [number, string][] = [
  [0.23848400000000003, "$0.24"],
  [5.053763999999999, "$5.05"],
  [4.81528, "$4.82"],
  [100, "$100"],
  [1000, "$1,000"],
  [12.5, "$12.50"],
  [0, "$0"],
  [0.004, "less than $0.01"],
  [0.0049, "less than $0.01"],
  [0.01, "$0.01"],
  [1234567.891, "$1,234,567.89"],
  [NaN, "$0"],
];

test("formatUsd: cents, whole dollars without .00, thousands, tiny amounts never '$0.00'", () => {
  for (const [n, text] of CASES) assert.equal(formatUsd(n), text, String(n));
});

test("the UI helper gives the same text as the server's", () => {
  for (const [n, text] of CASES) assert.equal(uiUsd(n), text, String(n));
});

const plan = { summary: "swap", steps: [{ action: "swap", params: {} }] };

test("decide: an auto-executed reason shows cents, not float noise", () => {
  const d = decide({ intentType: "swap", valueUsd: 0.23848400000000003, dailyLimitUsd: 100, plan, history: [{ valueUsd: 4.81528, at: new Date().toISOString() }] });
  assert.equal(d.verdict, "AUTO_EXECUTE");
  assert.equal(d.reason, "$0.24 is within your $100 daily limit for automatic actions ($4.82 used today).");
  const again = decide({ intentType: "swap", valueUsd: 1, dailyLimitUsd: DEFAULT_DAILY_LIMIT, plan, history: [{ valueUsd: 5.053763999999999, at: new Date().toISOString() }] });
  assert.match(again.reason, /\(\$5\.05 used today\)/);
});

test("decide: the over-limit and habit reasons are tidy too", () => {
  const over = decide({ intentType: "swap", valueUsd: 0.1 + 0.2 + 99.8, dailyLimitUsd: 100, plan, history: [{ valueUsd: 0.30000000000000004, at: new Date().toISOString() }] });
  assert.equal(over.verdict, "NEEDS_APPROVAL");
  assert.match(over.reason, /over your \$100 daily limit for automatic actions \(\$0\.30 used today\)/);
  const habit = decide({ intentType: "swap", valueUsd: 600.1234, dailyLimitUsd: 1000, plan, profile: { typicalMaxUsd: 10.000000000000002 } });
  assert.match(habit.reason, /^\$600\.12 is bigger than you usually move \(typically up to \$10\)/);
  const tiny = decide({ intentType: "swap", valueUsd: 0.001, dailyLimitUsd: 100, plan });
  assert.match(tiny.reason, /^less than \$0\.01 is within/);
});

test("limits notices use the same format", () => {
  assert.deepEqual(describeLoosening({ dailyLimitUsd: 10.000000000000002 }, { set: { dailyLimitUsd: 500.1 } }), ["Daily limit without asking: $10 → $500.10"]);
});

console.log("money");
for (const [name, fn] of tests) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
console.log(`\n${passed} passed`);
