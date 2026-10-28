// ─── Passkey recovery (ORC-118) ───
// Lost-authenticator replacement after email-backup login: OTP, then Telegram or 48h delay.
// Fail-closed: no grant ⇒ can't register; pending passkeys can't approve.

import assert from "node:assert/strict";
import { softPasskey, TEST_RP as RP } from "./softPasskey";

process.env.STORAGE_BACKEND = "memory";
delete process.env.PASSKEY_RP_ID;
delete process.env.PASSKEY_ORIGIN;

const W = "0xAbC0000000000000000000000000000000000099";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

(async () => {
  const pk = await import("./index");
  const recovery = await import("./recovery");
  const storage = await import("../zero-g/storage");

  /** First passkey for a non-email wallet (session only). */
  async function seedLostPasskey() {
    await storage.clear();
    await recovery._resetRecovery(W);
    const lost = softPasskey();
    const opts = await pk.registrationOptions(W, RP, true);
    await pk.verifyRegistration(W, lost.register(opts.challenge), { rp: RP, challenge: opts.challenge });
    return lost;
  }

  test("isCredActive: pendingUntil in the future is inactive; past or absent is active", () => {
    const now = 1_700_000_000_000;
    assert.equal(recovery.isCredActive({}, now), true);
    assert.equal(recovery.isCredActive({ pendingUntil: new Date(now + 1000).toISOString() }, now), false);
    assert.equal(recovery.isCredActive({ pendingUntil: new Date(now - 1000).toISOString() }, now), true);
  });

  test("recoveryOfferLabel mentions 48h only when Telegram isn't linked", () => {
    assert.match(recovery.recoveryOfferLabel(false), /48h/);
    assert.doesNotMatch(recovery.recoveryOfferLabel(true), /48h/);
    assert.match(recovery.recoveryOfferLabel(true), /Telegram/);
  });

  test("recoveryView: offered only when the account already has a passkey", () => {
    assert.equal(recovery.recoveryView(null, { telegramLinked: false, hasPasskey: false }).offered, false);
    const yes = recovery.recoveryView(null, { telegramLinked: true, hasPasskey: true });
    assert.equal(yes.offered, true);
    assert.match(yes.label, /Telegram/);
  });

  test("delay path: register as pending; can't approve until the delay ends", async () => {
    await seedLostPasskey();
    const started = await recovery.startRecovery(W, { telegramLinked: false });
    assert.equal(started.status, "granted");
    assert.equal((started as any).mode, "delay");
    assert.deepEqual(await recovery.peekRecoveryGrant(W), { mode: "delay" });

    const replacement = softPasskey();
    const opts = await pk.registrationOptions(W, RP, false, true, "delay");
    await pk.verifyRegistration(W, replacement.register(opts.challenge), { rp: RP });

    const list = await pk.listPasskeys(W);
    const pendingCred = list.find((p) => p.pendingUntil);
    assert.ok(pendingCred, "replacement stored as pending");
    assert.equal(pendingCred!.active, false);

    const challenge = Buffer.alloc(32, 7).toString("base64url");
    await assert.rejects(
      pk.verifyAuthentication(W, replacement.assert(challenge), challenge, RP),
      (e: any) => e.code === "passkey_pending",
    );

    // authenticationOptions must not offer the pending cred
    const authOpts = await pk.authenticationOptions(W, undefined, RP);
    assert.equal((authOpts.allowCredentials || []).some((c: any) => c.id === pendingCred!.id), false);

    assert.equal(recovery.isCredActive(pendingCred!, Date.parse(pendingCred!.pendingUntil!) + 1), true);
  });

  test("telegram path: awaiting → confirm → grant; cancel clears", async () => {
    await seedLostPasskey();
    const rec = await recovery.startRecovery(W, { telegramLinked: true });
    assert.equal(rec.status, "awaiting_telegram");
    assert.equal(await recovery.peekRecoveryGrant(W), null);

    const granted = await recovery.confirmRecoveryTelegram(W);
    assert.equal(granted.status, "granted");
    assert.equal((granted as any).mode, "telegram");
    assert.deepEqual(await recovery.peekRecoveryGrant(W), { mode: "telegram" });

    const replacement = softPasskey();
    const opts = await pk.registrationOptions(W, RP, false, true, "telegram");
    await pk.verifyRegistration(W, replacement.register(opts.challenge), { rp: RP });
    const list = await pk.listPasskeys(W);
    assert.equal(list.some((p) => p.pendingUntil), false, "telegram recovery is active immediately");
    assert.equal(await recovery.peekRecoveryGrant(W), null);
  });

  test("without a grant, a second passkey is still refused (fail closed)", async () => {
    await seedLostPasskey();
    const o2 = await pk.registrationOptions(W, RP, false, false);
    await assert.rejects(
      pk.verifyRegistration(W, softPasskey().register(o2.challenge), { rp: RP }),
      (e: any) => e.code === "passkey_required",
    );
  });

  test("cancel pending removes the inactive passkey without an owner check", async () => {
    await seedLostPasskey();
    await recovery.startRecovery(W, { telegramLinked: false });
    const rep = softPasskey();
    const opts = await pk.registrationOptions(W, RP, false, true, "delay");
    await pk.verifyRegistration(W, rep.register(opts.challenge), { rp: RP });
    const before = await pk.listPasskeys(W);
    const pending = before.find((p) => p.pendingUntil)!;
    assert.ok(pending);

    const { pendingCredId } = await recovery.cancelRecovery(W);
    assert.equal(pendingCredId, pending.id);
    await pk.removePendingPasskey(W, pendingCredId!);
    const after = await pk.listPasskeys(W);
    assert.equal(after.some((p) => p.id === pending.id), false);

    const active = after.find((p) => !p.pendingUntil)!;
    await assert.rejects(pk.removePendingPasskey(W, active.id), (e: any) => e.code === "passkey_required");
  });

  test("startRecovery refuses a second in-flight recovery", async () => {
    await seedLostPasskey();
    await recovery.startRecovery(W, { telegramLinked: true });
    await assert.rejects(recovery.startRecovery(W, { telegramLinked: true }), (e: any) => e.code === "recovery_awaiting_telegram");
  });

  console.log("passkey-recovery");
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
