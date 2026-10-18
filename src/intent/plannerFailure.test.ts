// ─── Intent — planner failure logging and fallback wording (injected fakes, no network) ───
// Run with `npm run test:planner-failure`. A failed model call must be logged once with
// provider/model/status/type and never with the user's message, the prompt or a key, and the
// user must see the friendly "trouble reaching" or "rephrase" message, never a raw error.

import assert from "node:assert/strict";
import { LlmError } from "../integrations/llm";
import { planIntent, llmErrorType } from "./planner";

const SECRET_MESSAGE = "send 5 USDC to my landlord, secret-memo-xyz";
const API_KEY = "gsk_test_key_should_never_appear";
process.env.GROQ_API_KEY = API_KEY;

const TROUBLE = /trouble reaching the language model/;
const REPHRASE = /didn't quite get that/;

const run = async (fake: (n: number) => Promise<any>, model = "test-model") => {
  const lines: string[] = [];
  let n = 0;
  const res = await planIntent(SECRET_MESSAGE, [], {
    provider: "groq",
    model,
    log: (l) => lines.push(l),
    completeFn: async () => fake(++n),
  });
  return { res, lines, calls: n };
};
const ok = (text: string) => ({ text, provider: "groq", model: "test-model", latencyMs: 1, waitedMs: 0 });
const quiet = (lines: string[]) => {
  const all = lines.join("\n");
  assert.ok(!all.includes("secret-memo-xyz") && !all.includes(SECRET_MESSAGE) && !all.includes(API_KEY), all);
  assert.ok(!/Bearer|You turn a user/i.test(all), all);
};

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("a model that times out twice is logged once and the user gets the 'trouble reaching' message", async () => {
  const { res, lines, calls } = await run(async () => { throw new LlmError("LLM request timed out after 10000ms", null); });
  assert.equal(calls, 2);
  assert.equal(res.failed, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /provider=groq/);
  assert.match(lines[0], /model=test-model/);
  assert.match(lines[0], /step=planner/);
  assert.match(lines[0], /status=none type=timeout_or_network/);
  assert.equal(res.output.type, "clarify");
  assert.match((res.output as any).question, TROUBLE);
  quiet(lines);
});

test("a 503 whose body echoes the prompt is logged by status only", async () => {
  const body = `server said: ${SECRET_MESSAGE} ${API_KEY}`;
  const { res, lines } = await run(async () => { throw new LlmError(`LLM request failed (503): ${body}`, 503, body); });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /status=503 type=server_error/);
  assert.match((res.output as any).question, TROUBLE);
  quiet(lines);
});

test("a rejected key (401) is not retried, is logged, and does not leak as an error", async () => {
  const { res, lines, calls } = await run(async () => { throw new LlmError(`LLM request failed (401): ${API_KEY}`, 401, API_KEY); });
  assert.equal(calls, 1);
  assert.equal(res.failed, true);
  assert.match(lines[0], /status=401 type=auth_rejected/);
  assert.match((res.output as any).question, TROUBLE);
  quiet(lines);
});

test("Groq JSON-mode rejection twice counts as an API failure, not a misunderstanding", async () => {
  const { res, lines } = await run(async () => { throw new LlmError("bad", 400, "json_validate_failed"); });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /type=json_rejected/);
  assert.match((res.output as any).question, TROUBLE);
});

test("invalid JSON twice is a real misunderstanding: logged as invalid_output, user is asked to rephrase", async () => {
  const { res, lines, calls } = await run(async () => ok("this is not json"));
  assert.equal(calls, 2);
  assert.equal(res.failed, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /type=invalid_output attempts=2/);
  assert.match((res.output as any).question, REPHRASE);
  quiet(lines);
});

test("a schema violation twice (valid JSON, wrong shape) also asks to rephrase", async () => {
  const { res, lines } = await run(async () => ok('{"type":"actions","steps":[]}'));
  assert.match(lines[0], /invalid_output/);
  assert.match((res.output as any).question, REPHRASE);
});

test("a timeout followed by a bad answer is a misunderstanding, not a transport failure", async () => {
  const { res, lines } = await run(async (n) => {
    if (n === 1) throw new LlmError("LLM request timed out", null);
    return ok("nope");
  });
  assert.match(lines[0], /invalid_output/);
  assert.match((res.output as any).question, REPHRASE);
});

test("a retry that works logs nothing", async () => {
  const { res, lines } = await run(async (n) => {
    if (n === 1) throw new LlmError("overloaded", 529);
    return ok('{"type":"reply","text":"hi"}');
  });
  assert.equal(res.failed, false);
  assert.equal(lines.length, 0);
});

test("error types are named without the response body", () => {
  assert.equal(llmErrorType(new LlmError("x", 429)), "rate_limited");
  assert.equal(llmErrorType(new LlmError("x", 529)), "overloaded");
  assert.equal(llmErrorType(new LlmError("x", 400, "oops")), "request_rejected");
});

(async () => {
  console.log("planner failure");
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
