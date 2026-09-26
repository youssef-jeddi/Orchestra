// ─── LLM — provider-agnostic chat completion ───
// One `complete()` call for every model backend the agents use. Groq is the
// default; Anthropic (Claude) is selected with LLM_PROVIDER=anthropic.
//
// Env:
//   LLM_PROVIDER      groq | anthropic               (default groq)
//   GROQ_MODEL        default qwen/qwen3.8-27b (fastest at equal accuracy in eval/)
//   ANTHROPIC_MODEL   default claude-haiku-4-5
//   LLM_CACHE_DIR     if set, responses are cached on disk (used by eval/)
//   LLM_CACHE_MODE    "replay" → fail on cache miss instead of calling the API

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type LlmProvider = "groq" | "anthropic";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  system: string;
  messages: ChatMessage[];
  provider?: LlmProvider;
  model?: string;
  /** Ask the backend for a JSON object (Groq json_object mode). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CompleteResult {
  text: string;
  provider: LlmProvider;
  model: string;
  /** Time spent on the request that succeeded (excludes rate-limit waits). */
  latencyMs: number;
  /** Time spent waiting out 429s before it. */
  waitedMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  cached?: boolean;
}

export class LlmError extends Error {
  constructor(message: string, public status: number | null, public body = "") {
    super(message);
  }
  /** Transient: worth one retry (timeouts, overload, 5xx, exhausted rate-limit budget). */
  get transient(): boolean {
    return this.status === null || this.status === 429 || this.status === 529 || this.status >= 500;
  }
  /** The provider's JSON mode rejected the model's output (Groq json_validate_failed). */
  get invalidJson(): boolean {
    return this.status === 400 && /json_validate_failed|Failed to validate JSON/i.test(this.body);
  }
}

export const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_RATE_LIMIT_RETRIES = 10;

export function defaultProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === "anthropic" ? "anthropic" : "groq";
}

export function defaultModel(provider: LlmProvider = defaultProvider()): string {
  return provider === "anthropic"
    ? process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL
    : process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
}

/** Running totals across all calls — lets the eval attribute model time to a case. */
export const llmStats = { calls: 0, latencyMs: 0, waitedMs: 0 };

export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  const provider = opts.provider ?? defaultProvider();
  const model = opts.model ?? defaultModel(provider);

  const cacheKey = cacheKeyFor(provider, model, opts);
  const hit = readCache(cacheKey);
  if (hit) {
    record(hit.latencyMs, 0);
    return { ...hit, waitedMs: 0, cached: true };
  }
  if (process.env.LLM_CACHE_DIR && process.env.LLM_CACHE_MODE === "replay") {
    throw new Error(`LLM cache miss in replay mode (${provider}/${model})`);
  }

  const result = provider === "anthropic"
    ? await completeAnthropic(model, opts)
    : await completeGroq(model, opts);

  record(result.latencyMs, result.waitedMs);
  writeCache(cacheKey, result);
  return result;
}

function record(latencyMs: number, waitedMs: number): void {
  llmStats.calls++;
  llmStats.latencyMs += latencyMs;
  llmStats.waitedMs += waitedMs;
}

// ── Groq (OpenAI-compatible) ──
async function completeGroq(model: string, opts: CompleteOptions): Promise<CompleteResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: opts.system }, ...opts.messages],
    max_tokens: opts.maxTokens ?? 1024,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.json) body.response_format = { type: "json_object" };
  // Reasoning models: keep the hidden chain of thought short — this is extraction, not maths.
  if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  if (model.startsWith("qwen/qwen3")) body.reasoning_effort = "none";

  const { data, latencyMs, waitedMs } = await postWithRetry(GROQ_URL, {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }, body, opts.timeoutMs);

  return {
    text: data?.choices?.[0]?.message?.content ?? "",
    provider: "groq",
    model,
    latencyMs,
    waitedMs,
    usage: { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens },
  };
}

// ── Anthropic (Claude) ──
async function completeAnthropic(model: string, opts: CompleteOptions): Promise<CompleteResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const body: Record<string, unknown> = {
    model,
    system: opts.system,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1024,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;

  const { data, latencyMs, waitedMs } = await postWithRetry(ANTHROPIC_URL, {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }, body, opts.timeoutMs);

  const text = Array.isArray(data?.content)
    ? data.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("")
    : "";
  return {
    text,
    provider: "anthropic",
    model,
    latencyMs,
    waitedMs,
    usage: { inputTokens: data?.usage?.input_tokens, outputTokens: data?.usage?.output_tokens },
  };
}

// ── HTTP with timeout + rate-limit backoff ──
async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<{ data: any; latencyMs: number; waitedMs: number }> {
  // Interactive requests give up after ~20s of rate-limit waiting; the eval raises this.
  const waitBudgetMs = Number(process.env.LLM_MAX_WAIT_MS) || 20_000;
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (err: any) {
      if (err?.name === "AbortError") throw new LlmError(`LLM request timed out after ${timeoutMs}ms`, null);
      throw new LlmError(`LLM request failed: ${err?.message ?? err}`, null);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 || res.status === 529) {
      const waitMs = retryAfterMs(res) ?? Math.min(2 ** attempt * 1000, 30_000);
      if (attempt < MAX_RATE_LIMIT_RETRIES && waitedMs + waitMs <= waitBudgetMs) {
        await res.text().catch(() => {});
        await new Promise((r) => setTimeout(r, waitMs));
        waitedMs += waitMs;
        continue;
      }
    }
    if (!res.ok) {
      const text = await res.text();
      throw new LlmError(`LLM request failed (${res.status}): ${text.slice(0, 500)}`, res.status, text);
    }
    const data = await res.json();
    return { data, latencyMs: Date.now() - started, waitedMs };
  }
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) + 250 : null;
}

// ── Disk cache (eval only) ──
function cacheKeyFor(provider: string, model: string, opts: CompleteOptions): string {
  const payload = JSON.stringify([provider, model, opts.system, opts.messages, opts.json, opts.temperature, opts.maxTokens]);
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function readCache(key: string): CompleteResult | null {
  const dir = process.env.LLM_CACHE_DIR;
  if (!dir) return null;
  const file = path.join(dir, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeCache(key: string, result: CompleteResult): void {
  const dir = process.env.LLM_CACHE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(result));
}
