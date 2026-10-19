// ─── Intent — what the user reads when something breaks, and what the log keeps ───
// An unexpected (non-AI) failure inside /intent answers with a plain sentence and logs the detail
// without user data; a failed planner names its model; nothing technical reaches the user.
// Real bridge, language model replayed from a cache. Run with `npm run test:intent-errors`.

import assert from "node:assert/strict";
import { LlmError } from "../integrations/llm";
import { planIntent } from "./planner";
import { INTENT_FALLBACK_ERROR } from "./messages";
import { startBridge, post, wait } from "../utils/testBridge";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("a failed planner reports its model, even when no call ever succeeded", async () => {
  const lines: string[] = [];
  const res = await planIntent("anything", [], {
    provider: "groq", model: "test-model", log: (l) => lines.push(l),
    completeFn: async () => { throw new LlmError("down", 503); },
  });
  assert.equal(res.failed, true);
  assert.equal(res.model, "test-model");
  const noModel = await planIntent("anything", [], {
    provider: "groq", log: () => {}, completeFn: async () => { throw new LlmError("down", 503); },
  });
  assert.ok(noModel.model.length > 0, "the provider's default model, never empty");
  assert.match(lines[0], /model=test-model/);
});

test("the fallback sentence is plain: no codes, no error names, nothing about keys or settings", () => {
  assert.ok(!/GS0|revert|nonce|gas|api key|undefined|error:/i.test(INTENT_FALLBACK_ERROR), INTENT_FALLBACK_ERROR);
});

test("a non-AI failure in /intent shows the plain sentence, never err.message, and logs the detail", async () => {
  // The cache is empty and in replay mode, so the model call throws a plain Error (not an LlmError):
  // a failure that isn't the AI answering badly.
  const bridge = await startBridge({});
  try {
    const res = await post(bridge.port, { message: "never-replayed secretword question" });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, INTENT_FALLBACK_ERROR);
    assert.ok(!/cache|replay|groq|key/i.test(res.body.error), res.body.error);
    await wait(300);
    const log = bridge.log();
    assert.match(log, /\[intent [0-9a-f]{6}\] Pipeline error: Error: LLM cache miss in replay mode \(groq\/test-model\)/);
    assert.match(log, /outcome=failed\(500\)/);
    assert.ok(!log.includes("secretword"), log);
  } finally { bridge.child.kill(); }
});

(async () => {
  console.log("intent errors");
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
