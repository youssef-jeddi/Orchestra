// ─── Passkey — backup sign-in for passkey-only users (ORC-58) ───
// Run with `npm run test:backup-sign-in`. Pure checks of what /simple shows: the linked sign-in
// methods, who is passkey-only, when the one-time nudge appears, and plain error sentences.

import assert from "node:assert/strict";
// @ts-expect-error plain JS helpers shared with the frontend, no type declarations
import * as b from "../../../frontend/src/lib/backupSignIn.js";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const EMBEDDED = { type: "wallet", walletClientType: "privy", address: "0x1111111111111111111111111111111111111111" };
const PASSKEY = { type: "passkey", credentialId: "abc" };
const EMAIL = { type: "email", address: "ada@example.com" };
const GOOGLE = { type: "google_oauth", email: "ada@gmail.com", subject: "123" };
const METAMASK = { type: "wallet", walletClientType: "metamask", address: "0x5879F5AcBA2BE9350f9DAD3576479c6D6d875723" };

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

test("passkey-only: a passkey and the embedded wallet, nothing else", () => {
  assert.equal(b.isPasskeyOnly([PASSKEY, EMBEDDED]), true);
  assert.equal(b.isPasskeyOnly([PASSKEY, { ...PASSKEY, credentialId: "def" }, EMBEDDED]), true, "two passkeys are still passkeys only");
  assert.equal(b.isPasskeyOnly([PASSKEY, EMBEDDED, EMAIL]), false, "an email is a backup");
  assert.equal(b.isPasskeyOnly([PASSKEY, EMBEDDED, GOOGLE]), false, "Google is a backup");
  assert.equal(b.isPasskeyOnly([PASSKEY, EMBEDDED, METAMASK]), false, "an external wallet signs in too");
  assert.equal(b.isPasskeyOnly([EMAIL, EMBEDDED]), false, "an email user isn't passkey-only");
  assert.equal(b.isPasskeyOnly([]), false);
  assert.equal(b.isPasskeyOnly(undefined), false);
});

test("linked methods: one row per method, passkeys counted, the embedded wallet left out", () => {
  assert.deepEqual(b.linkedMethods([PASSKEY, EMBEDDED]), [{ type: "passkey", name: "Passkey", detail: "" }]);
  assert.deepEqual(b.linkedMethods([PASSKEY, PASSKEY, EMBEDDED, EMAIL, GOOGLE]), [
    { type: "passkey", name: "Passkey", detail: "2 passkeys" },
    { type: "email", name: "Email", detail: "ada@example.com" },
    { type: "google_oauth", name: "Google", detail: "ada@gmail.com" },
  ]);
  assert.deepEqual(b.linkedMethods([METAMASK]), [{ type: "wallet", name: "Wallet", detail: "0x5879…5723" }]);
  assert.deepEqual(b.linkedMethods([{ type: "discord_oauth", username: "ada" }]), [{ type: "discord_oauth", name: "Discord", detail: "ada" }]);
  assert.deepEqual(b.linkedMethods(), []);
});

test("an email can be linked only while the account has none (Privy allows one)", () => {
  assert.equal(b.canLinkEmail([PASSKEY, EMBEDDED]), true);
  assert.equal(b.canLinkEmail([PASSKEY, EMBEDDED, EMAIL]), false);
  assert.equal(b.canLinkEmail([PASSKEY, GOOGLE]), true, "a Google email isn't a linked email login");
});

test("funded: any ETH, USDC or WETH in the account", () => {
  assert.equal(b.hasFunds({ eth: 0, usdc: 0, weth: 0 }), false);
  assert.equal(b.hasFunds(null), false);
  assert.equal(b.hasFunds({ eth: 0.01 }), true);
  assert.equal(b.hasFunds({ usdc: 10 }), true);
  assert.equal(b.hasFunds({ weth: 0.5 }), true);
});

test("nudge: passkey-only, money in the account, not shown before", () => {
  assert.equal(b.shouldNudge({ passkeyOnly: true, funded: true, seen: false }), true);
  assert.equal(b.shouldNudge({ passkeyOnly: true, funded: false, seen: false }), false, "not before the first deposit");
  assert.equal(b.shouldNudge({ passkeyOnly: false, funded: true, seen: false }), false, "already has a backup");
  assert.equal(b.shouldNudge({ passkeyOnly: true, funded: true, seen: true }), false, "only once");
});

test("nudge memory: per wallet, case-insensitive, survives a broken storage", () => {
  const mem = b.nudgeMemory(memStorage());
  const w = "0xAbCdEf0000000000000000000000000000000001";
  assert.equal(mem.seen(w), false);
  mem.markSeen(w);
  assert.equal(mem.seen(w.toLowerCase()), true);
  assert.equal(mem.seen("0x0000000000000000000000000000000000000002"), false, "another wallet still gets it");
  const broken = b.nudgeMemory({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
  assert.equal(broken.seen(w), false);
  assert.doesNotThrow(() => broken.markSeen(w));
});

test("link errors: plain sentences, silence when the user closes the window", () => {
  assert.equal(b.linkError("exited_link_flow"), null);
  assert.equal(b.linkError("exited_auth_flow"), null);
  assert.match(b.linkError("linked_to_another_user"), /another account/);
  assert.match(b.linkError("cannot_link_more_of_type"), /already has an email/);
  assert.match(b.linkError("disallowed_login_method"), /isn't turned on/);
  for (const code of ["linked_to_another_user", "cannot_link_more_of_type", "unknown_error", undefined]) {
    assert.ok(!/undefined|Error|HTTP|privy/i.test(b.linkError(code)), `no jargon for ${code}`);
  }
});

test("wording: the nudge and help say what the backup is for, without jargon", () => {
  for (const text of [b.NUDGE_TITLE, b.NUDGE_TEXT, b.BACKUP_HELP, b.LINKED_EMAIL_OK]) {
    assert.ok(!/\b(wallet|Safe|Privy|embedded|seed|key)\b/i.test(text), text);
  }
  assert.match(b.NUDGE_TEXT, /email/);
  assert.match(b.BACKUP_HELP, /same account/);
});

test("dev-only preview: on only for `next dev` with ?previewBackup=1, never in a built app", () => {
  assert.equal(b.backupPreviewEnabled("development", "?previewBackup=1"), true);
  assert.equal(b.backupPreviewEnabled("development", "?ownerSign=x&previewBackup=1"), true);
  for (const env of ["production", "test", undefined, ""]) {
    assert.equal(b.backupPreviewEnabled(env, "?previewBackup=1"), false, `NODE_ENV=${env}`);
  }
  assert.equal(b.backupPreviewEnabled("development", "?previewBackup=0"), false);
  assert.equal(b.backupPreviewEnabled("development", ""), false);
  assert.equal(b.backupPreviewEnabled("development", undefined), false);
  // The stand-in is a passkey-only person, so the preview shows the nudge and both add buttons.
  assert.equal(b.isPasskeyOnly(b.PREVIEW_ACCOUNTS), true);
  assert.equal(b.canLinkEmail(b.PREVIEW_ACCOUNTS), true);
  assert.equal(b.usesOwnWallet(b.PREVIEW_ACCOUNTS), false);
});

test("own wallet (MetaMask through Privy): its recovery phrase is the backup, no email offer", () => {
  assert.equal(b.usesOwnWallet([METAMASK]), true);
  assert.equal(b.usesOwnWallet([PASSKEY, EMBEDDED]), false);
  assert.equal(b.usesOwnWallet([EMBEDDED, EMAIL]), false);
  assert.equal(b.usesOwnWallet(undefined), false);
  assert.match(b.WALLET_USER_TEXT, /recovery phrase/);
  assert.doesNotMatch(b.WALLET_USER_TEXT, /email/i);
});

test("a passkey on another device: plain help and errors, and it doesn't change who counts as passkey-only", () => {
  assert.equal(b.linkError("exited_link_flow", "passkey"), null);
  assert.match(b.linkError("linked_to_another_user", "passkey"), /passkey already belongs to another account/);
  assert.match(b.linkError("whatever", "passkey"), /couldn't add that passkey/);
  assert.match(b.linkError("whatever"), /couldn't add your email/, "email stays the default");
  for (const text of [b.PASSKEY_HELP, b.LINKED_PASSKEY_OK, b.linkError("whatever", "passkey")]) {
    assert.ok(!/\b(Safe|Privy|embedded|seed|WebAuthn|credential)\b/i.test(text), text);
  }
  assert.equal(b.isPasskeyOnly([PASSKEY, { ...PASSKEY, credentialId: "laptop" }, EMBEDDED]), true, "the nudge still asks for an email");
});

(async () => {
  console.log("backup sign-in");
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
