// ─── Intent — planner ───
// One LLM call per message: conversation → validated PlannerOutput. Invalid JSON
// or a schema violation gets exactly one repair retry with the concrete errors;
// if that fails too, the user is asked to rephrase. Nothing unvalidated escapes.

import { complete, LlmError, type ChatMessage, type LlmProvider } from "../integrations/llm";
import { PlannerOutput, formatIssues, type PlannerOutputT } from "./schema";
import { PLANNER_SYSTEM_PROMPT } from "./prompt";

export interface PlanOptions {
  provider?: LlmProvider;
  model?: string;
  timeoutMs?: number;
}

export interface PlanResult {
  output: PlannerOutputT;
  /** Model calls made (1, or 2 when a repair retry was needed). */
  attempts: number;
  /** True when both attempts failed and `output` is the rephrase fallback. */
  failed: boolean;
  /** Wall-clock time, including any rate-limit waiting. */
  latencyMs: number;
  /** Time the model itself took, summed over attempts. */
  modelMs: number;
  waitedMs: number;
  model: string;
  raw: string[];
}

const MAX_HISTORY_TURNS = 8;
const MAX_TURN_CHARS = 600;

/** Keep the last few turns, alternating roles, starting with a user turn. */
export function sanitizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  const turns: ChatMessage[] = [];
  for (const h of history.slice(-MAX_HISTORY_TURNS)) {
    const role = h?.role === "assistant" ? "assistant" : h?.role === "user" ? "user" : null;
    const content = typeof h?.content === "string" ? h.content.trim().slice(0, MAX_TURN_CHARS) : "";
    if (!role || !content) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${content}`;
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  // The new message is appended as a user turn, so the history must end on assistant.
  while (turns.length && turns[turns.length - 1].role !== "assistant") turns.pop();
  return turns;
}

export async function planIntent(
  message: string,
  history: ChatMessage[] = [],
  opts: PlanOptions = {}
): Promise<PlanResult> {
  const started = Date.now();
  const messages: ChatMessage[] = [...history, { role: "user", content: message }];
  const raw: string[] = [];
  let model = opts.model ?? "";
  let modelMs = 0;
  let waitedMs = 0;
  let jsonMode = true;
  let unreachable = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string;
    try {
      const res = await complete({
        system: PLANNER_SYSTEM_PROMPT,
        messages,
        provider: opts.provider,
        model: opts.model,
        json: jsonMode,
        temperature: 0,
        maxTokens: 800,
        timeoutMs: opts.timeoutMs ?? 10_000,
      });
      model = res.model;
      modelMs += res.latencyMs;
      waitedMs += res.waitedMs;
      text = res.text;
      unreachable = false;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      if (err.transient) {
        // Timeout / overload: retry the same request once.
        unreachable = true;
        continue;
      }
      if (!err.invalidJson) throw err;
      // The provider's JSON mode rejected the output; retry without it and parse ourselves.
      jsonMode = false;
      text = "";
    }
    raw.push(text);

    const parsed = parseJson(text);
    const checked = parsed.ok ? PlannerOutput.safeParse(parsed.value) : null;
    if (checked?.success) {
      return { output: checked.data, attempts: attempt, failed: false, latencyMs: Date.now() - started, modelMs, waitedMs, model, raw };
    }

    const problems = checked ? formatIssues(checked.error) : `- not valid JSON: ${parsed.ok ? "" : parsed.error}`;
    messages.push(
      { role: "assistant", content: text || "(invalid JSON)" },
      { role: "user", content: `That reply was invalid:\n${problems}\nReply again with only the corrected JSON object.` }
    );
  }

  return {
    output: {
      type: "clarify",
      question: unreachable
        ? "I'm having trouble reaching the language model right now. Please try again in a moment."
        : "Sorry, I didn't quite get that. Could you rephrase it?",
    },
    attempts: 2,
    failed: true,
    latencyMs: Date.now() - started,
    modelMs,
    waitedMs,
    model,
    raw,
  };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let cleaned = text.trim().replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return { ok: true, value: JSON.parse(cleaned.slice(first, last + 1)) };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: "no JSON object found" };
  }
}
