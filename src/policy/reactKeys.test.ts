// ─── Frontend — React list keys (source scan, no browser) ───
// Run with `npm run test:react-keys`. React warns "Each child in a list should have a unique
// key" for an element rendered from .map() without a key. Flags the common mistake before it
// reaches the console. (Not covered: the warning Privy's own sign-in window logs for returning
// wallet users; see the note in OrchestraContext.jsx.)

import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? walk(rel) : /\.jsx?$/.test(e.name) ? [rel] : [];
  });

/** `.map(... => (<Tag ...` calls whose first JSX element carries no key= before its opening tag closes. */
export function unkeyedMaps(src: string): string[] {
  const out: string[] = [];
  const re = /\.map\(\s*\(?[^)]*\)?\s*=>\s*\(?\s*(?:\n\s*)?<([A-Za-z][\w.]*)([^>]*?)>/g;
  for (const m of src.matchAll(re)) if (!/\bkey=/.test(m[2])) out.push(`<${m[1]}${m[2].slice(0, 40)}`);
  return out;
}

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("the scan flags a missing key and accepts a keyed element", () => {
  assert.equal(unkeyedMaps("{xs.map((x) => <li>{x}</li>)}").length, 1);
  assert.equal(unkeyedMaps("{xs.map((x) => (\n <li key={x}>{x}</li>))}").length, 0);
});

test("no list rendered with .map() in the frontend is missing its key", () => {
  const bad = walk("frontend/src").flatMap((f) => unkeyedMaps(fs.readFileSync(path.join(ROOT, f), "utf8")).map((h) => `${f}: ${h}`));
  assert.deepEqual(bad, []);
});

(async () => {
  console.log("react keys");
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
