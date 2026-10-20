// ─── "Add passkey" failures on /simple (frontend helpers, no browser) — ORC-110 ───
// Run with `npm run test:passkey-errors`. The error mapping and button state in
// frontend/src/lib/passkeyErrors.js, and registerPasskey (frontend/src/lib/passkey.js) driven with a
// stubbed browser and bridge: each failure ends in one plain sentence.

import assert from "node:assert/strict";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import * as pe from "../../../frontend/src/lib/passkeyErrors.js";
// @ts-expect-error plain JS helper shared with the frontend, no type declarations
import { emailStepError, passkeyStepError } from "../../../frontend/src/lib/emailPasskey.js";

const M = pe.PASSKEY_ADD_MESSAGES;
const dom = (name: string, message = "x") => Object.assign(new Error(message), { name });
// What @simplewebauthn/browser throws: a WebAuthnError with a code, named after the browser's error.
const wa = (name: string, code: string) => Object.assign(new Error("raw library text"), { name, code });
const http = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), { status, code });

let passed = 0;
let skipped = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
// registerPasskey needs @simplewebauthn/browser, a frontend dependency (cd frontend && npm install).
// Without it (e.g. a bridge-only install) those tests are skipped and say so; the mapping tests still run.
let registerPasskey: ((wallet: string) => Promise<any>) | null = null;
const SKIP = Symbol("skip");
const flowTest = (name: string, fn: () => void | Promise<void>) =>
  tests.push([name, async () => { if (!registerPasskey) throw SKIP; await fn(); }]);

const g = globalThis as any;
const realFetch = g.fetch;
function stubBrowser({ webauthn = true, platform = true as boolean | "throws", create }: { webauthn?: boolean; platform?: boolean | "throws"; create?: () => Promise<any> } = {}) {
  if (webauthn) {
    const PKC: any = function PublicKeyCredential() {};
    PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => { if (platform === "throws") throw new Error("nope"); return platform; };
    g.PublicKeyCredential = PKC;
  } else {
    delete g.PublicKeyCredential;
  }
  Object.defineProperty(g, "navigator", {
    configurable: true, value: { credentials: { create: create ?? (async () => { throw dom("NotAllowedError", "The operation either timed out or was not allowed."); }) } },
  });
  Object.defineProperty(g, "location", { configurable: true, value: { hostname: "localhost" } });
}
const calls: string[] = [];
function stubBridge(answers: Record<string, { status: number; body: any }>) {
  calls.length = 0;
  g.fetch = async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const a = answers[path] ?? { status: 404, body: { error: "not found" } };
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  };
}
const OPTIONS = {
  challenge: "AAAA", rp: { name: "Orchestra", id: "localhost" },
  user: { id: "AQID", name: "0xabc", displayName: "0xabc" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 60000, excludeCredentials: [],
};
const okBridge = {
  "/passkey/confirm-options": { status: 200, body: { required: false } },
  "/passkey/register-options": { status: 200, body: OPTIONS },
};

(async () => {
  try {
    // @ts-expect-error plain JS helper shared with the frontend, no type declarations
    ({ registerPasskey } = await import("../../../frontend/src/lib/passkey.js"));
  } catch (e: any) {
    if (!/@simplewebauthn\/browser/.test(String(e?.message))) throw e;
  }

  test("messages: plain words, a different one for cancelled vs can't create, all say what happened", () => {
    const all = Object.values(M) as string[];
    assert.equal(new Set(all).size, all.length, "each case reads differently");
    for (const m of all) {
      assert.ok(!/WebAuthn|NotAllowed|RP ID|HTTP|undefined|Error|ceremony|authenticator|credential/i.test(m), m);
      assert.ok(m.length < 200, m);
    }
    assert.match(M.cancelled, /wasn't added/);
    assert.match(M.cancelled, /try again/i);
    assert.match(M.unsupported, /wasn't added/);
    assert.match(M.unsupported, /can't create/);
    assert.match(M.failed, /couldn't add the passkey/i);
    assert.match(M.failed, /try again/i);
  });

  test("mapping: the browser's answers", () => {
    const f = pe.passkeyAddFailure;
    assert.equal(f(dom("NotAllowedError")), "cancelled", "closed or timed out, device unknown");
    assert.equal(f(dom("NotAllowedError"), { deviceAvailable: true }), "cancelled");
    assert.equal(f(dom("NotAllowedError"), { deviceAvailable: false }), "unsupported", "Chrome with nothing to make a passkey with");
    assert.equal(f(wa("NotAllowedError", "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY")), "cancelled");
    assert.equal(f(dom("AbortError")), "cancelled");
    assert.equal(f(wa("AbortError", "ERROR_CEREMONY_ABORTED")), "cancelled");
    assert.equal(f(dom("TimeoutError")), "cancelled");
    assert.equal(f(new Error("WebAuthn is not supported in this browser")), "unsupported", "@simplewebauthn's own check");
    assert.equal(f(pe.noWebAuthnError()), "unsupported");
    assert.equal(f(dom("NotSupportedError")), "unsupported");
    assert.equal(f(wa("NotSupportedError", "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG")), "unsupported");
    assert.equal(f(wa("ConstraintError", "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT")), "unsupported");
    assert.equal(f(wa("ConstraintError", "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT")), "unsupported");
    assert.equal(f(dom("InvalidStateError")), "alreadyAdded");
    assert.equal(f(wa("InvalidStateError", "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")), "alreadyAdded");
    assert.equal(f(dom("SecurityError")), "wrongSite", "PASSKEY_RP_ID is set for another web address");
    assert.equal(f(wa("SecurityError", "ERROR_INVALID_RP_ID")), "wrongSite");
    assert.equal(f(wa("SecurityError", "ERROR_INVALID_DOMAIN")), "wrongSite");
    assert.equal(f(wa("UnknownError", "ERROR_AUTHENTICATOR_GENERAL_ERROR")), "unsupported");
    assert.equal(f(new Error("Registration was not completed")), "failed");
    assert.equal(f(null), "failed");
  });

  test("mapping: our server or the network → the generic sentence, never the raw text", () => {
    for (const err of [http(500), http(400), http(403, "passkey_required"), http(401, "session_required"), http(429),
      new TypeError("Failed to fetch"), new SyntaxError("Unexpected token < in JSON")]) {
      assert.equal(pe.passkeyAddFailure(err), "failed", String(err));
      assert.equal(pe.passkeyAddError(err), M.failed);
    }
    // A server answer is never read as a browser one, whatever its name.
    assert.equal(pe.passkeyAddFailure(Object.assign(dom("NotAllowedError"), { status: 400 })), "failed");
  });

  test("device check: only asked when the browser's answer is ambiguous; never throws", async () => {
    const PKC = (v: any) => { const p: any = function () {}; p.isUserVerifyingPlatformAuthenticatorAvailable = async () => { if (v === "throws") throw new Error(); return v; }; return { PublicKeyCredential: p }; };
    assert.equal(await pe.devicePasskeyAvailable({}), false, "no WebAuthn at all");
    assert.equal(await pe.devicePasskeyAvailable(PKC(true)), true);
    assert.equal(await pe.devicePasskeyAvailable(PKC(false)), false);
    assert.equal(await pe.devicePasskeyAvailable(PKC("throws")), null);
    assert.equal(await pe.devicePasskeyAvailable({ PublicKeyCredential: function () {} }), null, "can't tell");
    assert.equal(await pe.explainPasskeyAddError(dom("NotAllowedError"), PKC(false)), M.unsupported);
    assert.equal(await pe.explainPasskeyAddError(dom("NotAllowedError"), PKC(true)), M.cancelled);
    assert.equal(await pe.explainPasskeyAddError(dom("NotAllowedError"), PKC("throws")), M.cancelled);
    assert.equal(await pe.explainPasskeyAddError(dom("InvalidStateError"), PKC(false)), M.alreadyAdded, "not ambiguous");
    assert.equal(await pe.explainPasskeyAddError(http(500), PKC(false)), M.failed);
  });

  test("button: waits while the prompt is open, back to normal after", () => {
    assert.deepEqual(pe.addPasskeyButton(false), { label: "🔑 Add passkey", disabled: false });
    assert.deepEqual(pe.addPasskeyButton(true), { label: pe.PASSKEY_ADDING_LABEL, disabled: true });
    assert.deepEqual(pe.addPasskeyButton(false, "+ Add another passkey"), { label: "+ Add another passkey", disabled: false });
    assert.match(pe.PASSKEY_ADDING_LABEL, /prompt/);
  });

  test("email and social first-passkey steps use the same sentences, keep their own email-code answers", async () => {
    assert.equal(emailStepError(http(500), "passkey"), M.failed);
    assert.equal(emailStepError(dom("NotAllowedError"), "passkey"), M.cancelled);
    assert.equal(await passkeyStepError(dom("NotAllowedError"), { PublicKeyCredential: Object.assign(function () {}, { isUserVerifyingPlatformAuthenticatorAvailable: async () => false }) }), M.unsupported);
    assert.match(await passkeyStepError(http(400, "email_verification_required")), /code in time/);
    assert.equal(await passkeyStepError(Object.assign(http(401, "email_verification_failed"), { message: "Use the same email." })), "Use the same email.");
  });

  flowTest("registerPasskey: no WebAuthn in the browser → fails before asking the server", async () => {
    stubBrowser({ webauthn: false });
    stubBridge(okBridge);
    const err = await registerPasskey!("0xabc").then(() => null, (e: any) => e);
    assert.ok(err);
    assert.deepEqual(calls, [], "no bridge call");
    assert.equal(await pe.explainPasskeyAddError(err), M.unsupported);
  });

  flowTest("registerPasskey: prompt closed on a device that can make passkeys → cancelled", async () => {
    stubBrowser({ platform: true });
    stubBridge(okBridge);
    const err = await registerPasskey!("0xabc").then(() => null, (e: any) => e);
    assert.equal(err?.name, "NotAllowedError");
    assert.deepEqual(calls, ["/passkey/confirm-options", "/passkey/register-options"]);
    assert.equal(await pe.explainPasskeyAddError(err), M.cancelled);
  });

  flowTest("registerPasskey: NotAllowedError where the device can't make a passkey → can't create", async () => {
    stubBrowser({ platform: false });
    stubBridge(okBridge);
    const err = await registerPasskey!("0xabc").then(() => null, (e: any) => e);
    assert.equal(await pe.explainPasskeyAddError(err), M.unsupported);
  });

  flowTest("registerPasskey: already registered / wrong web address", async () => {
    stubBrowser({ create: async () => { throw dom("InvalidStateError"); } });
    stubBridge(okBridge);
    assert.equal(await pe.explainPasskeyAddError(await registerPasskey!("0xabc").catch((e: any) => e)), M.alreadyAdded);
    stubBrowser({ create: async () => { throw dom("SecurityError"); } });
    Object.defineProperty(g, "location", { configurable: true, value: { hostname: "orchestra-psi-ashy.vercel.app" } });
    stubBridge({ ...okBridge, "/passkey/register-options": { status: 200, body: { ...OPTIONS, rp: { name: "Orchestra", id: "orchestra-weld.vercel.app" } } } });
    const err = await registerPasskey!("0xabc").catch((e: any) => e);
    assert.equal(err?.code, "ERROR_INVALID_RP_ID");
    assert.equal(await pe.explainPasskeyAddError(err), M.wrongSite);
  });

  flowTest("registerPasskey: the bridge fails getting options, or saving the passkey → generic", async () => {
    stubBrowser();
    stubBridge({ ...okBridge, "/passkey/register-options": { status: 500, body: { error: "boom" } } });
    let err = await registerPasskey!("0xabc").catch((e: any) => e);
    assert.equal(err?.status, 500);
    assert.equal(await pe.explainPasskeyAddError(err), M.failed);

    stubBrowser({ create: async () => ({ id: "cred", rawId: new Uint8Array([1]).buffer, type: "public-key", response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([1]).buffer, getTransports: () => [] }, getClientExtensionResults: () => ({}), authenticatorAttachment: "platform" }) });
    stubBridge({ ...okBridge, "/passkey/register": { status: 400, body: { error: "Registration verification failed" } } });
    err = await registerPasskey!("0xabc").catch((e: any) => e);
    assert.equal(err?.status, 400);
    assert.deepEqual(calls, ["/passkey/confirm-options", "/passkey/register-options", "/passkey/register"]);
    assert.equal(await pe.explainPasskeyAddError(err), M.failed);

    stubBrowser();
    g.fetch = async () => { throw new TypeError("Failed to fetch"); };
    err = await registerPasskey!("0xabc").catch((e: any) => e);
    assert.equal(await pe.explainPasskeyAddError(err), M.failed, "bridge unreachable");
  });

  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) {
      if (e === SKIP) { skipped++; console.log(`  - skipped (frontend deps not installed): ${name}`); continue; }
      console.error(`  ✗ ${name}\n`, e); g.fetch = realFetch; process.exit(1); }
  }
  g.fetch = realFetch;
  console.log(`\n${passed}/${tests.length} passed${skipped ? `, ${skipped} skipped` : ""}`);
})();
