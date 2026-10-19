// ─── Bridge — session, ownership and origin tests ───
// The origin allowlist and the "is this address yours" rule as pure functions, then the real
// bridge (serve.ts started on a free port, no network needed: every request here is answered
// before any chain or API call): routes that need a session refuse without one, another user's
// address is refused, a website that isn't allowed gets 403 over HTTP and on the WebSocket
// upgrade, and /mock-trade is absent unless a local dev bridge opts in.
// The WebSocket: sign-in is the first message, approvals reach (and are answered by) only their owner.
// Run with `npm run test:bridge-auth`.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import { isOriginAllowed, originPermitted, wsOriginPermitted, parseAllowedOrigins, assertOriginConfig, mockTradeEnabled, DEFAULT_ALLOWED_ORIGINS } from "./origins";
import { ethers } from "ethers";
import { isOwnAddress, approvalBelongsTo, broadcastSenderProblem } from "./access";
import { issueToken, verifyToken, _setSecret } from "../../auth";
import { BridgeServer } from "./bridge";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const SECRET = "bridge-auth-test-secret-0123456789abcdef";
_setSecret(SECRET);
const ALICE = "0x00000000000000000000000000000000000A11CE";
const BOB = "0x0000000000000000000000000000000000000B0B";
const ALICE_SAFE = "0x00000000000000000000000000000000005AFE01";
// An example deployment list (nothing like it is built in): a production site with subdomains,
// local dev, and a Vercel preview pattern. Tests that need those origins set it explicitly.
const TEST_ORIGINS = "https://getorchestra.xyz,https://*.getorchestra.xyz,http://localhost:*,http://127.0.0.1:*,https://orchestra-*-youssefs-projects-822ed3d0.vercel.app";
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

test("default (ALLOWED_ORIGINS unset, not production): localhost on any port only — no domain or preview is built in", () => {
  withEnv({}, () => {
    for (const ok of ["http://localhost:3000", "http://localhost:3011", "http://localhost", "http://127.0.0.1:3000"]) {
      assert.equal(isOriginAllowed(ok), true, ok);
    }
    for (const bad of [
      "https://getorchestra.xyz", "https://app.getorchestra.xyz", PREVIEW,
      "https://orchestra-q7h8rnuv4-youssefs-projects-822ed3d0.vercel.app", "https://localhost:3000", "https://evil.com",
    ]) assert.equal(isOriginAllowed(bad), false, `${bad} must come from ALLOWED_ORIGINS`);
  });
  assert.equal(DEFAULT_ALLOWED_ORIGINS, "http://localhost:*,http://127.0.0.1:*");
});

test("an origin is allowed only when ALLOWED_ORIGINS lists it: sites, subdomains and the preview pattern", () => {
  withEnv({ ALLOWED_ORIGINS: TEST_ORIGINS }, () => {
    for (const ok of [
      "https://getorchestra.xyz", "https://app.getorchestra.xyz", "https://a.b.getorchestra.xyz",
      "http://localhost:3000", PREVIEW, "https://orchestra-q7h8rnuv4-youssefs-projects-822ed3d0.vercel.app",
    ]) assert.equal(isOriginAllowed(ok), true, ok);
  });
  withEnv({ ALLOWED_ORIGINS: "https://orchestra-*-newteam.vercel.app" }, () => {
    assert.equal(isOriginAllowed("https://orchestra-abc12-newteam.vercel.app"), true);
    assert.equal(isOriginAllowed(PREVIEW), false, "the old team's previews are not allowed unless listed");
  });
});

test("attack: lookalike and unlisted origins are refused", () => {
  withEnv({ ALLOWED_ORIGINS: TEST_ORIGINS }, () => {
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
    assert.equal(isOriginAllowed("http://127.0.0.1:3000"), false, "the local default no longer applies");
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

test("a missing Origin is not refused on plain HTTP; a bad one is; a WebSocket upgrade needs an allowed one", () => {
  withEnv({ ALLOWED_ORIGINS: TEST_ORIGINS }, () => {
    assert.equal(originPermitted(undefined), true);
    assert.equal(originPermitted("https://evil.com"), false);
    assert.equal(originPermitted("https://app.getorchestra.xyz"), true);
    assert.equal(wsOriginPermitted(undefined), false, "no Origin on a WebSocket upgrade");
    assert.equal(wsOriginPermitted("https://evil.com"), false);
    assert.equal(wsOriginPermitted("https://app.getorchestra.xyz"), true);
  });
});

// ── Production: the allowlist must be explicit ──

test("attack: in production an unset, empty or all-invalid ALLOWED_ORIGINS stops the bridge starting, and says what to set", () => {
  for (const ALLOWED_ORIGINS of [undefined, "", "   "]) {
    withEnv({ NODE_ENV: "production", ...(ALLOWED_ORIGINS === undefined ? {} : { ALLOWED_ORIGINS }) }, () => {
      assert.throws(() => assertOriginConfig(), /ALLOWED_ORIGINS must be set when NODE_ENV=production.*e\.g\. ALLOWED_ORIGINS=https:\/\/getorchestra\.xyz,https:\/\/www\.getorchestra\.xyz/);
    });
  }
  for (const ALLOWED_ORIGINS of ["*", "evil.com, ftp://x.com", "https://*"]) {
    withEnv({ NODE_ENV: "production", ALLOWED_ORIGINS }, () => {
      assert.throws(() => assertOriginConfig(), /None of the entries in ALLOWED_ORIGINS is a valid origin/);
    });
  }
  // PUBLIC_APP_URL alone doesn't count as an allowlist
  withEnv({ NODE_ENV: "production", PUBLIC_APP_URL: "https://app.example.com" }, () => assert.throws(() => assertOriginConfig()));
});

test("production: explicit origins start fine; localhost is honoured only when listed (with a warning); PUBLIC_APP_URL is added", () => {
  withEnv({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://getorchestra.xyz,https://www.getorchestra.xyz", PUBLIC_APP_URL: "https://phone.example.com" }, () => {
    assert.deepEqual(assertOriginConfig(), []);
    assert.equal(isOriginAllowed("https://www.getorchestra.xyz"), true);
    assert.equal(isOriginAllowed("https://phone.example.com"), true);
    for (const bad of ["http://localhost:3000", "http://127.0.0.1:3000", PREVIEW, "https://app.getorchestra.xyz"]) {
      assert.equal(isOriginAllowed(bad), false, `${bad} is not listed`);
    }
  });
  withEnv({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://getorchestra.xyz,http://localhost:*" }, () => {
    const warnings = assertOriginConfig();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /localhost/);
    assert.equal(isOriginAllowed("http://localhost:3000"), true, "explicit config is honoured");
  });
  withEnv({ ALLOWED_ORIGINS: "http://localhost:*" }, () => assert.deepEqual(assertOriginConfig(), [])); // not production: no warning
});

test("attack: production never allows localhost or previews by default", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    for (const bad of ["http://localhost:3000", "http://127.0.0.1:3000", PREVIEW, "https://getorchestra.xyz"]) {
      assert.equal(isOriginAllowed(bad), false, bad);
    }
  });
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
      ALLOWED_ORIGINS: TEST_ORIGINS, PUBLIC_APP_URL: "", ENABLE_MOCK_TRADE: "", NODE_ENV: "", ...env,
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
  ["GET", "/habit"],
  ["GET", "/passkey/status"],
  ["GET", "/approvals/00000000-0000-4000-8000-000000000000"],
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

test("Vary: Origin is on every response through the origin guard; the exact origin is echoed, never *; no credentials header", async () => {
  const seen: Res[] = [];
  for (const origin of ["http://localhost:3000", "https://app.getorchestra.xyz", undefined, "https://evil.com", "null"]) {
    for (const [m, p] of [["GET", "/health"], ["OPTIONS", "/intent"], ["POST", "/auth/login-request"]] as const) {
      const r = await call(m, p, { origin, body: m === "POST" ? { walletAddress: ALICE } : undefined });
      seen.push(r);
      assert.match(String(r.headers.vary), /Origin/i, `${m} ${p} from ${origin}: Vary`);
      const acao = r.headers["access-control-allow-origin"];
      assert.notEqual(acao, "*");
      if (origin && r.status < 400) assert.equal(acao, origin, "exact echo");
      else assert.equal(acao, undefined, "none for refused or no-origin requests");
      assert.equal(r.headers["access-control-allow-credentials"], undefined, "credentials mode is never enabled");
    }
  }
  assert.ok(seen.some((r) => r.status === 403) && seen.some((r) => r.status === 204));
});

test("the session travels in the Authorization header: the bridge never sets a cookie", async () => {
  const nonce = await call("POST", "/auth/login-request", { origin: "http://localhost:3000", body: { walletAddress: ALICE } });
  const responses = [
    nonce,
    await call("POST", "/auth/login", { origin: "http://localhost:3000", body: { walletAddress: ALICE, nonce: "x", signature: "0x00" } }),
    await call("POST", "/auth/privy", { origin: "http://localhost:3000", body: { walletAddress: ALICE, identityToken: "x" } }),
    await call("GET", "/auth/session", { origin: "http://localhost:3000", token: alice() }),
    await call("GET", "/auth/session", { origin: "http://localhost:3000" }),
    await call("GET", "/health"),
    await call("OPTIONS", "/intent", { origin: "http://localhost:3000" }),
    await call("GET", "/health", { origin: "https://evil.com" }),
  ];
  for (const r of responses) assert.equal(r.headers["set-cookie"], undefined);
  // and a cookie sent by a browser is not a session
  const withCookie = await call("GET", "/auth/session", { origin: "http://localhost:3000", headers: { Cookie: `session=${alice()}; token=${alice()}` } });
  assert.equal(withCookie.status, 401);
});

/** Starts serve.ts the way a deployed bridge would, and reports how it ended (it must never listen). */
function startAndWatch(env: Record<string, string>): Promise<{ code: number | null; output: string; listened: boolean }> {
  return freePort().then((p) => new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", "src/integrations/ledger/serve.ts"], {
      env: { ...process.env, STORAGE_BACKEND: "memory", TELEGRAM_BOT_TOKEN: "", PORT: String(p), SESSION_SECRET: SECRET, ALLOWED_ORIGINS: "", PUBLIC_APP_URL: "", ENABLE_MOCK_TRADE: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let listened = false;
    c.stdout!.on("data", (d) => { output += d; if (String(d).includes("Ledger Bridge")) listened = true; });
    c.stderr!.on("data", (d) => (output += d));
    c.on("exit", (code) => resolve({ code, output, listened }));
    setTimeout(() => c.kill(), 30_000); // only reached if it (wrongly) kept running
  }));
}

test("attack: the real bridge refuses to start in production without ALLOWED_ORIGINS, before listening", async () => {
  for (const ALLOWED_ORIGINS of ["", "*"]) {
    const r = await startAndWatch({ NODE_ENV: "production", ALLOWED_ORIGINS });
    assert.equal(r.listened, false, "never listened");
    assert.notEqual(r.code, 0);
    assert.notEqual(r.code, null, "it exited by itself");
    assert.match(r.output, /\[origins\] .*ALLOWED_ORIGINS/);
  }
  const unset = await startAndWatch({ NODE_ENV: "production" });
  assert.match(unset.output, /ALLOWED_ORIGINS must be set when NODE_ENV=production: list the exact https origins of your frontend, comma-separated, e\.g\. ALLOWED_ORIGINS=https:\/\/getorchestra\.xyz,https:\/\/www\.getorchestra\.xyz/);
});

test("production with explicit origins starts, honours exactly those, warns about a listed localhost", async () => {
  const prod = await startBridge({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://getorchestra.xyz,http://localhost:*" });
  const keep = port;
  port = prod.port;
  try {
    assert.equal((await call("GET", "/health", { origin: "https://getorchestra.xyz" })).status, 200);
    assert.equal((await call("GET", "/health", { origin: "https://app.getorchestra.xyz" })).status, 403);
    assert.equal(await wsConnect("https://getorchestra.xyz"), "open");
  } finally { port = keep; prod.child.kill(); }
});

test("local dev: with ALLOWED_ORIGINS unset, localhost and PUBLIC_APP_URL (the phone proxy) work over HTTP and WebSocket", async () => {
  const dev = await startBridge({ ALLOWED_ORIGINS: "", PUBLIC_APP_URL: "https://phone.example.com" });
  const keep = port;
  port = dev.port;
  try {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "https://phone.example.com"]) {
      const r = await call("GET", "/health", { origin });
      assert.equal(r.status, 200, origin);
      assert.equal(r.headers["access-control-allow-origin"], origin);
      assert.equal(await wsConnect(origin), "open", `ws ${origin}`);
    }
    assert.equal((await call("GET", "/health", { origin: "https://getorchestra.xyz" })).status, 403);
    assert.equal((await call("GET", "/health", { origin: PREVIEW })).status, 403);
    assert.equal(await wsConnect(), 403);
    assert.equal((await call("GET", "/health")).status, 200, "plain HTTP without Origin is still fine");
  } finally { port = keep; dev.child.kill(); }
});

test("WebSocket: a disallowed or missing origin is rejected at the upgrade; an allowed one connects", async () => {
  assert.equal(await wsConnect("https://evil.com"), 403);
  assert.equal(await wsConnect("https://getorchestra.xyz.evil.com"), 403);
  assert.equal(await wsConnect("https://something-else.vercel.app"), 403);
  assert.equal(await wsConnect("http://localhost:3000"), "open");
  assert.equal(await wsConnect("https://app.getorchestra.xyz"), "open");
  assert.equal(await wsConnect(PREVIEW), "open");
  assert.equal(await wsConnect(), 403, "an upgrade with no Origin is refused too");
  assert.equal(await wsConnect("null"), 403);
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
    assert.equal((await call("POST", "/mock-trade", { body: {} })).status, 401, "a session is needed even in dev");
    assert.equal((await call("POST", "/mock-trade", { token: alice(), body: {} })).status, 200);
    assert.equal((await call("GET", "/health", { origin: "https://only.example.com" })).status, 200);
    assert.equal((await call("GET", "/health", { origin: "https://phone.example.com" })).status, 200);
    assert.equal((await call("GET", "/health", { origin: "https://getorchestra.xyz" })).status, 403, "the list is replaced, not extended");
    assert.equal(await wsConnect("https://getorchestra.xyz"), 403);
  } finally { port = keep; dev.child.kill(); }
});

// ── Habit, passkey status, approvals and broadcast belong to the signed-in user ──

const ALICE_KEY = ethers.Wallet.createRandom();
const BOB_KEY = ethers.Wallet.createRandom();
const tokenFor = (w: ethers.BaseWallet) => issueToken(w.address).token;
const txFor = { to: BOB, value: 1n, chainId: 11155111, nonce: 0, gasLimit: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, type: 2 };
const signedBy = (w: ethers.BaseWallet) => w.signTransaction(txFor);

test("broadcast: only a signed transaction from the session's own wallet passes the sender check", async () => {
  const alice = await signedBy(ALICE_KEY);
  assert.equal(broadcastSenderProblem(alice, ALICE_KEY.address), null);
  assert.equal(broadcastSenderProblem(alice, ALICE_KEY.address.toLowerCase()), null);
  assert.equal(broadcastSenderProblem(alice, BOB_KEY.address)?.status, 403, "Bob relaying Alice's transaction");
  assert.equal(broadcastSenderProblem(alice, BOB_KEY.address)?.code, "not_your_address");
  assert.equal(broadcastSenderProblem(await signedBy(BOB_KEY), ALICE_KEY.address)?.status, 403, "an unrelated signer");
  for (const bad of ["0x00", "0xdeadbeef", "not hex", "", 42, null, undefined, {}]) {
    assert.equal(broadcastSenderProblem(bad, ALICE_KEY.address)?.status, 400, String(bad));
  }
  const unsigned = ethers.Transaction.from(txFor).unsignedSerialized;
  assert.equal(broadcastSenderProblem(unsigned, ALICE_KEY.address)?.status, 400, "unsigned");
});

test("an approval is visible only to the wallet it was made for", () => {
  assert.equal(approvalBelongsTo({ wallet: ALICE.toLowerCase() }, ALICE), true);
  assert.equal(approvalBelongsTo({ wallet: ALICE.toLowerCase() }, BOB), false);
});

test("attack: /broadcast refuses another user's signed transaction (403) and garbage (400), before any network call", async () => {
  const aliceTx = await signedBy(ALICE_KEY);
  const relay = await call("POST", "/broadcast", { token: tokenFor(BOB_KEY), body: { signedTx: aliceTx } });
  assert.equal(relay.status, 403);
  assert.equal(relay.body.code, "not_your_address");
  const unrelated = await call("POST", "/broadcast", { token: tokenFor(ALICE_KEY), body: { signedTx: await signedBy(BOB_KEY) } });
  assert.equal(unrelated.status, 403);
  for (const signedTx of ["0x00", "garbage", ethers.Transaction.from(txFor).unsignedSerialized]) {
    assert.equal((await call("POST", "/broadcast", { token: tokenFor(ALICE_KEY), body: { signedTx } })).status, 400, signedTx.slice(0, 12));
  }
});

test("attack: /habit and /passkey/status refuse another wallet's address (403) and answer for the session's own", async () => {
  for (const path of ["/habit", "/passkey/status"]) {
    const other = await call("GET", `${path}?wallet=${ALICE}`, { token: bob() });
    assert.equal(other.status, 403, path);
    assert.equal(other.body.code, "not_your_address");
    for (const q of [`?wallet=${BOB}`, `?wallet=${BOB.toLowerCase()}`, ""]) {
      const own = await call("GET", `${path}${q}`, { token: bob() });
      assert.equal(own.status, 200, `${path}${q}`);
    }
  }
  const habit = await call("GET", `/habit?wallet=${BOB}`, { token: bob() });
  assert.equal(habit.body.wallet.toLowerCase(), BOB.toLowerCase(), "the answer is about the session's wallet");
  assert.equal((await call("GET", "/passkey/status", { token: bob() })).body.registered, false);
});

test("/approvals/:id answers 404 for an unknown id when signed in", async () => {
  const r = await call("GET", "/approvals/00000000-0000-4000-8000-000000000000", { token: alice() });
  assert.equal(r.status, 404);
});

// ── Model switch is gone ──

test("/set-compute-provider and /compute-provider no longer exist (404), signed in or not", async () => {
  for (const token of [undefined, alice()]) {
    assert.equal((await call("POST", "/set-compute-provider", { token, body: { provider: "0g" } })).status, 404);
    assert.equal((await call("GET", "/compute-provider", { token })).status, 404);
  }
});

// ── Telegram link steps are for the signed-in wallet ──

test("attack: /telegram/status and /telegram/link-request need a session and refuse another wallet's address", async () => {
  assert.equal((await call("GET", `/telegram/status?wallet=${ALICE}`)).status, 401);
  assert.equal((await call("POST", "/telegram/link-request", { body: { walletAddress: ALICE } })).status, 401);
  const status = await call("GET", `/telegram/status?wallet=${ALICE}`, { token: bob() });
  assert.equal(status.status, 403);
  assert.equal(status.body.code, "not_your_address");
  const link = await call("POST", "/telegram/link-request", { token: bob(), body: { walletAddress: ALICE } });
  assert.equal(link.status, 403);
  assert.equal(link.body.code, "not_your_address");
});

test("own wallet passes the Telegram gate (Telegram is not configured in tests, so the answers say so)", async () => {
  for (const q of [`?wallet=${BOB}`, ""]) {
    const r = await call("GET", `/telegram/status${q}`, { token: bob() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { enabled: false, linked: false });
  }
  const link = await call("POST", "/telegram/link-request", { token: bob(), body: { walletAddress: BOB } });
  assert.equal(link.status, 400);
  assert.match(link.body.error, /aren't configured/);
});

test("/simple shows the Telegram pill and button only after sign-in", () => {
  const page = fs.readFileSync(new URL("../../../frontend/src/app/simple/page.js", import.meta.url), "utf8");
  assert.match(page, /\{session\.ready && <TelegramLink /);
  assert.doesNotMatch(page.replace(/\{session\.ready && <TelegramLink /, ""), /<TelegramLink /, "no other place renders it");
});

// ── WebSocket sign-in and per-wallet delivery ──

/** A WebSocket client that records what it receives and how it was closed. */
class Probe {
  ws: WebSocket;
  got: any[] = [];
  closed: number | null = null;
  constructor(url: string, origin?: string) {
    this.ws = new WebSocket(url, origin ? { origin } : {});
    this.ws.on("message", (d) => this.got.push(JSON.parse(d.toString())));
    this.ws.on("close", (code) => (this.closed = code));
    this.ws.on("error", () => {});
  }
  opened() { return new Promise<void>((r) => (this.ws.readyState === WebSocket.OPEN ? r() : this.ws.once("open", () => r()))); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  async waitFor(pred: (m: any) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = this.got.find(pred); if (m) return m; await sleep(20); }
    return null;
  }
  async waitClosed(ms = 3000) { const end = Date.now() + ms; while (this.closed === null && Date.now() < end) await sleep(20); return this.closed; }
  async auth(token: string) { await this.opened(); this.send({ type: "AUTH", token }); return this.waitFor((m) => m.type === "AUTH_OK"); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const request = (id: string) => ({ tradeId: id, unsignedTxHex: "0x00", summary: "test", riskLevel: "requires_approval" as const, timestamp: Date.now() });
const result = (id: string) => ({ tradeId: id, approved: true });

/** A BridgeServer on its own port with a short sign-in window and the real session check. */
async function localBridge(authTimeoutMs = 300) {
  const server = http.createServer();
  const bridge = new BridgeServer(server, { authTimeoutMs, timeoutMs: 60_000, verifySession: verifyToken });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/ws`;
  return { bridge, url, close: () => { for (const c of (bridge as any).wss.clients) c.terminate(); server.close(); } };
}

test("attack: a socket that never signs in receives nothing and is closed after the timeout", async () => {
  const b = await localBridge(300);
  try {
    const idle = new Probe(b.url);
    await idle.opened();
    void b.bridge.requestApproval(request("t-idle"), ALICE).catch(() => {});
    assert.equal(await idle.waitClosed(2000), 4401);
    assert.equal(idle.got.filter((m) => m.type === "APPROVAL_REQUIRED").length, 0, "nothing delivered before sign-in");
  } finally { b.close(); }
});

test("attack: speaking before signing in, forged and expired tokens are refused and closed", async () => {
  const b = await localBridge(5000);
  try {
    const early = new Probe(b.url);
    await early.opened();
    early.send({ type: "APPROVAL_RESULT", payload: result("x") });
    assert.equal(await early.waitClosed(), 4401);
    assert.ok(early.got.some((m) => m.type === "ERROR" && m.payload.code === "session_required"));

    for (const token of ["abc.def", "", 42, issueToken(ALICE, Date.now() - 9 * 3_600_000).token]) {
      const p = new Probe(b.url);
      await p.opened();
      p.send({ type: "AUTH", token });
      assert.equal(await p.waitClosed(), 4401, `token ${String(token).slice(0, 8)}`);
      assert.equal(p.got.some((m) => m.type === "AUTH_OK"), false);
    }
  } finally { b.close(); }
});

test("attack: Bob's socket never receives Alice's approval, and Bob answering it is refused and doesn't resolve it", async () => {
  const b = await localBridge();
  try {
    const a = new Probe(b.url), bo = new Probe(b.url);
    assert.ok(await a.auth(alice()));
    assert.ok(await bo.auth(bob()));
    let resolved: any = null;
    void b.bridge.requestApproval(request("t-alice"), ALICE).then((r) => (resolved = r)).catch(() => {});
    assert.ok(await a.waitFor((m) => m.type === "APPROVAL_REQUIRED" && m.payload.tradeId === "t-alice"), "Alice gets her approval");
    await sleep(200);
    assert.equal(bo.got.some((m) => m.type === "APPROVAL_REQUIRED"), false, "Bob gets nothing");

    bo.send({ type: "APPROVAL_RESULT", payload: result("t-alice") });
    assert.ok(await bo.waitFor((m) => m.type === "ERROR" && m.payload.code === "not_your_approval"), "Bob is told no");
    await sleep(100);
    assert.equal(resolved, null, "Bob's answer didn't resolve it");
    bo.send({ type: "APPROVAL_RESULT", payload: result("never-existed") });
    await sleep(100);
    assert.equal(bo.got.filter((m) => m.type === "ERROR").length, 2, "an unknown id is refused the same way");

    a.send({ type: "APPROVAL_RESULT", payload: result("t-alice") });
    await sleep(200);
    assert.deepEqual(resolved, result("t-alice"), "Alice's own answer resolves it");
  } finally { b.close(); }
});

test("a session that expires mid-connection stops receiving and is closed", async () => {
  const b = await localBridge();
  try {
    const short = issueToken(ALICE, Date.now() - 8 * 3_600_000 + 400).token; // valid for ~0.4s
    const a = new Probe(b.url);
    assert.ok(await a.auth(short));
    await sleep(700);
    void b.bridge.requestApproval(request("t-late"), ALICE).catch(() => {});
    assert.equal(await a.waitClosed(), 4401);
    assert.equal(a.got.some((m) => m.type === "APPROVAL_REQUIRED"), false);
  } finally { b.close(); }
});

test("end to end on the real bridge: sign in → mock trade → receive → answer → resolved; Bob sees and can do nothing", async () => {
  const dev = await startBridge({ ENABLE_MOCK_TRADE: "1" });
  const keep = port;
  port = dev.port;
  const url = `ws://127.0.0.1:${dev.port}/ws`;
  try {
    const a = new Probe(url, "http://localhost:3000"), bo = new Probe(url, "http://localhost:3000");
    assert.ok(await a.auth(alice()));
    assert.ok(await bo.auth(bob()));
    assert.equal((await call("POST", "/mock-trade", { token: alice(), body: { summary: "Mock for Alice" } })).status, 200);
    const got = await a.waitFor((m) => m.type === "APPROVAL_REQUIRED");
    assert.equal(got.payload.summary, "Mock for Alice");
    const id = got.payload.tradeId;
    await sleep(200);
    assert.equal(bo.got.some((m) => m.type === "APPROVAL_REQUIRED"), false);
    bo.send({ type: "APPROVAL_RESULT", payload: result(id) });
    assert.ok(await bo.waitFor((m) => m.type === "ERROR" && m.payload.code === "not_your_approval"));
    a.send({ type: "APPROVAL_RESULT", payload: result(id) });
    await sleep(300);
    a.send({ type: "APPROVAL_RESULT", payload: result(id) }); // already resolved: nothing left to answer
    assert.ok(await a.waitFor((m) => m.type === "ERROR" && m.payload.code === "not_your_approval"), "the first answer resolved it");
  } finally { port = keep; dev.child.kill(); }
});

test("the real bridge closes a socket that never signs in (default window)", async () => {
  const idle = new Probe(`ws://127.0.0.1:${port}/ws`, "http://localhost:3000");
  await idle.opened();
  assert.equal(await idle.waitClosed(8000), 4401);
  assert.deepEqual(idle.got.map((m) => m.type), ["ERROR"]);
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
