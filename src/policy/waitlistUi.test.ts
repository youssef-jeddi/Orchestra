// ─── /waitlist form — email check and wording (frontend helpers, no browser) ───
// Run with `npm run test:waitlist-ui`. ORC-50.

import assert from "node:assert/strict";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { WAITLIST_TEXT, normalizeEmail, emailProblem, joinWaitlist } from "../../frontend/src/lib/waitlist.js";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("addresses are stored trimmed and in lower case", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(normalizeEmail(null), "");
});

test("an empty field asks for an email instead of calling it invalid", () => {
  assert.equal(emailProblem(""), WAITLIST_TEXT.empty);
  assert.equal(emailProblem("   "), WAITLIST_TEXT.empty);
});

test("ordinary addresses are accepted, including plus tags and subdomains", () => {
  for (const ok of ["ada@example.com", "a.b+orchestra@mail.example.co.uk", " Ada@Example.com "]) {
    assert.equal(emailProblem(ok), null, ok);
  }
});

test("typos are caught before sending, with a sentence that says what to do", () => {
  for (const bad of ["ada", "ada@", "@example.com", "ada@example", "ada @example.com", "ada@@example.com"]) {
    assert.equal(emailProblem(bad), WAITLIST_TEXT.invalid, bad);
  }
  assert.match(WAITLIST_TEXT.invalid, /try again/);
  assert.equal(emailProblem(`${"a".repeat(250)}@example.com`), WAITLIST_TEXT.invalid, "longer than any real address");
});

test("joining refuses a bad address and reports that nothing is saved yet", async () => {
  await assert.rejects(joinWaitlist("nope"), { message: WAITLIST_TEXT.invalid });
  assert.deepEqual(await joinWaitlist("ada@example.com"), { saved: false });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e: any) { console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed${passed === tests.length ? "" : `, ${tests.length - passed} failed`}`);
})();
