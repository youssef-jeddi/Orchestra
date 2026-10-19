// ─── Bridge — routes answer plain sentences, never library text (ORC-102/103/104) ───
// The real bridge (serve.ts on a free port, the Sepolia RPC pointed at a closed port), hit with
// inputs that make the libraries underneath throw: no body may carry ethers' wording, an RPC URL or
// a stack frame; each is either a specific sentence written for the user or UNEXPECTED_ERROR. Also
// the dev-only "execute" fault: accepted, inert in production, and fails closed on both paths.
// Run with `npm run test:errors-bridge`.

import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import { issueToken } from "../../auth";
import { linkRequest, confirmLink } from "../telegram";
import { UserFacingError } from "../../utils/userFacing";
import { faultOn, faultInjectProblem } from "../../utils/faultInject";
import { EXECUTION_FAILED_REASON } from "../../intent/messages";
import { UNEXPECTED_ERROR } from "./errors";
import { startBridge, post, replay } from "../../utils/testBridge";

const WALLET = ethers.Wallet.createRandom().address;
const RECIPIENT = ethers.Wallet.createRandom().address;
const SEND = `send 5 USDC to ${RECIPIENT}`;
const DEAD_RPC = "http://127.0.0.1:1/SECRETKEY";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

function call(port: number, method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data || "{}"), text: data }));
    });
    req.on("error", reject); if (method !== "GET") req.write(JSON.stringify(body ?? {})); req.end();
  });
}

/** What no answer to a user may contain: library wording, URLs, codes, stack frames. */
const RAW = /BytesLike|code=|invalid [a-z]+ \(|SECRETKEY|127\.0\.0\.1|ECONNREFUSED|fetch failed|\n\s+at |version=|argument=/i;
const plain = (r: { status: number; body: any; text: string }, label: string) => {
  assert.ok(r.status >= 400, `${label}: ${r.status} ${r.text}`);
  assert.equal(typeof r.body.error, "string", `${label}: ${r.text}`);
  assert.ok(!RAW.test(r.text), `${label}: raw text in ${r.text}`);
};

// ── The Telegram library ──

test("telegram link: a bad address, a bad code and a malformed signature are plain 400s", async () => {
  const wrong = await Promise.resolve().then(() => linkRequest("nope")).catch((e) => e);
  assert.ok(wrong instanceof UserFacingError && wrong.status === 400);
  assert.equal(wrong.message, "That isn't a valid wallet address.");
  const { code } = linkRequest(WALLET);
  for (const sig of ["0x1234", "not hex", "0x" + "00".repeat(65)]) {
    const e = await confirmLink(WALLET, code, sig).catch((x) => x);
    assert.ok(e instanceof UserFacingError && e.status === 400, String(e?.message));
    assert.ok(!RAW.test(e.message), e.message);
  }
  assert.equal(await confirmLink(WALLET, code, "0x1234").catch((e) => e.message), "That signature didn't work. Start again.");
  const expired = await confirmLink(WALLET, "unknown-code", "0x1234").catch((e) => e);
  assert.ok(expired instanceof UserFacingError && expired.status === 400);
  assert.equal(expired.message, "Link request expired. Start again.");
});

// ── The real bridge ──

test("routes that used to answer e.message now answer a plain sentence", async () => {
  const bridge = await startBridge({ SEPOLIA_RPC_URL: DEAD_RPC, PRIVY_APP_ID: "" });
  try {
    const token = issueToken(WALLET).token;

    const link = await call(bridge.port, "POST", "/telegram/link", null, { walletAddress: WALLET, code: "nope", signature: "0x12" });
    plain(link, "/telegram/link");
    assert.equal(link.status, 400);
    assert.equal(link.body.error, "Link request expired. Start again.");
    const linkNum = await call(bridge.port, "POST", "/telegram/link", null, { walletAddress: 5, code: "x", signature: "y" });
    plain(linkNum, "/telegram/link (wallet not text)");
    assert.equal(linkNum.status, 400);

    const linkReq = await call(bridge.port, "POST", "/telegram/link-request", token, { walletAddress: WALLET });
    plain(linkReq, "/telegram/link-request");

    for (const body of [{}, { walletAddress: "0xnope" }, { walletAddress: 12 }, { walletAddress: { a: 1 } }]) {
      const r = await call(bridge.port, "POST", "/auth/login-request", null, body);
      plain(r, `/auth/login-request ${JSON.stringify(body)}`);
      assert.equal(r.status, 400);
    }
    for (const body of [{}, { walletAddress: WALLET, nonce: "x", signature: "garbage" }, { walletAddress: "zz", nonce: 1, signature: [] }]) {
      const r = await call(bridge.port, "POST", "/auth/login", null, body);
      plain(r, `/auth/login ${JSON.stringify(body)}`);
      assert.ok(r.status === 400 || r.status === 401, r.text);
    }
    const privy = await call(bridge.port, "POST", "/auth/privy", null, { walletAddress: WALLET, identityToken: "garbage" });
    plain(privy, "/auth/privy");

    // A valid signed transaction from this wallet, but the RPC is down: unexpected, so the fixed sentence.
    const signer = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
    const own = issueToken(signer.address).token;
    const signedTx = await signer.signTransaction({ to: RECIPIENT, value: 1n, nonce: 0, gasLimit: 21000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, chainId: 11155111, type: 2 });
    const bc = await call(bridge.port, "POST", "/broadcast", own, { signedTx });
    plain(bc, "/broadcast");
    assert.deepEqual(bc.body, { error: UNEXPECTED_ERROR });
    const bad = await call(bridge.port, "POST", "/broadcast", own, { signedTx: "0x1234" });
    plain(bad, "/broadcast (malformed)");
    assert.equal(bad.status, 400, "the explicit validation is kept");

    const nonce = await call(bridge.port, "GET", `/nonce/${signer.address}`, own);
    plain(nonce, "/nonce");
    assert.deepEqual(nonce.body, { error: UNEXPECTED_ERROR });

    // /quote and /swap call the Uniswap API, so only their missing-input checks run without a network.
    const quote = await call(bridge.port, "POST", "/quote", own, {});
    assert.equal(quote.status, 400);
    const swap = await call(bridge.port, "POST", "/swap", own, {});
    assert.equal(swap.status, 400);

    const status = await call(bridge.port, "GET", `/passkey/status?wallet=${WALLET}`, token);
    assert.ok(status.status < 400 || !RAW.test(status.text), status.text);
  } finally { bridge.child.kill(); }
});

test("execute fault on a real bridge: a send never claims success and never shows the injected text", async () => {
  replay(SEND, { type: "actions", steps: [{ action: "send", token: "USDC", amount: "5", unit: "token", to: RECIPIENT }] });
  const bridge = await startBridge({ ORCHESTRA_FAULT_INJECT: "execute" });
  try {
    const token = issueToken(WALLET).token;
    const r = await post(bridge.port, { message: SEND, walletAddress: WALLET }, token);
    // Without an account the send doesn't reach the adapter, so it can't auto-execute here: whatever
    // it answers must still be free of the injected text and must not claim success.
    assert.ok(!JSON.stringify(r.body).includes("SECRETKEY"), JSON.stringify(r.body));
    assert.ok(!r.body.txHash && !r.body.autoExecuted, JSON.stringify(r.body));
    if (r.status === 502) assert.equal(r.body.error, EXECUTION_FAILED_REASON);
  } finally { bridge.child.kill(); }
});

// ── The dev-only fault ──

test("the execute fault is accepted, and inert in production and on 0G", () => {
  const env = (o: Record<string, string>): NodeJS.ProcessEnv => ({ STORAGE_BACKEND: "memory", ...o });
  assert.equal(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "execute" })), null);
  assert.equal(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "profile-read,execute" })), null);
  assert.match(faultInjectProblem(env({ ORCHESTRA_FAULT_INJECT: "execute", NODE_ENV: "production" }))!, /production/);
  assert.equal(faultOn("execute", env({ ORCHESTRA_FAULT_INJECT: "execute" })), true);
  assert.equal(faultOn("execute", env({ ORCHESTRA_FAULT_INJECT: "execute", NODE_ENV: "production" })), false);
  assert.equal(faultOn("execute", env({ ORCHESTRA_FAULT_INJECT: "execute", STORAGE_BACKEND: "0g" })), false);
  assert.equal(faultOn("execute", env({})), false);
});

(async () => {
  console.log("errors bridge");
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
