// ─── Utils — a real bridge for log and error tests (test helper) ───
// Starts serve.ts on a free port with the language model replayed from a cache (no network access
// to the model, no API key, no .env: see testEnv.ts), captures its output and posts to /intent.
// Used by the test:* scripts.

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { cacheKeyFor } from "../integrations/llm";
import { PLANNER_SYSTEM_PROMPT } from "../intent/prompt";
import { _setSecret } from "../auth";
import { isolatedEnv } from "./testEnv";

export const SECRET = "log-privacy-test-secret-0123456789abcdef";
_setSecret(SECRET);

export const MODEL = "test-model";
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

/** Stores the model's answer for this exact message, as the planner will ask for it. */
export function replay(message: string, answer: unknown): void {
  const key = cacheKeyFor("groq", MODEL, { system: PLANNER_SYSTEM_PROMPT, messages: [{ role: "user", content: message }], json: true, temperature: 0, maxTokens: 800 });
  fs.writeFileSync(path.join(CACHE, `${key}.json`), JSON.stringify({ text: JSON.stringify(answer), provider: "groq", model: MODEL, latencyMs: 7, waitedMs: 0 }));
}

export async function startBridge(env: Record<string, string>) {
  const port = await freePort();
  const out: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "src/integrations/ledger/serve.ts"], {
    env: isolatedEnv({
      STORAGE_BACKEND: "memory", TELEGRAM_BOT_TOKEN: "", PORT: String(port), SESSION_SECRET: SECRET,
      ALLOWED_ORIGINS: "", PUBLIC_APP_URL: "", ENABLE_MOCK_TRADE: "", NODE_ENV: "", LOG_USER_MESSAGES: "",
      LLM_CACHE_DIR: CACHE, LLM_CACHE_MODE: "replay", GROQ_MODEL: MODEL, LLM_PROVIDER: "groq", ...env,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => out.push(String(d)));
  child.stderr!.on("data", (d) => out.push(String(d)));
  for (let i = 0; i < 120; i++) {
    const up = await new Promise<boolean>((r) => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.end(); r(true); }); s.on("error", () => r(false)); });
    if (up) return { child, port, log: () => out.join("") };
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("bridge did not start");
}

export function post(port: number, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/intent", method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data || "{}") }));
    });
    req.on("error", reject); req.write(JSON.stringify(body)); req.end();
  });
}

