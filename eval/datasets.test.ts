// ─── Eval — offline checks on the labelled datasets (ORC-19) ───
// Run with `npm run test:eval-datasets`. No model and no network: this never runs the eval
// itself (that's `npm run eval`, run by hand). It checks the datasets are usable — every expected
// planner answer is valid against the planner schema, ids are unique, and every action the planner
// can return has enough cases — so a broken or lopsided case is caught before anyone pays for a run.

import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { PlannerOutput, Step } from "../src/intent/schema";

/** Each action needs at least this many parsing cases (paraphrases, typos, other languages). */
export const MIN_CASES_PER_ACTION = 5;

const PLANNER_TYPES = ["actions", "clarify", "reply", "unsupported"];
const RISK_OUTCOMES = ["AUTO_EXECUTE", "NEEDS_APPROVAL", "BLOCKED", "INFO", "NO_ACTION"];
/** Every action in the planner schema, read from the schema itself so a new one can't be forgotten. */
const ACTIONS: string[] = Step.options.map((o) => o.shape.action.value);

const load = (file: string): any[] =>
  fs.readFileSync(path.join(__dirname, "datasets", file), "utf-8")
    .split("\n")
    .map((l, i) => [l, i + 1] as const)
    .filter(([l]) => l.trim())
    .map(([l, line]) => {
      try { return JSON.parse(l); } catch (err: any) { throw new Error(`${file}:${line} is not valid JSON: ${err.message}`); }
    });

const parsing = load("parsing.jsonl");
const risk = load("risk.jsonl");
const expectations = (c: any): any[] => (Array.isArray(c.expect) ? c.expect : [c.expect]);

/** A non-action expectation only names its type; give it placeholder text so the schema can check the type. */
function asPlannerOutput(e: any): unknown {
  if (e.type === "actions") return e;
  const filler = { clarify: { question: "?" }, reply: { text: "." }, unsupported: { reason: "." } } as Record<string, object>;
  return { ...filler[e.type], ...e };
}

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("parsing: every case has an id, tags, a message and an expectation", () => {
  for (const c of parsing) {
    assert.equal(typeof c.id, "string", JSON.stringify(c));
    assert.ok(Array.isArray(c.tags) && c.tags.length > 0, `${c.id}: tags`);
    assert.ok(typeof c.message === "string" && c.message.trim(), `${c.id}: message`);
    assert.ok(expectations(c).length > 0, `${c.id}: expect`);
    if (c.history) for (const h of c.history) assert.ok(["user", "assistant"].includes(h.role) && typeof h.content === "string", `${c.id}: history`);
  }
});

test("parsing: ids are unique", () => {
  const seen = new Set<string>();
  for (const c of parsing) {
    assert.ok(!seen.has(c.id), `duplicate parsing id ${c.id}`);
    seen.add(c.id);
  }
});

test("parsing: every expected answer is valid against the planner schema", () => {
  for (const c of parsing) {
    for (const e of expectations(c)) {
      assert.ok(PLANNER_TYPES.includes(e.type), `${c.id}: unknown type ${e.type}`);
      const r = PlannerOutput.safeParse(asPlannerOutput(e));
      assert.ok(r.success, `${c.id}: ${r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      if (e.type === "actions") assert.ok(Array.isArray(e.steps) && e.steps.length > 0, `${c.id}: an actions answer lists its steps`);
    }
  }
});

test(`parsing: every planner action has at least ${MIN_CASES_PER_ACTION} cases`, () => {
  const counts = countByAction();
  const short = ACTIONS.filter((a) => (counts[a] ?? 0) < MIN_CASES_PER_ACTION).map((a) => `${a} (${counts[a] ?? 0})`);
  assert.deepEqual(short, [], `actions below ${MIN_CASES_PER_ACTION} cases: ${short.join(", ")}`);
});

test("parsing: requests in other languages, typos and unclear amounts are covered", () => {
  const tagged = (t: string) => parsing.filter((c) => c.tags.includes(t)).length;
  assert.ok(tagged("fr") >= 10, `fr: ${tagged("fr")}`);
  assert.ok(tagged("es") + tagged("de") >= 5, `es+de: ${tagged("es") + tagged("de")}`);
  assert.ok(tagged("typo") >= 10, `typo: ${tagged("typo")}`);
  assert.ok(tagged("unclear") >= 5, `unclear: ${tagged("unclear")}`);
});

test("risk: ids are unique and every case expects known outcomes", () => {
  const seen = new Set<string>();
  for (const c of risk) {
    assert.ok(!seen.has(c.id), `duplicate risk id ${c.id}`);
    seen.add(c.id);
    assert.ok(typeof c.message === "string" && c.message.trim(), `${c.id}: message`);
    assert.ok(Array.isArray(c.expect) && c.expect.length > 0, `${c.id}: expect`);
    for (const o of c.expect) assert.ok(RISK_OUTCOMES.includes(o), `${c.id}: unknown outcome ${o}`);
  }
});

test("risk: planned DeFi actions are expected to do nothing (never auto-execute or ask for approval)", () => {
  const planned = risk.filter((c) => c.tags.includes("planned"));
  assert.ok(planned.length >= 5, `planned: ${planned.length}`);
  for (const c of planned) assert.deepEqual(c.expect, ["NO_ACTION"], c.id);
});

/** Cases per action: a case counts once for each action that appears in any of its accepted answers. */
function countByAction(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of parsing) {
    const actions = new Set<string>();
    for (const e of expectations(c)) for (const s of e.steps ?? []) actions.add(s.action);
    for (const a of actions) counts[a] = (counts[a] ?? 0) + 1;
  }
  return counts;
}

console.log("eval datasets");
for (const [name, fn] of tests) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const counts = countByAction();
console.log(`  cases: parsing ${parsing.length}, risk ${risk.length}`);
console.log(`  per action: ${ACTIONS.map((a) => `${a} ${counts[a] ?? 0}`).join(", ")}`);
console.log(`\n${passed} passed`);
