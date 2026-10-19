// ─── Local storage — persistence tests (temp files only) ───
// Run with `npm run test:storage`.

import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LocalStorage } from "./memoryStorage";
import { loadIndexFile } from "./storage";

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

test("a missing file is a first run: starts empty", async () => {
  const none = path.join(dir, "first-run", "storage.json");
  assert.equal(await new LocalStorage(none).read("k"), null);
  assert.equal(fs.existsSync(none), false, "nothing is written until something is saved");
  assert.equal(loadIndexFile(path.join(dir, "no-index.json")).size, 0);
});

// Unreadable storage must stop the bridge, and must leave the file exactly as it was.
const BAD_FILES: [string, string][] = [
  ["corrupt JSON", "{ not json"],
  ["an empty file", ""],
  ["the wrong shape (an object)", '{"a":1}'],
  ["the wrong shape (pairs with a non-string key)", "[[1,2]]"],
  ["the wrong shape (an entry that isn't a pair)", '[["a"]]'],
];
for (const [label, content] of BAD_FILES) {
  test(`${label}: refuses to start and leaves the file untouched`, async () => {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, content);
    assert.throws(() => new LocalStorage(bad), /Can't read .*Refusing to start so no data is overwritten/);
    assert.throws(() => loadIndexFile(bad), /Can't read .*Refusing to start/);
    assert.equal(fs.readFileSync(bad, "utf-8"), content);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("bad.json")), ["bad.json"], "no backup or rename");
  });
}

test("an index of non-string root hashes is refused (the local store keeps any value)", async () => {
  const idx = path.join(dir, "index.json");
  fs.writeFileSync(idx, '[["k",5]]');
  assert.throws(() => loadIndexFile(idx), /not a list of \[key, root hash\] pairs/);
  fs.writeFileSync(idx, '[["k","0xabc"]]');
  assert.deepEqual([...loadIndexFile(idx)], [["k", "0xabc"]]);
});

test("an unreadable path (a directory where the file should be): refuses to start", async () => {
  const asDir = path.join(dir, "is-a-dir.json");
  fs.mkdirSync(asDir);
  assert.throws(() => new LocalStorage(asDir), /Can't read .*Refusing to start/);
  assert.throws(() => loadIndexFile(asDir), /Can't read .*Refusing to start/);
  assert.ok(fs.statSync(asDir).isDirectory());
});

test("a file without read permission: refuses to start and leaves it untouched (skipped as root)", async () => {
  if (process.getuid?.() === 0) return; // root reads anything, so the test can't make the file unreadable
  const locked = path.join(dir, "locked.json");
  fs.writeFileSync(locked, '[["k",1]]', { mode: 0o000 });
  assert.throws(() => new LocalStorage(locked), /Can't read .*Refusing to start/);
  assert.throws(() => loadIndexFile(locked), /Can't read .*Refusing to start/);
  fs.chmodSync(locked, 0o600);
  assert.equal(fs.readFileSync(locked, "utf-8"), '[["k",1]]');
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
