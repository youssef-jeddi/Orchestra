// ─── Passkey — store, relying parties and phone setup links (no authenticator, in-memory storage) ───
// Run with `npm run test:passkey`.

import assert from "node:assert/strict";

process.env.STORAGE_BACKEND = "memory"; // never touch the real data file
delete process.env.PASSKEY_RP_ID;
delete process.env.PASSKEY_ORIGIN;

const WALLET = "0xAbC0000000000000000000000000000000000001";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

(async () => {
  const pk = await import("./index");
  const setup = await import("./phoneSetup");
  const storage = await import("../zero-g/storage");

  test("phoneRp: https PUBLIC_APP_URL → its host and origin; anything else → null", () => {
    process.env.PUBLIC_APP_URL = "https://orchestra-demo.trycloudflare.com/some/path";
    assert.deepEqual(pk.phoneRp(), { rpID: "orchestra-demo.trycloudflare.com", origin: "https://orchestra-demo.trycloudflare.com" });
    process.env.PUBLIC_APP_URL = "http://192.168.1.10:3000";
    assert.equal(pk.phoneRp(), null); // WebAuthn needs https off localhost
    process.env.PUBLIC_APP_URL = "not a url";
    assert.equal(pk.phoneRp(), null);
    delete process.env.PUBLIC_APP_URL;
    assert.equal(pk.phoneRp(), null);
  });

  test("rpForOrigin: the passkey domain follows the page — localhost or PUBLIC_APP_URL, nothing else", () => {
    process.env.PUBLIC_APP_URL = "https://phone.example.com";
    assert.deepEqual(pk.rpForOrigin("http://localhost:3000"), { rpID: "localhost", origin: "http://localhost:3000" });
    assert.deepEqual(pk.rpForOrigin(undefined), { rpID: "localhost", origin: "http://localhost:3000" });
    assert.deepEqual(pk.rpForOrigin("https://phone.example.com"), { rpID: "phone.example.com", origin: "https://phone.example.com" });
    assert.equal(pk.rpForOrigin("https://evil.example"), null);
    assert.equal(pk.rpForOrigin("http://phone.example.com"), null); // scheme matters
  });

  test("store: a legacy single credential still counts as the browser passkey", async () => {
    await storage.clear();
    await storage.write(`passkey:${WALLET.toLowerCase()}`, { id: "legacy", publicKey: "AA==", counter: 0 });
    assert.equal(await pk.hasPasskey(WALLET), true);
    process.env.PUBLIC_APP_URL = "https://phone.example.com";
    assert.equal(await pk.hasPhonePasskey(WALLET), false);
  });

  test("store: passkeys are offered only on their own domain", async () => {
    await storage.clear();
    process.env.PUBLIC_APP_URL = "https://phone.example.com";
    await storage.write(`passkey:${WALLET.toLowerCase()}`, {
      creds: [
        { id: "desk", publicKey: "AA==", counter: 0, rpID: "localhost", label: "browser" },
        { id: "phone", publicKey: "AA==", counter: 0, rpID: "phone.example.com", label: "phone" },
      ],
    });
    assert.equal(await pk.hasPhonePasskey(WALLET), true);
    const phoneOpts = await pk.authenticationOptions(WALLET, new Uint8Array(32), pk.phoneRp()!);
    assert.deepEqual(phoneOpts.allowCredentials?.map((c) => c.id), ["phone"]);
    assert.equal(phoneOpts.rpId, "phone.example.com");
    const deskOpts = await pk.authenticationOptions(WALLET);
    assert.deepEqual(deskOpts.allowCredentials?.map((c) => c.id), ["desk"]);

    // A new tunnel/domain orphans the old phone passkey: back to the basic Telegram button.
    process.env.PUBLIC_APP_URL = "https://another-tunnel.example.com";
    assert.equal(await pk.hasPhonePasskey(WALLET), false);
    await assert.rejects(pk.authenticationOptions(WALLET, new Uint8Array(32), pk.phoneRp()!), /No passkey registered/);
  });

  test("authenticationOptions: an approval's challenge is used as-is", async () => {
    const challenge = new Uint8Array(32).fill(7);
    process.env.PUBLIC_APP_URL = "https://phone.example.com";
    const opts = await pk.authenticationOptions(WALLET, challenge, pk.phoneRp()!);
    assert.equal(opts.challenge, Buffer.from(challenge).toString("base64url"));
  });

  test("registrationOptions: existing passkeys on that domain are excluded", async () => {
    process.env.PUBLIC_APP_URL = "https://phone.example.com";
    const opts = await pk.registrationOptions(WALLET, pk.phoneRp()!, true);
    assert.equal(opts.rp.id, "phone.example.com");
    assert.deepEqual(opts.excludeCredentials?.map((c) => c.id), ["phone"]);
  });

  test("phone setup links: single-use, per wallet, expire", () => {
    const t0 = 1_000_000;
    const token = setup.createSetupToken(WALLET, t0);
    assert.equal(setup.getSetup(token, t0)!.wallet, WALLET.toLowerCase());
    assert.equal(setup.getSetup(token, t0 + setup.SETUP_TTL_MS + 1), null);
    assert.equal(setup.getSetup("nope", t0), null);
    setup.consumeSetup(token);
    assert.equal(setup.getSetup(token, t0), null);
  });

  console.log("passkey");
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
