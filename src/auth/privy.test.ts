// ─── Auth — Privy sign-in tests (no network: tokens signed with a local key) ───
// Run with `npm run test:privy`.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { isoCBOR } from "@simplewebauthn/server/helpers";

process.env.STORAGE_BACKEND = "memory";
const APP_ID = "test-privy-app";
process.env.PRIVY_APP_ID = APP_ID;

const RP = { rpID: "localhost", origin: "http://localhost:3000" };

/** A software passkey: a P-256 key like a phone's secure chip holds, signing WebAuthn assertions. */
function softPasskey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], // kty EC2, alg ES256, crv P-256
    [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")],
  ]));
  const id = crypto.randomBytes(16).toString("base64url");
  return {
    id,
    publicKey: Buffer.from(cose).toString("base64url"),
    assert(challenge: string, origin = RP.origin, rpID = RP.rpID) {
      const flags = Buffer.from([0x05]); // user present + verified
      const authData = Buffer.concat([crypto.createHash("sha256").update(rpID).digest(), flags, Buffer.alloc(4)]);
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
      const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]), privateKey);
      return {
        id, rawId: id, type: "public-key", clientExtensionResults: {},
        response: {
          authenticatorData: authData.toString("base64url"),
          clientDataJSON: clientData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
}

const embedded = ethers.Wallet.createRandom().address;
const external = ethers.Wallet.createRandom().address;
const stranger = ethers.Wallet.createRandom().address;

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

(async () => {
  const auth = await import("./index");
  const { privyLogin, verifyPrivyUser, importPrivyPasskeys, _setVerificationKey, _setUserFetcher } = await import("./privy");
  const passkey = await import("../integrations/passkey");
  const storage = await import("../integrations/zero-g/storage");
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

  // ── Sign-in passkey → approval passkey ──
  const signInKey = softPasskey();
  const passkeyUser = async () => verifyPrivyUser(await idToken({ accounts: [
    { type: "passkey", credential_id: signInKey.id, lv: 1 },
    { type: "wallet", address: embedded, chain_type: "ethereum", wallet_client_type: "privy", id: "w1", lv: 1 },
  ] }), embedded);
  // What Privy's API returns for the user: the passkey with its public key.
  const privyApi = (publicKey = signInKey.publicKey) => {
    const calls: string[] = [];
    _setUserFetcher(async (id) => {
      calls.push(id);
      return { id, linked_accounts: [{ type: "passkey", credential_id: signInKey.id, public_key: publicKey }] } as any;
    });
    return calls;
  };

  test("the sign-in passkey approves: its assertion over an approval challenge verifies", async () => {
    await storage.clear();
    const calls = privyApi();
    assert.equal(await importPrivyPasskeys(await passkeyUser(), embedded, RP.rpID), 1);
    assert.deepEqual(calls, ["did:privy:user1"]);
    assert.equal(await passkey.hasPasskey(embedded), true);

    const challenge = Buffer.from(crypto.randomBytes(32)).toString("base64url"); // stands in for the payload-hash challenge
    assert.equal(await passkey.verifyAuthentication(embedded, signInKey.assert(challenge), challenge, RP), true);
  });

  test("another key, another challenge or another domain doesn't pass", async () => {
    const challenge = crypto.randomBytes(32).toString("base64url");
    const other = softPasskey();
    const forged = { ...other.assert(challenge), id: signInKey.id, rawId: signInKey.id }; // claims the sign-in passkey's id
    await assert.rejects(async () => assert.equal(await passkey.verifyAuthentication(embedded, forged, challenge, RP), true));
    await assert.rejects(passkey.verifyAuthentication(embedded, signInKey.assert("other-challenge"), challenge, RP));
    await assert.rejects(passkey.verifyAuthentication(embedded, signInKey.assert(challenge, "https://evil.example", "evil.example"), challenge, RP));
  });

  test("signing in again keeps one credential and its counter", async () => {
    privyApi();
    assert.equal(await importPrivyPasskeys(await passkeyUser(), embedded, RP.rpID), 1);
    const stored = (await storage.read(`passkey:${embedded.toLowerCase()}`)) as any;
    assert.equal(stored.creds.length, 1);
    assert.equal(stored.creds[0].source, "privy");
  });

  test("a public key that isn't a COSE key is refused (fails closed)", async () => {
    await storage.clear();
    privyApi(Buffer.from("not a key").toString("base64url"));
    assert.equal(await importPrivyPasskeys(await passkeyUser(), embedded, RP.rpID), 0);
    assert.equal(await passkey.hasPasskey(embedded), false);
  });

  test("no passkey on the account, or no app secret: nothing is imported", async () => {
    await storage.clear();
    const calls = privyApi();
    const walletUser = await verifyPrivyUser(await idToken(), external); // the default accounts have a passkey…
    const noPasskey = { ...walletUser, linked_accounts: walletUser.linked_accounts.filter((a) => a.type !== "passkey") };
    assert.equal(await importPrivyPasskeys(noPasskey, external, RP.rpID), 0);
    assert.equal(calls.length, 0, "Privy's API isn't called for users without a passkey");

    _setUserFetcher(null);
    delete process.env.PRIVY_APP_SECRET;
    assert.equal(await importPrivyPasskeys(await passkeyUser(), embedded, RP.rpID), 0);
    assert.equal(await passkey.hasPasskey(embedded), false);
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
