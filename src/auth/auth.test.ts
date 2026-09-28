// ─── Auth — wallet session tests (no network; in-memory storage) ───
// Run with `npm run test:auth`.

import assert from "node:assert/strict";
import { ethers } from "ethers";

// In-memory storage for the per-wallet policy tests; set before the store loads.
delete process.env.ZERO_G_PRIVATE_KEY;

const owner = ethers.Wallet.createRandom();
const attacker = ethers.Wallet.createRandom();

/** Sign the typed data the way eth_signTypedData_v4 would (ethers drops EIP712Domain itself). */
async function sign(wallet: ethers.HDNodeWallet, typedData: any): Promise<string> {
  const { EIP712Domain, ...types } = typedData.types;
  return wallet.signTypedData(typedData.domain, types, typedData.message);
}

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

(async () => {
  const auth = await import("./index");
  const { limitTxProblem } = await import("../integrations/safe/verifyLimitTx");
  const store = await import("../policy/store");
  const storage = await import("../integrations/zero-g/storage");
  auth._setSecret("test-secret-test-secret-test-secret!");
  const { loginRequest, login, issueToken, verifyToken, requireSession, AuthError, SESSION_TTL_MS } = auth;

  const status = (fn: () => unknown) => {
    try { fn(); } catch (e) { return e instanceof AuthError ? e.status : -1; }
    return 0;
  };

  // ── Login ──
  test("login: the wallet's own signature yields a session for that wallet", async () => {
    const { nonce, typedData } = loginRequest(owner.address);
    assert.equal(typedData.message.wallet, owner.address);
    assert.ok(typedData.types.EIP712Domain, "MetaMask v4 needs EIP712Domain in types");
    const s = login(owner.address, nonce, await sign(owner, typedData));
    assert.equal(s.wallet, owner.address.toLowerCase());
    assert.equal(verifyToken(s.token), owner.address.toLowerCase());
  });

  test("login: another key's signature is refused", async () => {
    const { nonce, typedData } = loginRequest(owner.address);
    const sig = await sign(attacker, typedData);
    assert.equal(status(() => login(owner.address, nonce, sig)), 401);
  });

  test("login: a nonce is single-use, even after a failed attempt", async () => {
    const { nonce, typedData } = loginRequest(owner.address);
    const good = await sign(owner, typedData);
    assert.equal(status(() => login(owner.address, nonce, "0x1234")), 401);
    assert.equal(status(() => login(owner.address, nonce, good)), 401);
  });

  test("login: a nonce issued for one wallet can't log in another", async () => {
    const { nonce, typedData } = loginRequest(owner.address);
    const sig = await sign(attacker, { ...typedData, message: { ...typedData.message, wallet: attacker.address } });
    assert.equal(status(() => login(attacker.address, nonce, sig)), 401);
  });

  test("loginRequest: rejects a non-address", () => {
    assert.equal(status(() => loginRequest("bob")), 400);
  });

  // ── Tokens ──
  test("token: tampered payload or MAC is rejected", () => {
    const { token } = issueToken(owner.address);
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ w: attacker.address.toLowerCase(), iat: Date.now(), exp: Date.now() + 1e9 })).toString("base64url");
    assert.equal(verifyToken(`${forged}.${mac}`), null);
    assert.equal(verifyToken(`${payload}.${mac.slice(0, -2)}xx`), null);
    assert.equal(verifyToken(`${payload}.${mac}.extra`), null);
    assert.equal(verifyToken("garbage"), null);
    assert.equal(verifyToken(undefined), null);
  });

  test("token: expires after the TTL", () => {
    const t0 = Date.now();
    const { token } = issueToken(owner.address, t0);
    assert.equal(verifyToken(token, t0 + SESSION_TTL_MS - 1), owner.address.toLowerCase());
    assert.equal(verifyToken(token, t0 + SESSION_TTL_MS + 1), null);
  });

  test("token: a different server secret invalidates it", () => {
    const { token } = issueToken(owner.address);
    auth._setSecret("another-secret-another-secret-another");
    assert.equal(verifyToken(token), null);
    auth._setSecret("test-secret-test-secret-test-secret!");
  });

  test("secret file: generated once (owner-only), then reused across restarts", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-auth-")), "sub", "session-secret");
    const first = auth.loadOrCreateSecretFile(file);
    assert.equal(first.length, 32);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(auth.loadOrCreateSecretFile(file), first); // a "restart" reads the same secret
    fs.writeFileSync(file, "corrupt");
    assert.notDeepEqual(auth.loadOrCreateSecretFile(file), first); // invalid content is replaced
  });

  // ── Middleware ──
  test("requireSession: 401 without a valid bearer token, wallet from the token otherwise", () => {
    const run = (authorization?: string) => {
      const out: { status?: number; body?: any; next: boolean; wallet?: string } = { next: false };
      const res: any = { locals: {}, status(s: number) { out.status = s; return this; }, json(b: any) { out.body = b; return this; } };
      requireSession({ headers: authorization ? { authorization } : {} } as any, res, () => { out.next = true; });
      out.wallet = res.locals.wallet;
      return out;
    };
    const none = run();
    assert.equal(none.status, 401);
    assert.equal(none.body.code, "session_required");
    assert.equal(run("Bearer nope").status, 401);
    const ok = run(`Bearer ${issueToken(owner.address).token}`);
    assert.equal(ok.next, true);
    assert.equal(ok.wallet, owner.address.toLowerCase());
  });

  // ── Limit-update tx verification ──
  const SAFE = "0x933f48ed12e2de3da82cc69c7a4f95c2adece3d1";
  const good = {
    tx: { from: owner.address, to: SAFE, data: "0xabcd" },
    receipt: { status: 1 },
    wallet: owner.address.toLowerCase(),
    safeAddress: SAFE,
    expectedData: "0xABCD",
  };
  test("limitTxProblem: the exact tx from the owner to the Safe passes", () => {
    assert.equal(limitTxProblem(good), null);
  });
  test("limitTxProblem: missing, reverted, wrong sender, wrong target or wrong calldata fail", () => {
    assert.match(limitTxProblem({ ...good, tx: null })!, /isn't mined/);
    assert.match(limitTxProblem({ ...good, receipt: { status: 0 } })!, /reverted/);
    assert.match(limitTxProblem({ ...good, tx: { ...good.tx, from: attacker.address } })!, /your wallet/);
    assert.match(limitTxProblem({ ...good, tx: { ...good.tx, to: attacker.address } })!, /your Safe/);
    assert.match(limitTxProblem({ ...good, expectedData: "0xabce" })!, /requested limit/);
  });

  // ── Per-wallet policy ──
  test("policy store: each wallet reads its own policy; legacy global is a read-only fallback", async () => {
    await storage.clear();
    store._resetPolicyStoreCache();
    await storage.write("user:profile", { policy: { dailyLimitUsd: 50 } });
    assert.equal((await store.getPolicyProfile(owner.address)).dailyLimitUsd, 50); // legacy fallback
    assert.deepEqual(await store.getPolicyProfile(undefined), {});

    await store.writeUserProfile(attacker.address, { policy: { dailyLimitUsd: 100000 } });
    assert.equal((await store.getPolicyProfile(attacker.address)).dailyLimitUsd, 100000);
    assert.equal((await store.getPolicyProfile(owner.address)).dailyLimitUsd, 50); // untouched
    assert.equal(((await storage.read("user:profile")) as any).policy.dailyLimitUsd, 50);
  });

  console.log("auth");
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
