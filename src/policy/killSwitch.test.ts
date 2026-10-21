// ─── Policy — kill switch for automatic actions (ORC-39) ───
// The global switch (admin endpoint, admin Telegram chats) and each wallet's own pause (Telegram
// /pause, the Limits sheet): while on, nothing runs on its own, refusals stay refusals, approvals
// and deposits are untouched; an unreadable flag is a pause; resuming a wallet needs the same proof
// as raising a limit; the admin routes are off without ADMIN_TOKEN and never log it.
// Run with `npm run test:kill-switch`.

import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";

process.env.TELEGRAM_BOT_TOKEN = "test-token";
const sent: { method: string; body: any }[] = [];
const stub = async (url: string, body: string) => {
  const method = String(url).split("/").pop()!;
  sent.push({ method, body: JSON.parse(body || "{}") });
  return { status: 200, text: JSON.stringify({ ok: true, result: { message_id: 7 } }) };
};

import { _setTransport, _handleUpdate, broadcastText, linkedChatIds } from "../integrations/telegram";
import { runCommand, commandOf, resumeLink, type CommandDeps } from "../integrations/telegram/commands";
import { adminToken, adminConfigWarning, isAdminAuthorization, adminChatIds, isAdminChat, MIN_ADMIN_TOKEN_LENGTH } from "../auth/admin";
import {
  loadGlobalSwitch, globalPause, globalSwitchView, setGlobalSwitch, pauseWallet, pauseFor, pauseStatus, isMemoryPaused,
  cleanReason, GLOBAL_SWITCH_KEY, _resetKillSwitch,
} from "./killSwitch";
import { decide, pauseReason, type DecisionInput } from "./index";
import { applyChange, requestConfirmation, readLimits, classifyChange, _resetLimits, LimitsError, PAUSED_NOTICE, RESUMED_NOTICE } from "./limits";
import { writeUserProfile, readUserProfile, getPolicyProfile, walletPauseOf, _resetPolicyStoreCache } from "./store";
import { assessAction, type ActionPlan } from "../intent/pipeline";
import * as storage from "../integrations/zero-g/storage";
import * as pk from "../integrations/passkey";
import { softPasskey, TEST_RP as RP } from "../integrations/passkey/softPasskey";
import { markEmailWallet } from "../integrations/passkey/emailGate";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { pauseBanner, pauseChange, PAUSE_TEXT } from "../../frontend/src/lib/pause.js";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { RULE_LABELS } from "../../frontend/src/lib/plainLanguage.js";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { RULE_HINTS } from "../../frontend/src/lib/approvalCard.js";
import { issueToken } from "../auth";
import { startBridge, wait } from "../utils/testBridge";

_setTransport(stub);
console.log = ((orig) => (...a: unknown[]) => { if (!/^\[(LocalStorage|Storage|policy|kill-switch|passkey)\]/.test(String(a[0]))) orig(...a); })(console.log);
const origError = console.error;
console.error = () => {};

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const withFault = async <T>(fault: string, fn: () => Promise<T>): Promise<T> => {
  process.env.ORCHESTRA_FAULT_INJECT = fault;
  try { return await fn(); } finally { delete process.env.ORCHESTRA_FAULT_INJECT; }
};
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e instanceof LimitsError ? e.code ?? e.status : e.message; } return "no error"; };
const signTd = (w: ethers.BaseWallet, td: any) => { const { EIP712Domain, ...types } = td.types; return w.signTypedData(td.domain, types, td.message); };
const addPasskey = async (wallet: string) => {
  const key = softPasskey();
  const o = await pk.registrationOptions(wallet, RP);
  await pk.verifyRegistration(wallet, key.register(o.challenge), { rp: RP });
  return key;
};
const notices: string[] = [];
const notify = async (_w: string, text: string) => { notices.push(text); };

const FRIEND = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
// A small send to a known address, under the limit: the one shape that runs on its own.
const autoInput = (extra: Partial<DecisionInput> = {}): DecisionInput => ({
  intentType: "send", valueUsd: 5, dailyLimitUsd: 100,
  plan: { summary: "Send 5 USDC", steps: [{ action: "send", params: { to: FRIEND, token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" } }] },
  profile: { knownAddresses: [FRIEND] }, history: [], ...extra,
});
const sendAction = (): ActionPlan => ({
  id: "a1", intentType: "send", summary: "Send 5 USDC", valueUsd: 5,
  steps: [{ action: "send", params: { to: FRIEND } } as any], params: { to: FRIEND },
  signals: { pressure: [], mentions: [], allFunds: false } as any,
});

// ── Admin settings ──

test("ADMIN_TOKEN: unset or too short means no admin access; a long one is compared exactly; the warning never has the token", async () => {
  const long = "a".repeat(MIN_ADMIN_TOKEN_LENGTH);
  assert.equal(adminToken({}), null);
  assert.equal(adminToken({ ADMIN_TOKEN: "   " }), null);
  assert.equal(adminToken({ ADMIN_TOKEN: "short-secret-123" }), null);
  const w = adminConfigWarning({ ADMIN_TOKEN: "short-secret-123" })!;
  assert.match(w, /shorter than 32/);
  assert.ok(!w.includes("short-secret-123"));
  assert.equal(adminToken({ ADMIN_TOKEN: ` ${long} ` }), long);
  assert.equal(isAdminAuthorization(`Bearer ${long}`, { ADMIN_TOKEN: long }), true);
  assert.equal(isAdminAuthorization(`Bearer ${long}x`, { ADMIN_TOKEN: long }), false);
  assert.equal(isAdminAuthorization(long, { ADMIN_TOKEN: long }), false, "needs the Bearer scheme");
  assert.equal(isAdminAuthorization(undefined, { ADMIN_TOKEN: long }), false);
  assert.equal(isAdminAuthorization(`Bearer ${long}`, {}), false, "no token configured: nothing matches");
  assert.equal(isAdminAuthorization("Bearer ", { ADMIN_TOKEN: "" }), false);
  assert.equal(adminConfigWarning({}), null);
});

test("ADMIN_CHAT_IDS: numeric chat ids (groups are negative), anything else ignored with a warning", async () => {
  const env = { ADMIN_CHAT_IDS: " 123, -100456 ,abc,," };
  assert.deepEqual([...adminChatIds(env)], [123, -100456]);
  assert.equal(isAdminChat(123, env), true);
  assert.equal(isAdminChat(999, env), false);
  assert.equal(isAdminChat(123, {}), false);
  assert.match(adminConfigWarning(env)!, /ADMIN_CHAT_IDS has 1 value/);
});

// ── Global switch ──

test("the global switch before it's read counts as paused; read with nothing stored it is off", async () => {
  _resetKillSwitch();
  assert.deepEqual(globalPause(), { scope: "global", cause: "unreadable" });
  assert.equal(globalSwitchView().on, true);
  assert.equal(await loadGlobalSwitch(), true);
  assert.equal(globalPause(), null);
  assert.deepEqual(globalSwitchView(), { on: false, unreadable: false });
});

test("on: saved, audited, survives a reload; off: saved, audited; the reason is one short line", async () => {
  _resetKillSwitch("off");
  await setGlobalSwitch(true, "admin-endpoint", cleanReason("bad price feed\nsecond line"));
  assert.deepEqual(globalPause(), { scope: "global", cause: "admin" });
  const stored: any = await storage.read(GLOBAL_SWITCH_KEY);
  assert.equal(stored.on, true);
  assert.equal(stored.reason, "bad price feed second line");
  _resetKillSwitch();
  await loadGlobalSwitch();
  assert.deepEqual(globalPause(), { scope: "global", cause: "admin" }, "a restart keeps it on");
  await setGlobalSwitch(false, "admin-telegram");
  assert.equal(globalPause(), null);
  await wait(20);
  const audit = (await storage.readMany("audit:killswitch:global")) as any[];
  assert.deepEqual(audit.slice(-2).map((r) => [r.on, r.by]), [[true, "admin-endpoint"], [false, "admin-telegram"]]);
  assert.equal(cleanReason(42), undefined);
  assert.equal(cleanReason("x".repeat(500))!.length, 200);
});

test("attack: a switch that can't be read, or a damaged record, keeps everything paused (and the bridge starts paused)", async () => {
  _resetKillSwitch("off");
  await setGlobalSwitch(false, "admin-endpoint");
  const ok = await withFault("killswitch-read", () => loadGlobalSwitch());
  assert.equal(ok, false);
  assert.deepEqual(globalPause(Date.now()), { scope: "global", cause: "unreadable" });
  assert.deepEqual(globalSwitchView(), { on: true, unreadable: true });
  await storage.write(GLOBAL_SWITCH_KEY, { on: "no" });
  assert.equal(await loadGlobalSwitch(), false);
  assert.equal(globalPause()?.cause, "unreadable");
  await storage.write(GLOBAL_SWITCH_KEY, { on: false, at: new Date().toISOString(), by: "admin-endpoint" });
  assert.equal(await loadGlobalSwitch(), true);
  assert.equal(globalPause(), null);
});

// ── What a pause does to a verdict ──

test("paused: what would run on its own needs approval, with the pause as the reason; without a pause it runs", async () => {
  assert.equal(decide(autoInput()).verdict, "AUTO_EXECUTE");
  for (const paused of [{ scope: "global", cause: "admin" }, { scope: "wallet", cause: "user" }, { scope: "global", cause: "unreadable" }, { scope: "wallet", cause: "unsaved-spend" }] as const) {
    const d = decide(autoInput({ paused }));
    assert.equal(d.verdict, "NEEDS_APPROVAL", JSON.stringify(paused));
    assert.deepEqual(d.triggered, ["auto-paused"]);
    assert.equal(d.reason, pauseReason(paused));
    assert.equal(d.approvalMethod, "passkey");
  }
  assert.match(pauseReason({ scope: "wallet", cause: "user" }), /You paused automatic actions/);
  assert.match(pauseReason({ scope: "global", cause: "admin" }), /paused for everyone/);
});

test("paused: refusals stay refusals, other reasons stay listed, read-only stays read-only, deposits stay the user's own", async () => {
  const paused = { scope: "global", cause: "admin" } as const;
  const pushy = decide(autoInput({ paused, profile: { knownAddresses: [] }, signals: { pressure: ["urgent"], mentions: [], allFunds: false } as any }));
  assert.equal(pushy.verdict, "BLOCKED", "pressure + new address is still refused, not turned into an approval");
  const over = decide(autoInput({ paused, valueUsd: 500 }));
  assert.deepEqual(over.triggered.sort(), ["auto-paused", "daily-limit"]);
  assert.equal(decide({ ...autoInput({ paused }), intentType: "balance" }).verdict, "INFO");
  const dep = assessAction({ ...sendAction(), intentType: "deposit" }, { paused });
  assert.equal(dep.approvalMethod, "wallet", "a deposit is signed in the user's own wallet, pause or not");
  assert.equal(assessAction(sendAction(), { profile: { knownAddresses: [FRIEND] }, history: [], paused }).verdict, "NEEDS_APPROVAL");
});

test("pauseFor: the global switch first, then the wallet's own pause, then an unsaved spend; nothing means it may run", async () => {
  _resetKillSwitch("off");
  const w = ethers.Wallet.createRandom().address;
  assert.equal(pauseFor(w, null), null);
  assert.deepEqual(pauseFor(w, { scope: "wallet", cause: "user" }), { scope: "wallet", cause: "user" });
  await setGlobalSwitch(true, "admin-endpoint");
  assert.deepEqual(pauseFor(w, { scope: "wallet", cause: "user" }), { scope: "global", cause: "admin" });
  assert.deepEqual(pauseFor(undefined, null), { scope: "global", cause: "admin" });
  await setGlobalSwitch(false, "admin-endpoint");
});

// ── One wallet ──

test("pause a wallet: saved as the server's own field, audited, read back as paused; again is not a change", async () => {
  _resetKillSwitch("off");
  const w = ethers.Wallet.createRandom().address;
  await writeUserProfile(w, { policy: { dailyLimitUsd: 50 } });
  assert.deepEqual(await pauseWallet(w, "telegram"), { changed: true });
  const p = await readUserProfile(w);
  assert.equal(p.autoPause.on, true);
  assert.equal(p.policy.dailyLimitUsd, 50, "the limit is kept for when it's resumed");
  assert.deepEqual((await getPolicyProfile(w)).paused, { scope: "wallet", cause: "user" });
  assert.equal((await readLimits(w)).paused, true);
  assert.deepEqual(await pauseStatus(w), { wallet: true, global: false, unreadable: false, other: false });
  assert.deepEqual(await pauseWallet(w, "web"), { changed: false });
  await wait(20);
  const audit = (await storage.readMany(`audit:killswitch:${w.toLowerCase()}`)) as any[];
  assert.equal(audit.length, 1);
  assert.equal(audit[0].by, "telegram");
});

test("attack: a damaged pause flag counts as paused, and a `paused` key in the stored policy can't unpause", async () => {
  assert.equal(walletPauseOf({}), null);
  assert.equal(walletPauseOf({ autoPause: { on: false } }), null);
  assert.deepEqual(walletPauseOf({ autoPause: { on: true } }), { scope: "wallet", cause: "user" });
  for (const bad of ["yes", 1, true, { on: "false" }, {}]) assert.deepEqual(walletPauseOf({ autoPause: bad }), { scope: "wallet", cause: "unreadable" }, JSON.stringify(bad));
  const w = ethers.Wallet.createRandom().address;
  await writeUserProfile(w, { policy: { paused: null }, autoPause: { on: true } });
  assert.deepEqual((await getPolicyProfile(w)).paused, { scope: "wallet", cause: "user" });
});

test("a pause that couldn't be saved still pauses this process, and resuming it still needs proof", async () => {
  _resetKillSwitch("off");
  const w = ethers.Wallet.createRandom();
  await writeUserProfile(w.address, {});
  _resetPolicyStoreCache();
  const err = await code(withFault("profile-read", () => pauseWallet(w.address, "telegram")));
  assert.match(String(err), /injected fault/);
  assert.equal(isMemoryPaused(w.address), true);
  assert.deepEqual(pauseFor(w.address, null), { scope: "wallet", cause: "user" });
  const c: any = await requestConfirmation(w.address, pauseChange(false), RP);
  assert.equal(c.required, true, "the stored flag says 'on', but this process is paused: proof needed");
  assert.equal(c.method, "wallet");
  await applyChange(w.address, { ...pauseChange(false), confirmation: { nonce: c.nonce, signature: await signTd(w, c.typedData) } }, RP, notify);
  assert.equal(isMemoryPaused(w.address), false);
  assert.equal(pauseFor(w.address, null), null);
});

test("Limits sheet: pausing needs nothing more than the session and tells Telegram", async () => {
  notices.length = 0;
  const w = ethers.Wallet.createRandom();
  await writeUserProfile(w.address, {});
  assert.deepEqual(await requestConfirmation(w.address, pauseChange(true), RP), { required: false });
  const r = await applyChange(w.address, pauseChange(true), RP, notify);
  assert.equal(r.paused, true);
  assert.equal(r.loosened, false);
  assert.deepEqual(notices, [PAUSED_NOTICE("the website")]);
  assert.equal(classifyChange({}, { set: {}, pauseAuto: true }, null, false), "tightening");
  assert.equal(classifyChange({}, { set: {}, pauseAuto: false }, null, true), "loosening");
  assert.equal(classifyChange({}, { set: {}, pauseAuto: false }, null, false), "tightening", "resuming what isn't paused changes nothing");
});

test("attack: resuming with the session alone is refused; with the passkey it works and Telegram is told", async () => {
  notices.length = 0;
  const w = ethers.Wallet.createRandom();
  await writeUserProfile(w.address, { autoPause: { on: true, at: new Date().toISOString(), by: "telegram" } });
  const key = await addPasskey(w.address);
  assert.equal(await code(applyChange(w.address, pauseChange(false), RP, notify)), "confirmation_required");
  assert.equal((await readLimits(w.address)).paused, true, "still paused");
  const c: any = await requestConfirmation(w.address, pauseChange(false), RP);
  assert.equal(c.method, "passkey");
  // an assertion for this resume can't be used to raise a limit instead
  const a = key.assert(c.options.challenge);
  assert.equal(await code(applyChange(w.address, { policy: { dailyLimitUsd: 900 }, confirmation: { nonce: c.nonce, response: a } }, RP, notify)), "confirmation_required");
  const c2: any = await requestConfirmation(w.address, pauseChange(false), RP);
  const r = await applyChange(w.address, { ...pauseChange(false), confirmation: { nonce: c2.nonce, response: key.assert(c2.options.challenge) } }, RP, notify);
  assert.equal(r.paused, false);
  assert.equal(r.loosened, true);
  assert.deepEqual(notices, [RESUMED_NOTICE]);
  assert.match(RESUMED_NOTICE, /send \/pause now/);
});

test("resuming without a passkey: a wallet signature for a wallet sign-in, refused for an email sign-in (the limit-raise rule)", async () => {
  const w = ethers.Wallet.createRandom();
  await writeUserProfile(w.address, { autoPause: { on: true } });
  const c: any = await requestConfirmation(w.address, pauseChange(false), RP);
  assert.equal(c.method, "wallet");
  assert.equal(c.typedData.message.automaticActions, "back on", "the signed text says what it does");
  const stranger = ethers.Wallet.createRandom();
  assert.equal(await code(applyChange(w.address, { ...pauseChange(false), confirmation: { nonce: c.nonce, signature: await signTd(stranger, c.typedData) } }, RP)), "confirmation_required");
  assert.equal((await readLimits(w.address)).paused, true, "a stranger's signature resumes nothing");
  const c2: any = await requestConfirmation(w.address, pauseChange(false), RP);
  await applyChange(w.address, { ...pauseChange(false), confirmation: { nonce: c2.nonce, signature: await signTd(w, c2.typedData) } }, RP);
  assert.equal((await readLimits(w.address)).paused, false);

  const e = ethers.Wallet.createRandom().address;
  await writeUserProfile(e, { autoPause: { on: true } });
  await markEmailWallet(e, "did:privy:pause-email");
  assert.equal(await code(requestConfirmation(e, pauseChange(false), RP)), "passkey_required");
  // Without a proof it can't be applied either (and no proof can be asked for), as for a raise.
  assert.equal(await code(applyChange(e, pauseChange(false), RP)), "confirmation_required");
  assert.equal((await readLimits(e)).paused, true);
});

test("bad input: pauseAuto must be true or false", async () => {
  const w = ethers.Wallet.createRandom().address;
  assert.equal(await code(applyChange(w, { pauseAuto: "yes" }, RP)), 400);
});

// ── Telegram ──

const fakeDeps = (over: Partial<CommandDeps> = {}): CommandDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    isAdminChat: (id) => id === 1,
    pauseWallet: async () => { calls.push("pause"); return { changed: true }; },
    status: async () => ({ wallet: true, global: false, unreadable: false, other: false }),
    globalPaused: () => false,
    setGlobal: async (on) => { calls.push(on ? "global-on" : "global-off"); },
    resumeLink: () => "https://app.example/simple?resume=1",
    ...over,
  };
};

test("Telegram: /pause works at once; an unlinked chat is told to link; other text is ignored", async () => {
  const d = fakeDeps();
  assert.match((await runCommand("/pause", 5, "0xabc", d))!.text, /Automatic actions are paused[\s\S]*\/resume/);
  assert.deepEqual(d.calls, ["pause"]);
  assert.match((await runCommand("/pause", 5, null, d))!.text, /isn't linked/);
  assert.equal(await runCommand("hello", 5, "0xabc", d), null);
  assert.equal(await runCommand("/whatever", 5, "0xabc", d), null);
  assert.equal(commandOf("/Pause@OrchestraBot now"), "/pause");
  const already = await runCommand("/pause", 5, "0xabc", fakeDeps({ pauseWallet: async () => ({ changed: false }) }));
  assert.match(already!.text, /already paused/);
  const failed = await runCommand("/pause", 5, "0xabc", fakeDeps({ pauseWallet: async () => { throw new Error("storage down"); } }));
  assert.match(failed!.text, /couldn't save it/);
  assert.ok(!failed!.text.includes("storage down"));
});

test("attack: /resume never resumes from the chat; it links to Orchestra, where the passkey is asked", async () => {
  const d = fakeDeps();
  const r = await runCommand("/resume", 5, "0xabc", d);
  assert.match(r!.text, /press Resume[\s\S]*passkey/);
  assert.deepEqual(r!.button, { text: "Open Orchestra", url: "https://app.example/simple?resume=1" });
  assert.deepEqual(d.calls, [], "nothing was changed");
  const noLink = await runCommand("/resume", 5, "0xabc", fakeDeps({ resumeLink: () => null }));
  assert.equal(noLink!.button, undefined);
  const notPaused = await runCommand("/resume", 5, "0xabc", fakeDeps({ status: async () => ({ wallet: false, global: false, unreadable: false, other: false }) }));
  assert.match(notPaused!.text, /nothing to resume/);
  const globalOnly = await runCommand("/resume", 5, "0xabc", fakeDeps({ status: async () => ({ wallet: false, global: true, unreadable: false, other: false }) }));
  assert.match(globalOnly!.text, /for everyone/);
  assert.equal(resumeLink("https://orchestra.example/some/path"), "https://orchestra.example/simple?resume=1");
  assert.equal(resumeLink(""), null);
  assert.equal(resumeLink("not a url"), null);
});

test("Telegram: /status says what is on, and an unreadable state reads as paused", async () => {
  const s = (st: any) => runCommand("/status", 5, "0xabc", fakeDeps({ status: async () => st }));
  assert.match((await s({ wallet: false, global: false, unreadable: false, other: false }))!.text, /are on/);
  assert.match((await s({ wallet: true, global: false, unreadable: false, other: false }))!.text, /You paused/);
  assert.match((await s({ wallet: false, global: true, unreadable: false, other: false }))!.text, /for everyone/);
  assert.match((await s({ wallet: false, global: true, unreadable: true, other: false }))!.text, /treating them as paused/);
  assert.match((await s({ wallet: false, global: false, unreadable: false, other: true }))!.text, /couldn't save the record/);
  const thrown = await runCommand("/status", 5, "0xabc", fakeDeps({ status: async () => { throw new Error("x"); } }));
  assert.match(thrown!.text, /treating them as paused/);
});

test("attack: /pauseall and /resumeall only from ADMIN_CHAT_IDS", async () => {
  const d = fakeDeps();
  assert.match((await runCommand("/pauseall", 99, "0xabc", d))!.text, /isn't available/);
  assert.match((await runCommand("/resumeall", 99, null, d))!.text, /isn't available/);
  assert.deepEqual(d.calls, []);
  assert.match((await runCommand("/pauseall", 1, null, d))!.text, /paused for everyone/);
  assert.match((await runCommand("/resumeall", 1, null, d))!.text, /back on for everyone/);
  assert.deepEqual(d.calls, ["global-on", "global-off"]);
  const fail = await runCommand("/resumeall", 1, null, fakeDeps({ setGlobal: async () => { throw new Error("x"); } }));
  assert.match(fail!.text, /stay paused/);
});

test("Telegram update loop: /pause in a linked chat pauses that wallet and answers; /resume answers with a button", async () => {
  _resetKillSwitch("off");
  const w = ethers.Wallet.createRandom().address.toLowerCase();
  await storage.write(`telegram:${w}`, { chatId: 4242, linkedAt: new Date().toISOString() });
  await storage.write(`telegram-chat:4242`, { wallet: w });
  await writeUserProfile(w, {});
  const handler = ({ text, chatId, wallet }: any) => runCommand(text, chatId, wallet, {
    ...fakeDeps(), pauseWallet: (x) => pauseWallet(x, "telegram"), status: (x) => pauseStatus(x),
  });
  sent.length = 0;
  await _handleUpdate({ message: { chat: { id: 4242 }, text: "/pause" } }, async () => "", handler);
  assert.equal((await readLimits(w)).paused, true);
  assert.equal(sent[0].method, "sendMessage");
  assert.match(sent[0].body.text, /Automatic actions are paused/);
  sent.length = 0;
  await _handleUpdate({ message: { chat: { id: 4242 }, text: "/resume" } }, async () => "", handler);
  assert.equal(sent[0].body.reply_markup.inline_keyboard[0][0].url, "https://app.example/simple?resume=1");
  assert.equal((await readLimits(w)).paused, true, "still paused");
});

test("global notices go to every linked chat, not to unlinked ones", async () => {
  await storage.write(`telegram-chat:5151`, { wallet: "0x0000000000000000000000000000000000005151" });
  await storage.append("telegram-chat-index", { chatId: 5151 });
  await storage.append("telegram-chat-index", { chatId: 6161 }); // unlinked since
  await storage.append("telegram-chat-index", { chatId: 5151 });
  const ids = await linkedChatIds();
  assert.ok(ids.includes(5151) && !ids.includes(6161));
  assert.equal(ids.filter((i) => i === 5151).length, 1);
  sent.length = 0;
  const n = await broadcastText("⏸ test");
  assert.equal(n, ids.length);
  assert.ok(sent.every((m) => m.body.text === "⏸ test"));
});

// ── /simple wording ──

test("/simple: the banner offers Resume only for the wallet's own pause; nothing paused, no banner", async () => {
  assert.equal(pauseBanner(null), null);
  assert.equal(pauseBanner({ wallet: false, global: false, unreadable: false, other: false }), null);
  const own = pauseBanner({ wallet: true, global: false, unreadable: false, other: false })!;
  assert.match(own.text, /You paused automatic actions/);
  assert.equal(own.resume, true);
  const all = pauseBanner({ wallet: false, global: true, unreadable: false, other: false })!;
  assert.match(all.text, /for everyone/);
  assert.equal(all.resume, false, "a pause for everyone has no button");
  const unread = pauseBanner({ wallet: false, global: true, unreadable: true, other: false })!;
  assert.match(unread.text, /can't check/);
  assert.equal(unread.resume, false);
  assert.match(pauseBanner({ wallet: false, global: false, unreadable: false, other: true })!.text, /couldn't save the record/);
  assert.deepEqual(pauseChange(true), { pauseAuto: true });
  assert.equal(PAUSE_TEXT.toggle, "Pause automatic actions");
  assert.equal(RULE_LABELS["auto-paused"], "Automatic actions paused");
  assert.ok(RULE_HINTS["auto-paused"] && RULE_HINTS.unpriced && RULE_LABELS.unpriced);
});

// ── The bridge ──

function call(port: number, method: string, path: string, auth?: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) } }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => { let b: any = {}; try { b = JSON.parse(data || "{}"); } catch { /* not JSON */ } resolve({ status: res.statusCode!, body: b, text: data }); });
    });
    req.on("error", reject); if (method !== "GET") req.write(JSON.stringify(body ?? {})); req.end();
  });
}

test("bridge without ADMIN_TOKEN: the admin routes don't exist (404) and the bridge runs as before", async () => {
  const bridge = await startBridge({ ADMIN_TOKEN: "" });
  try {
    assert.equal((await call(bridge.port, "GET", "/admin/kill-switch")).status, 404);
    assert.equal((await call(bridge.port, "POST", "/admin/kill-switch", "Bearer anything", { on: true })).status, 404);
    assert.equal((await call(bridge.port, "GET", "/health")).status, 200);
  } finally { bridge.child.kill(); }
});

test("bridge with ADMIN_TOKEN: wrong token 401, right token switches it for everyone; GET /pause shows it; the token is never logged", async () => {
  const TOKEN = "kill-switch-test-token-0123456789abcdef";
  const bridge = await startBridge({ ADMIN_TOKEN: TOKEN });
  try {
    const p = bridge.port;
    assert.equal((await call(p, "GET", "/admin/kill-switch")).status, 401);
    assert.equal((await call(p, "GET", "/admin/kill-switch", "Bearer nope")).status, 401);
    assert.deepEqual((await call(p, "GET", "/admin/kill-switch", `Bearer ${TOKEN}`)).body, { on: false, unreadable: false });
    assert.equal((await call(p, "POST", "/admin/kill-switch", `Bearer ${TOKEN}`, { on: "yes" })).status, 400);
    const on = await call(p, "POST", "/admin/kill-switch", `Bearer ${TOKEN}`, { on: true, reason: "test" });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.body.on, true);
    assert.equal(on.body.by, "admin-endpoint");
    const session = issueToken(ethers.Wallet.createRandom().address).token;
    const status = await call(p, "GET", "/pause", `Bearer ${session}`);
    assert.deepEqual(status.body, { wallet: false, global: true, unreadable: false, other: false });
    assert.equal((await call(p, "GET", "/pause")).status, 401, "needs a session");
    assert.equal((await call(p, "GET", "/admin/kill-switch", `Bearer ${session}`)).status, 401, "a wallet session isn't the admin token");
    const off = await call(p, "POST", "/admin/kill-switch", `Bearer ${TOKEN}`, { on: false });
    assert.equal(off.body.on, false);
    await wait(300);
    const log = bridge.log();
    assert.match(log, /global switch turned ON/);
    assert.match(log, /refused GET \/admin\/kill-switch/);
    assert.ok(!log.includes(TOKEN), "the admin token is never logged");
  } finally { bridge.child.kill(); }
});

test("bridge: a kill switch that can't be read at startup means it starts paused", async () => {
  const TOKEN = "kill-switch-test-token-0123456789abcdef";
  const bridge = await startBridge({ ADMIN_TOKEN: TOKEN, ORCHESTRA_FAULT_INJECT: "killswitch-read" });
  try {
    const view = await call(bridge.port, "GET", "/admin/kill-switch", `Bearer ${TOKEN}`);
    assert.deepEqual(view.body, { on: true, unreadable: true });
    await wait(200);
    assert.match(bridge.log(), /starting with automatic actions PAUSED/);
  } finally { bridge.child.kill(); }
});

(async () => {
  console.log("kill switch");
  for (const [name, fn] of tests) {
    _resetLimits();
    _resetPolicyStoreCache();
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => { origError(e); process.exit(1); });
