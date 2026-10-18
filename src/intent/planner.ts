// ─── Intent — planner ───
// One LLM call per message: conversation → validated PlannerOutput. Invalid JSON
// or a schema violation gets exactly one repair retry with the concrete errors;
// if that fails too, the user is asked to rephrase. Nothing unvalidated escapes.

import { complete, defaultModel, defaultProvider, LlmError, type ChatMessage, type LlmProvider } from "../integrations/llm";
import { PlannerOutput, formatIssues, type PlannerOutputT } from "./schema";
import { PLANNER_SYSTEM_PROMPT } from "./prompt";

export interface PlanOptions {
  provider?: LlmProvider;
  model?: string;
  timeoutMs?: number;
  /** Test seams: the model call and where the failure line goes. */
  completeFn?: typeof complete;
  log?: (line: string) => void;
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

/** How an LLM call failed, in words that can't echo the prompt or the provider's response body. */
export function llmErrorType(err: LlmError): string {
  if (err.invalidJson) return "json_rejected";
  if (err.status === null) return "timeout_or_network";
  if (err.status === 429) return "rate_limited";
  if (err.status === 529) return "overloaded";
  if (err.status >= 500) return "server_error";
  if (err.status === 401 || err.status === 403) return "auth_rejected";
  return "request_rejected";
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
  // Set while the latest model call failed at the transport/API level (not a bad answer).
  let apiError: LlmError | null = null;
  const run = opts.completeFn ?? complete;
  const provider = opts.provider ?? defaultProvider();

  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string;
    try {
      const res = await run({
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
      apiError = null;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      apiError = err;
      if (err.transient) {
        // Timeout / overload: retry the same request once.
        continue;
      }
      // Auth or a malformed request won't improve on retry; the user gets the friendly fallback.
      if (!err.invalidJson) break;
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

  // One line per exhausted request. Only status, type and names: never the prompt, the
  // user's message, headers or the provider's response body, which can echo them.
  const failure = apiError as LlmError | null;
  (opts.log ?? console.error)(
    `[planner] LLM failed: provider=${provider} model=${model || opts.model || defaultModel(provider)} step=planner ` +
      (failure ? `status=${failure.status ?? "none"} type=${llmErrorType(failure)}` : `type=invalid_output attempts=${raw.length}`)
  );

  return {
    output: {
      type: "clarify",
      question: failure
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
