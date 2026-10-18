// ─── Passkey — store, relying parties and phone setup links (no authenticator, in-memory storage) ───
// Run with `npm run test:passkey`.

import assert from "node:assert/strict";
import { softPasskey, TEST_RP as RP } from "./softPasskey";

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
    const token = setup.createSetupToken(WALLET, { now: t0 });
    assert.equal(setup.getSetup(token, t0)!.wallet, WALLET.toLowerCase());
    assert.equal(setup.getSetup(token, t0 + setup.SETUP_TTL_MS + 1), null);
    assert.equal(setup.getSetup("nope", t0), null);
    setup.consumeSetup(token);
    assert.equal(setup.getSetup(token, t0), null);
  });

  // ── Adding a passkey: the first needs only the session, any further one an existing passkey ──
  const NEW_WALLET = "0xAbC0000000000000000000000000000000000002";
  const mine = softPasskey();

  /** Register `key` through the desktop flow, with the owner check's flag as the server would set it. */
  const register = async (key: ReturnType<typeof softPasskey>, ownerChecked = false) => {
    const opts = await pk.registrationOptions(NEW_WALLET, RP, false, ownerChecked);
    return pk.verifyRegistration(NEW_WALLET, key.register(opts.challenge), { rp: RP });
  };
  /** An owner check passed with `key` (throws if it doesn't pass). */
  const ownerCheck = async (key: ReturnType<typeof softPasskey>) => {
    const opts = await pk.ownerCheckOptions(NEW_WALLET, RP);
    await pk.verifyOwner(NEW_WALLET, key.assert(opts.challenge), RP);
  };

  test("first passkey: the session is enough", async () => {
    await storage.clear();
    assert.equal(await pk.hasAnyPasskey(NEW_WALLET), false);
    assert.equal(await register(mine), true);
    assert.equal(await pk.hasPasskey(NEW_WALLET), true);
  });

  test("second passkey without an owner check is refused", async () => {
    await assert.rejects(register(softPasskey()), (e: any) => e.status === 403 && e.code === "passkey_required");
    assert.equal(((await storage.read(`passkey:${NEW_WALLET.toLowerCase()}`)) as any).creds.length, 1);
  });

  test("second passkey after a check with the existing one is added, and then approves", async () => {
    await ownerCheck(mine);
    const second = softPasskey();
    assert.equal(await register(second, true), true);
    const challenge = Buffer.alloc(32, 9).toString("base64url");
    assert.equal(await pk.verifyAuthentication(NEW_WALLET, second.assert(challenge), challenge, RP), true);
  });

  test("owner check: another key, no assertion, or a reused challenge doesn't pass", async () => {
    const intruder = softPasskey();
    const opts = await pk.ownerCheckOptions(NEW_WALLET, RP);
    await assert.rejects(pk.verifyOwner(NEW_WALLET, intruder.assert(opts.challenge), RP), /isn't registered/);
    await assert.rejects(pk.verifyOwner(NEW_WALLET, undefined, RP), (e: any) => e.code === "passkey_required");

    const again = await pk.ownerCheckOptions(NEW_WALLET, RP);
    const assertion = mine.assert(again.challenge);
    await pk.verifyOwner(NEW_WALLET, assertion, RP);
    await assert.rejects(pk.verifyOwner(NEW_WALLET, assertion, RP), /expired/); // single-use
  });

  test("a challenge handed out while the wallet had no passkey can't add a second one later", async () => {
    await storage.clear();
    const early = await pk.registrationOptions(NEW_WALLET, RP); // taken while the wallet had none
    const intruder = softPasskey();
    // The owner adds their first passkey with a challenge of their own (held, like the phone flow).
    const own = await pk.registrationOptions(NEW_WALLET, RP, true);
    await pk.verifyRegistration(NEW_WALLET, mine.register(own.challenge), { rp: RP, challenge: own.challenge });
    await assert.rejects(pk.verifyRegistration(NEW_WALLET, intruder.register(early.challenge), { rp: RP }), (e: any) => e.code === "passkey_required");
  });

  test("phone setup: a link asked for without an owner check can't add a second passkey", async () => {
    const opts = await pk.registrationOptions(NEW_WALLET, RP, true);
    await assert.rejects(
      pk.verifyRegistration(NEW_WALLET, softPasskey().register(opts.challenge), { rp: RP, challenge: opts.challenge, ownerChecked: false, label: "phone" }),
      (e: any) => e.code === "passkey_required");
  });

  test("owner check where none of the wallet's passkeys work says where they do", async () => {
    await assert.rejects(pk.ownerCheckOptions(NEW_WALLET, { rpID: "phone.example.com", origin: "https://phone.example.com" }),
      (e: any) => e.code === "passkey_elsewhere" && /localhost/.test(e.message));
  });

  test("Privy sign-in passkeys: imported for a wallet with none, never added next to existing ones", async () => {
    await storage.clear();
    const signIn = softPasskey();
    const cred = { id: Buffer.from(signIn.id, "base64url").toString("base64"), publicKey: signIn.publicKey, rpID: RP.rpID, source: "privy" as const };
    assert.deepEqual(await pk.addExternalCredentials(NEW_WALLET, [cred]), { held: 1, added: 1 });
    const later = softPasskey();
    const laterCred = { ...cred, id: Buffer.from(later.id, "base64url").toString("base64"), publicKey: later.publicKey };
    assert.deepEqual(await pk.addExternalCredentials(NEW_WALLET, [cred, laterCred]), { held: 1, added: 0 });
  });

  test("removing: lists without keys, removes one, never the last", async () => {
    await storage.clear();
    await register(mine);
    await ownerCheck(mine);
    const other = softPasskey();
    await register(other, true);

    const list = await pk.listPasskeys(NEW_WALLET);
    assert.deepEqual(list.map((p) => p.id).sort(), [mine.id, other.id].sort());
    assert.ok(list.every((p) => !("publicKey" in p) && !("counter" in p)));

    await assert.rejects(pk.removePasskey(NEW_WALLET, "nope"), (e: any) => e.status === 404);
    const removed = await pk.removePasskey(NEW_WALLET, other.id);
    assert.equal(removed.id, other.id);
    const challenge = Buffer.alloc(32, 3).toString("base64url");
    await assert.rejects(pk.verifyAuthentication(NEW_WALLET, other.assert(challenge), challenge, RP), /isn't registered/);

    await assert.rejects(pk.removePasskey(NEW_WALLET, mine.id), (e: any) => e.status === 409 && e.code === "last_passkey");
    assert.equal(await pk.hasPasskey(NEW_WALLET), true);
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
