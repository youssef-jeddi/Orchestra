// ─── Auth — which sign-in buttons the Privy window shows (ORC-74) ───
// Run with `npm run test:login-methods`. The Privy config's `loginMethods` replaces the dashboard's
// choice of buttons, so Google must stay out until it is enabled in the Privy dashboard: it's only
// listed with NEXT_PUBLIC_PRIVY_GOOGLE=1.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import { flagOn, loginMethodsFor, loginMessageFor } from "../../frontend/src/lib/loginMethods.js";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("Google is off unless the flag is set: no broken button while it's off in the dashboard", () => {
  for (const v of [undefined, "", "0", "false", "no", "google", " ", null]) {
    assert.deepEqual(loginMethodsFor(v), ["passkey", "email", "wallet"], `flag ${JSON.stringify(v)}`);
    assert.ok(!/Google/.test(loginMessageFor(v)), "the message doesn't promise Google");
  }
});

test("NEXT_PUBLIC_PRIVY_GOOGLE=1 (or true) adds Google after email, before wallets", () => {
  for (const v of ["1", "true", "TRUE", " 1 "]) {
    assert.equal(flagOn(v), true);
    assert.deepEqual(loginMethodsFor(v), ["passkey", "email", "google", "wallet"], `flag ${JSON.stringify(v)}`);
    assert.match(loginMessageFor(v), /Google/);
  }
});

test("the Privy config reads the flag by its full name, so Next.js inlines it at build time", () => {
  const src = readFileSync(path.resolve(__dirname, "../../frontend/src/lib/privy.js"), "utf8");
  assert.match(src, /process\.env\.NEXT_PUBLIC_PRIVY_GOOGLE\b/);
  assert.match(src, /loginMethods:\s*loginMethodsFor\(GOOGLE_FLAG\)/);
  assert.ok(!/loginMethods:\s*\[/.test(src), "no hard-coded list that could bring Google back");
});

(async () => {
  console.log("login methods");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
