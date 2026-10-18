// ─── Local storage — persistence tests (temp files only) ───
// Run with `npm run test:storage`.

import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LocalStorage } from "./memoryStorage";

console.log = ((orig) => (...a: unknown[]) => { if (!String(a[0]).startsWith("[LocalStorage]")) orig(...a); })(console.log);
console.warn = () => {};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-storage-"));
const file = path.join(dir, "nested", "storage.json");

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("survives a restart: a new instance reads what the old one wrote", async () => {
  const a = new LocalStorage(file);
  await a.write("telegram:0xabc", { chatId: 42 });
  await a.append("activity:0xabc", { valueUsd: 5 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const b = new LocalStorage(file); // "restart"
  assert.deepEqual(await b.read("telegram:0xabc"), { chatId: 42 });
  assert.deepEqual(await b.readMany("activity:0xabc"), [{ valueUsd: 5 }]);
});

test("deletes and clears are persisted too", async () => {
  const a = new LocalStorage(file);
  await a.delete("telegram:0xabc");
  assert.equal(await new LocalStorage(file).read("telegram:0xabc"), null);
  await a.clear();
  assert.deepEqual(await new LocalStorage(file).readMany("activity:0xabc"), []);
});

test("returns copies: mutating a read value doesn't change the store", async () => {
  const a = new LocalStorage(file);
  await a.write("k", { n: 1 });
  const v = (await a.read("k")) as { n: number };
  v.n = 2;
  assert.deepEqual(await a.read("k"), { n: 1 });
});

test("an unreadable file is set aside, not overwritten", async () => {
  fs.writeFileSync(file, "{ not json");
  const a = new LocalStorage(file);
  assert.equal(await a.read("k"), null);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith("storage.json.unreadable-")));
});

test("memory mode (no file) writes nothing to disk", async () => {
  const before = fs.readdirSync(path.dirname(file)).length;
  const m = new LocalStorage(null);
  await m.write("k", 1);
  assert.equal(await m.read("k"), 1);
  assert.equal(fs.readdirSync(path.dirname(file)).length, before);
});

(async () => {
  console.log("storage");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
