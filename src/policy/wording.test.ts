// ─── Wording — newcomers never see the word "Safe" (source scan, no browser) ───
// Run with `npm run test:wording`. Scans string literals and JSX text in the user-facing
// frontend and in the backend message builders; identifiers, imports and comments are ignored.

import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { PLANNER_SYSTEM_PROMPT } from "../intent/prompt";

const ROOT = path.resolve(__dirname, "../..");
const files = (dir: string, exts: string[]): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? files(rel, exts) : exts.some((x) => e.name.endsWith(x)) ? [rel] : [];
  });

/** User-visible "Safe" in a source file: inside quotes or JSX text, not in comments/imports/identifiers. */
export function visibleSafe(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const hits: string[] = [];
  for (const line of code.split("\n")) {
    if (/^\s*(import|export .* from)\b/.test(line)) continue;
    const texts = [
      ...(line.match(/(["'`])(?:\\.|(?!\1).)*\1/g) ?? []),
      ...(line.match(/>[^<>{}]+(?=<|$)/g) ?? []),
      ...(/^\s*[A-Za-z][^<>{}=;()]*$/.test(line) && !/^\s*(const|let|var|function|return|if|else|case)\b/.test(line) ? [line] : []),
    ];
    for (const t of texts) if (/\bSafe\b/.test(t)) hits.push(line.trim());
  }
  return hits;
}

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("the scanner catches visible Safe and ignores identifiers and comments", () => {
  assert.equal(visibleSafe("<Zap /> Auto-executed via Safe").length, 1);
  assert.equal(visibleSafe('const t = "Your Safe is ready";').length, 1);
  assert.equal(visibleSafe("// the Safe\nimport { useSafe } from './x';\nconst s = safeAddress; <SafePanel />").length, 0);
});

test("frontend components, pages, and helpers show no 'Safe' to the user", () => {
  const bad: string[] = [];
  for (const f of files("frontend/src", [".js", ".jsx"])) {
    for (const h of visibleSafe(fs.readFileSync(path.join(ROOT, f), "utf8"))) bad.push(`${f}: ${h}`);
  }
  assert.deepEqual(bad, []);
});

test("bridge messages shown to users say 'account'", () => {
  for (const f of ["src/integrations/passkey/emailGate.ts"]) {
    const hits = visibleSafe(fs.readFileSync(path.join(ROOT, f), "utf8")).filter((l) => !/console\.|\[Safe\]|\[safe\]|\bsafe:|address safe|safe\$\{/.test(l));
    assert.deepEqual(hits, [], f);
  }
});

test("a reverted account transaction is explained in plain words, with no codes", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/integrations/safe/transaction.ts"), "utf8");
  const thrown = src.match(/throw new (?:Error|UserFacingError)\(`(This didn't go through[^`]*)`\)/)?.[1];
  assert.ok(thrown, "the revert error is thrown with the plain sentence");
  assert.ok(!/GS0|nonce|inner call|revert|\bSafe\b/i.test(thrown!), thrown);
});

test("the planner prompt tells the model to say 'account' but still understands 'Safe'", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /Call the user's Safe "your account", never "Safe"/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Still understand a user who says "Safe"/);
  assert.match(PLANNER_SYSTEM_PROMPT, /fund my safe with 0\.05 eth/);
  assert.ok(!/own Safe|Safe addresses/.test(PLANNER_SYSTEM_PROMPT));
});

test("the README speaks to newcomers about 'your account'", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.ok(!/fund my Safe|your Safe|your own Safe|the Safe\b/.test(readme));
});

(async () => {
  console.log("wording");
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
