// ─── Passkey recovery UI helpers (frontend, no browser) ───

import assert from "node:assert/strict";
// @ts-expect-error plain JS
import * as ui from "../../../frontend/src/lib/passkeyRecovery.js";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("shouldOfferRecovery follows the server's offered flag", () => {
  assert.equal(ui.shouldOfferRecovery({ offered: true }), true);
  assert.equal(ui.shouldOfferRecovery({ offered: false }), false);
  assert.equal(ui.shouldOfferRecovery(null), false);
});

test("canCancelRecovery for in-flight states only", () => {
  assert.equal(ui.canCancelRecovery({ status: "awaiting_telegram" }), true);
  assert.equal(ui.canCancelRecovery({ status: "granted" }), true);
  assert.equal(ui.canCancelRecovery({ status: "pending" }), true);
  assert.equal(ui.canCancelRecovery({ status: "none" }), false);
});

test("pendingLabel describes the wait", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  assert.match(ui.pendingLabel({ pendingUntil: new Date(now + 2 * 3600_000).toISOString(), active: false }, now), /~2h/);
  assert.match(ui.pendingLabel({ pendingUntil: new Date(now + 50 * 3600_000).toISOString(), active: false }, now), /day/);
  assert.equal(ui.pendingLabel({ pendingUntil: new Date(now - 1000).toISOString(), active: true }, now), "Now active");
  assert.equal(ui.isPendingReplacement({ pendingUntil: "x", active: false }), true);
  assert.equal(ui.isPendingReplacement({ active: true }), false);
});

for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}`); console.error(e); process.exitCode = 1; }
}
console.log(`${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
