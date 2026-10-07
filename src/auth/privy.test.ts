// ─── Auth — Privy sign-in tests (no network: tokens signed with a local key) ───
// Run with `npm run test:privy`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";

process.env.STORAGE_BACKEND = "memory";
const APP_ID = "test-privy-app";
process.env.PRIVY_APP_ID = APP_ID;

const embedded = ethers.Wallet.createRandom().address;
const external = ethers.Wallet.createRandom().address;
const stranger = ethers.Wallet.createRandom().address;

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

(async () => {
  const auth = await import("./index");
  const { privyLogin, _setVerificationKey } = await import("./privy");
  auth._setSecret("test-secret-test-secret-test-secret!");

  const privy = await generateKeyPair("ES256");
  const impostor = await generateKeyPair("ES256");
  _setVerificationKey(privy.publicKey);

  // The claims Privy puts in an identity token (linked_accounts is a JSON string).
  const idToken = (opts: { key?: CryptoKey; aud?: string; exp?: string | number; accounts?: unknown[] } = {}) =>
    new SignJWT({
      cr: String(Math.floor(Date.now() / 1000)),
      linked_accounts: JSON.stringify(opts.accounts ?? [
        { type: "passkey", credential_id: "abc", lv: 1 },
        { type: "wallet", address: embedded, chain_type: "ethereum", wallet_client_type: "privy", id: "w1", lv: 1 },
        { type: "wallet", address: external, chain_type: "ethereum", wallet_client_type: "metamask", lv: 1 },
      ]),
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer("privy.io")
      .setAudience(opts.aud ?? APP_ID)
      .setSubject("did:privy:user1")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "1h")
      .sign(opts.key ?? privy.privateKey);

  const status = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { return e instanceof auth.AuthError ? e.status : -1; }
    return 0;
  };

  test("the embedded wallet of a passkey user gets a session", async () => {
    const s = await privyLogin(await idToken(), embedded);
    assert.equal(s.wallet, embedded.toLowerCase());
    assert.equal(auth.verifyToken(s.token), embedded.toLowerCase());
  });

  test("an external wallet linked through Privy gets a session (any letter case)", async () => {
    const s = await privyLogin(await idToken(), external.toLowerCase());
    assert.equal(auth.verifyToken(s.token), external.toLowerCase());
  });

  test("a wallet that isn't linked to the user is refused", async () => {
    assert.equal(await status(async () => privyLogin(await idToken(), stranger)), 403);
  });

  test("a Solana account with the same address string doesn't count", async () => {
    const token = await idToken({ accounts: [{ type: "wallet", address: stranger, chain_type: "solana", lv: 1 }] });
    assert.equal(await status(() => privyLogin(token, stranger)), 403);
  });

  test("a token signed by another key is refused", async () => {
    assert.equal(await status(async () => privyLogin(await idToken({ key: impostor.privateKey }), embedded)), 401);
  });

  test("a token issued for another Privy app is refused", async () => {
    assert.equal(await status(async () => privyLogin(await idToken({ aud: "some-other-app" }), embedded)), 401);
  });

  test("an expired token is refused", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    assert.equal(await status(async () => privyLogin(await idToken({ exp: past }), embedded)), 401);
  });

  test("bad input is a 400, and no PRIVY_APP_ID is a 501", async () => {
    assert.equal(await status(() => privyLogin(undefined, embedded)), 400);
    assert.equal(await status(async () => privyLogin(await idToken(), "not-an-address")), 400);
    delete process.env.PRIVY_APP_ID;
    try {
      assert.equal(await status(async () => privyLogin(await idToken(), embedded)), 501);
    } finally {
      process.env.PRIVY_APP_ID = APP_ID;
    }
  });

  console.log("privy");
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
