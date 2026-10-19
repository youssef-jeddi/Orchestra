// ─── Safe — every Safe module gets its RPC through utils/rpc (no network) ───
// Run with `npm run test:safe-rpc`. ORC-82: a raw `new ethers.JsonRpcProvider(url)` skips
// `staticNetwork`, so a rate-limited endpoint hangs every request behind chain-id detection.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const FILES = ["transaction.ts", "detect.ts", "deploy.ts", "onboard.ts"];

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const source = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

for (const f of FILES) {
  test(`${f} imports the shared RPC helper`, () => {
    assert.match(source(f), /import\s*\{[^}]*\b(makeSepoliaProvider|sepoliaRpcUrl)\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/utils\/rpc["']/);
  });
  test(`${f} does not build its own JsonRpcProvider`, () => {
    assert.ok(!source(f).includes("new ethers.JsonRpcProvider("));
  });
}

console.log(`\n${passed} passed`);
