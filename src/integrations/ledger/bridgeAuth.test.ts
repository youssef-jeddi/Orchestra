// ─── Bridge — session, ownership and origin tests ───
// The origin allowlist and the "is this address yours" rule as pure functions, then the real
// bridge (serve.ts started on a free port, no network needed: every request here is answered
// before any chain or API call): routes that need a session refuse without one, another user's
// address is refused, a website that isn't allowed gets 403 over HTTP and on the WebSocket
// upgrade, and /mock-trade is absent unless a local dev bridge opts in.
// Run with `npm run test:bridge-auth`.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import { isOriginAllowed, originPermitted, parseAllowedOrigins, mockTradeEnabled, DEFAULT_ALLOWED_ORIGINS } from "./origins";
import { isOwnAddress } from "./access";
import { issueToken, _setSecret } from "../../auth";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const SECRET = "bridge-auth-test-secret-0123456789abcdef";
_setSecret(SECRET);
const ALICE = "0x00000000000000000000000000000000000A11CE";
const BOB = "0x0000000000000000000000000000000000000B0B";
const ALICE_SAFE = "0x00000000000000000000000000000000005AFE01";
const PREVIEW = "https://orchestra-git-fix-setup-recov-6b8d8b-youssefs-projects-822ed3d0.vercel.app";

const ENV_KEYS = ["ALLOWED_ORIGINS", "PUBLIC_APP_URL", "ENABLE_MOCK_TRADE", "NODE_ENV"] as const;
function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// ── The origin allowlist (pure) ──

test("default allowlist: the production site, its subdomains, localhost on any port, this project's previews", () => {
  withEnv({}, () => {
    for (const ok of [
      "https://getorchestra.xyz", "https://app.getorchestra.xyz", "https://a.b.getorchestra.xyz",
      "http://localhost:3000", "http://localhost:3011", "http://localhost", "http://127.0.0.1:3000",
      PREVIEW, "https://orchestra-q7h8rnuv4-youssefs-projects-822ed3d0.vercel.app",
    ]) assert.equal(isOriginAllowed(ok), true, ok);
  });
});

test("attack: lookalike and unlisted origins are refused", () => {
  withEnv({}, () => {
    for (const bad of [
      "https://getorchestra.xyz.evil.com", "https://evilgetorchestra.xyz", "https://evil.com/getorchestra.xyz",
      "https://getorchestra.xyz@evil.com", "https://evil.com#.getorchestra.xyz", "https://xgetorchestra.xyz",
      "http://getorchestra.xyz", "http://app.getorchestra.xyz", "https://localhost:3000", "http://localhost.evil.com:3000",
      "http://evillocalhost:3000", "http://127.0.0.1.evil.com", "https://evil.com", "null", "", "file://",
      "https://something-else.vercel.app", "https://orchestra-x-otherteam.vercel.app",
      "https://evil.vercel.app", "https://orchestra--youssefs-projects-822ed3d0.vercel.app",
      "http://orchestra-x-youssefs-projects-822ed3d0.vercel.app",
      "https://orchestra-x-youssefs-projects-822ed3d0.vercel.app.evil.com",
      "https://evil.com/orchestra-x-youssefs-projects-822ed3d0.vercel.app",
      "https://getorchestra.xyz:8443", "https://GETORCHESTRA.xyz.evil.com",
    ]) assert.equal(isOriginAllowed(bad), false, bad);
  });
});

test("ALLOWED_ORIGINS replaces the defaults; exact entries, wildcards and ports are strict", () => {
  withEnv({ ALLOWED_ORIGINS: "https://one.example.com, https://*.two.example.com,http://localhost:4000" }, () => {
    assert.equal(isOriginAllowed("https://one.example.com"), true);
    assert.equal(isOriginAllowed("https://a.two.example.com"), true);
    assert.equal(isOriginAllowed("http://localhost:4000"), true);
    assert.equal(isOriginAllowed("http://localhost:3000"), false, "a port that isn't listed");
    assert.equal(isOriginAllowed("https://two.example.com"), false, "*. needs a subdomain");
    assert.equal(isOriginAllowed("https://one.example.com.evil.com"), false);
    assert.equal(isOriginAllowed("https://getorchestra.xyz"), false, "defaults no longer apply");
  });
});

test("PUBLIC_APP_URL's origin is allowed too (the phone pages), even when the list is replaced", () => {
  withEnv({ PUBLIC_APP_URL: "https://demo.trycloudflare.com/some/path", ALLOWED_ORIGINS: "https://one.example.com" }, () => {
    assert.equal(isOriginAllowed("https://demo.trycloudflare.com"), true);
    assert.equal(isOriginAllowed("https://other.trycloudflare.com"), false);
  });
  withEnv({}, () => assert.equal(isOriginAllowed("https://demo.trycloudflare.com"), false));
});

test("invalid ALLOWED_ORIGINS entries are dropped, never widened", () => {
  const rules = parseAllowedOrigins("https://ok.example.com, *, https://*, evil.com, ftp://x.com, https://a..b.com, https://x.com/path");
  assert.equal(rules.length, 1);
  withEnv({ ALLOWED_ORIGINS: "*" }, () => assert.equal(isOriginAllowed("https://anything.com"), false));
});

test("a missing Origin is not refused by the origin check; a bad one is", () => {
  withEnv({}, () => {
    assert.equal(originPermitted(undefined), true);
    assert.equal(originPermitted("https://evil.com"), false);
    assert.equal(originPermitted("https://app.getorchestra.xyz"), true);
  });
  assert.ok(DEFAULT_ALLOWED_ORIGINS.includes("getorchestra.xyz"));
});

test("/mock-trade: off by default, on only with the opt-in, never in production mode", () => {
  withEnv({}, () => assert.equal(mockTradeEnabled(), false));
  withEnv({ ENABLE_MOCK_TRADE: "1" }, () => assert.equal(mockTradeEnabled(), true));
  withEnv({ ENABLE_MOCK_TRADE: "1", NODE_ENV: "production" }, () => assert.equal(mockTradeEnabled(), false));
  withEnv({ ENABLE_MOCK_TRADE: "true" }, () => assert.equal(mockTradeEnabled(), false));
});

// ── Whose address (pure) ──

test("an address is yours if it is your wallet or your own account; nobody else's", async () => {
  const safeOf = async (w: string) => (w.toLowerCase() === ALICE.toLowerCase() ? ALICE_SAFE : null);
  assert.equal(await isOwnAddress(ALICE, ALICE, safeOf), true);
  assert.equal(await isOwnAddress(ALICE.toLowerCase(), ALICE, safeOf), true);
  assert.equal(await isOwnAddress(ALICE, ALICE_SAFE, safeOf), true);
  assert.equal(await isOwnAddress(ALICE, BOB, safeOf), false);
  assert.equal(await isOwnAddress(BOB, ALICE_SAFE, safeOf), false, "another user's account");
  assert.equal(await isOwnAddress(BOB, ALICE, safeOf), false);
  assert.equal(await isOwnAddress(ALICE, "not an address", safeOf), false);
  assert.equal(await isOwnAddress(ALICE, undefined, safeOf), false);
});

// ── The real bridge ──

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

let child: ChildProcess;
let port = 0;
async function startBridge(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  const p = await freePort();
  const c = spawn(process.execPath, ["--import", "tsx", "src/integrations/ledger/serve.ts"], { // node directly: kill() reaches the bridge itself, no wrapper left behind
    env: {
      ...process.env, STORAGE_BACKEND: "memory", TELEGRAM_BOT_TOKEN: "", PORT: String(p), SESSION_SECRET: SECRET,
      ALLOWED_ORIGINS: "", PUBLIC_APP_URL: "", ENABLE_MOCK_TRADE: "", NODE_ENV: "", ...env,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    const up = await new Promise<boolean>((r) => {
      const sock = net.connect(p, "127.0.0.1");
      sock.on("connect", () => { sock.end(); r(true); });
      sock.on("error", () => r(false));
    });
    if (up) return { child: c, port: p };
    await new Promise((r) => setTimeout(r, 500));
  }
  c.kill();
  throw new Error("bridge did not start");
}

interface Res { status: number; headers: http.IncomingHttpHeaders; body: any }
function call(method: string, path: string, opts: { origin?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => { let body: any = data; try { body = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode!, headers: res.headers, body }); });
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function wsConnect(origin?: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode!); res.resume(); });
    ws.on("error", () => {});
  });
}

const alice = () => issueToken(ALICE).token;
const bob = () => issueToken(BOB).token;

const GATED: [string, string, unknown?][] = [
  ["POST", "/quote", { walletAddress: ALICE, amount: "1" }],
  ["POST", "/swap", { quote: {}, routing: "CLASSIC" }],
  ["POST", "/broadcast", { signedTx: "0x00" }],
  ["GET", `/nonce/${ALICE}`],
  ["GET", "/check-safe"],
  ["GET", "/safe-balances"],
];

test("attack: no session → 401 on every route that used to be open", async () => {
  for (const [m, p, body] of GATED) {
    const r = await call(m, p, { body });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.body.code, "session_required");
    const forged = await call(m, p, { body, token: "abc.def" });
    assert.equal(forged.status, 401, `${m} ${p} with a forged token`);
  }
});

test("attack: another user's address is refused with 403 (not swapped for the session's)", async () => {
  const withBob = [
    call("POST", "/quote", { token: bob(), body: { walletAddress: ALICE, amount: "1" } }),
    call("GET", `/nonce/${ALICE}`, { token: bob() }),
    call("GET", `/check-safe?address=${ALICE}`, { token: bob() }),
    call("GET", `/safe-balances?address=${ALICE}`, { token: bob() }),
    call("GET", `/safe-balances?address=${ALICE_SAFE}`, { token: bob() }),
  ];
  for (const r of await Promise.all(withBob)) {
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "not_your_address");
  }
  assert.equal((await call("GET", "/nonce/not-an-address", { token: alice() })).status, 400);
});

test("a session passes the gate on its own routes (answered 400 for the missing body, before any network)", async () => {
  assert.equal((await call("POST", "/swap", { token: alice(), body: {} })).status, 400);
  assert.equal((await call("POST", "/broadcast", { token: alice(), body: {} })).status, 400);
  assert.equal((await call("POST", "/quote", { token: alice(), body: { walletAddress: ALICE } })).status, 400);
  assert.equal((await call("GET", "/safe-balances", { token: alice() })).status, 400, "no account yet, nothing to read");
});

test("/health stays public", async () => {
  const r = await call("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
});

test("attack: a website that isn't allowed gets 403 and no CORS header, on GET, POST and the preflight", async () => {
  for (const origin of [
    "https://evil.com", "https://getorchestra.xyz.evil.com", "https://evilgetorchestra.xyz",
    "https://something-else.vercel.app", "null",
  ]) {
    for (const [m, p] of [["GET", "/health"], ["POST", "/intent"], ["OPTIONS", "/intent"]] as const) {
      const r = await call(m, p, { origin, token: alice(), body: m === "POST" ? { message: "hi" } : undefined });
      assert.equal(r.status, 403, `${m} ${p} from ${origin}`);
      assert.equal(r.headers["access-control-allow-origin"], undefined, `${origin} must not get a CORS header`);
      if (m !== "OPTIONS") assert.equal(r.body.code, "origin_not_allowed");
    }
  }
});

test("allowed websites work and get their own origin back (never *)", async () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "https://getorchestra.xyz", "https://app.getorchestra.xyz", PREVIEW]) {
    const r = await call("GET", "/health", { origin });
    assert.equal(r.status, 200, origin);
    assert.equal(r.headers["access-control-allow-origin"], origin);
    assert.match(String(r.headers.vary), /Origin/);
    const pre = await call("OPTIONS", "/intent", { origin, headers: { "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204, `preflight from ${origin}`);
    assert.equal(pre.headers["access-control-allow-origin"], origin);
    assert.match(String(pre.headers["access-control-allow-headers"]), /Authorization/);
  }
  const noOrigin = await call("GET", "/health");
  assert.equal(noOrigin.headers["access-control-allow-origin"], undefined);
});

test("WebSocket: a disallowed origin is rejected at the upgrade; allowed or no origin connects", async () => {
  assert.equal(await wsConnect("https://evil.com"), 403);
  assert.equal(await wsConnect("https://getorchestra.xyz.evil.com"), 403);
  assert.equal(await wsConnect("https://something-else.vercel.app"), 403);
  assert.equal(await wsConnect("http://localhost:3000"), "open");
  assert.equal(await wsConnect("https://app.getorchestra.xyz"), "open");
  assert.equal(await wsConnect(PREVIEW), "open");
  assert.equal(await wsConnect(), "open");
});

test("attack: /mock-trade is absent (404) by default and in production mode, even with the opt-in", async () => {
  assert.equal((await call("POST", "/mock-trade", { body: {} })).status, 404);
  const prod = await startBridge({ ENABLE_MOCK_TRADE: "1", NODE_ENV: "production" });
  const keep = port;
  port = prod.port;
  try { assert.equal((await call("POST", "/mock-trade", { body: {} })).status, 404); }
  finally { port = keep; prod.child.kill(); }
});

test("/mock-trade works on a local dev bridge that opts in; ALLOWED_ORIGINS and PUBLIC_APP_URL are honoured by the real server", async () => {
  const dev = await startBridge({ ENABLE_MOCK_TRADE: "1", ALLOWED_ORIGINS: "https://only.example.com", PUBLIC_APP_URL: "https://phone.example.com" });
  const keep = port;
  port = dev.port;
  try {
    assert.equal((await call("POST", "/mock-trade", { body: {} })).status, 200);
    assert.equal((await call("GET", "/health", { origin: "https://only.example.com" })).status, 200);
    assert.equal((await call("GET", "/health", { origin: "https://phone.example.com" })).status, 200);
    assert.equal((await call("GET", "/health", { origin: "https://getorchestra.xyz" })).status, 403, "defaults are replaced");
    assert.equal(await wsConnect("https://getorchestra.xyz"), 403);
  } finally { port = keep; dev.child.kill(); }
});

(async () => {
  const b = await startBridge({});
  child = b.child;
  port = b.port;
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err: any) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
  }
  child.kill();
  console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
  process.exit(failed ? 1 : 0);
})();
