// ─── "Add passkey" failures on /simple (frontend helpers, no browser) — ORC-110 ───
// Run with `npm run test:passkey-errors`. The error mapping and button state in
// frontend/src/lib/passkeyErrors.js, and registerPasskey (frontend/src/lib/passkey.js) driven with a
// stubbed browser and bridge: each failure ends in one plain sentence.

import assert from "node:assert/strict";
import { mock } from "node:test";
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
    for (const err of [http(500), http(400), http(403, "passkey_required"), http(401), http(429),
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

  // ── Hard limits: the button can never stay stuck (fake timers) ──
  const settle = async (until: () => boolean, max = 200) => { for (let i = 0; i < max && !until(); i++) await new Promise((r) => setImmediate(r)); };

  test("deadline: a promise that never settles is rejected as timed out after the limit, aborting first", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let aborted = false;
      let outcome: any = "pending";
      pe.withDeadline(new Promise(() => {}), pe.PASSKEY_CEREMONY_TIMEOUT_MS, () => { aborted = true; })
        .then(() => { outcome = "resolved"; }, (e: any) => { outcome = e; });
      mock.timers.tick(pe.PASSKEY_CEREMONY_TIMEOUT_MS - 1);
      await settle(() => false, 5);
      assert.equal(outcome, "pending", "not before the limit");
      mock.timers.tick(1);
      await settle(() => outcome !== "pending");
      assert.equal(aborted, true);
      assert.equal(outcome.name, "TimeoutError");
      assert.equal(pe.passkeyAddFailure(outcome), "cancelled");
      assert.equal(await pe.explainPasskeyAddError(outcome, { PublicKeyCredential: Object.assign(function () {}, { isUserVerifyingPlatformAuthenticatorAvailable: async () => false }) }), M.cancelled,
        "our own timeout is 'timed out', even on a device without built-in passkeys");
      // Settling in time: passes through, and the timer is cleared.
      assert.equal(await pe.withDeadline(Promise.resolve(7), 1000), 7);
      await assert.rejects(pe.withDeadline(Promise.reject(dom("NotAllowedError")), 1000), { name: "NotAllowedError" });
    } finally { mock.timers.reset(); }
  });

  test("messages: 'signed out' is plain and says what to do", () => {
    assert.match(M.signedOut, /signed out/);
    assert.match(M.signedOut, /wasn't added/);
    assert.match(M.signedOut, /Sign in again/);
    assert.equal(pe.passkeyAddFailure(http(401, "session_required")), "signedOut");
    assert.equal(pe.passkeyAddFailure(http(401)), "failed", "another 401 stays generic");
    assert.equal(pe.passkeyAddFailure(Object.assign(new Error("slow"), { name: "BridgeTimeoutError", network: true })), "failed");
  });

  flowTest("registerPasskey: create() never settles (no prompt ever opens) → timed out after 60 s, prompt aborted", async () => {
    let signal: AbortSignal | undefined;
    let createOptions: any;
    stubBrowser({ platform: false, create: (async (opts: any) => { createOptions = opts; signal = opts.signal; return new Promise(() => {}); }) as any });
    stubBridge(okBridge);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let outcome: any = "pending";
      registerPasskey!("0xabc").then(() => { outcome = "resolved"; }, (e: any) => { outcome = e; });
      await settle(() => !!createOptions);
      assert.ok(createOptions, "the prompt was asked for");
      assert.equal(createOptions.publicKey.timeout, pe.PASSKEY_CEREMONY_TIMEOUT_MS, "the browser is told the limit too");
      mock.timers.tick(pe.PASSKEY_CEREMONY_TIMEOUT_MS - 1);
      await settle(() => false, 5);
      assert.equal(outcome, "pending");
      mock.timers.tick(1);
      await settle(() => outcome !== "pending");
      assert.equal(outcome?.name, "TimeoutError");
      assert.equal(signal?.aborted, true, "the browser's prompt is aborted");
      assert.deepEqual(calls, ["/passkey/confirm-options", "/passkey/register-options"], "nothing sent to register");
      assert.equal(await pe.explainPasskeyAddError(outcome), M.cancelled);
    } finally { mock.timers.reset(); }
  });

  flowTest("registerPasskey: the existing-passkey check never settles either → same limit", async () => {
    let asked = false;
    Object.defineProperty(g, "navigator", { configurable: true, value: { credentials: { get: async () => { asked = true; return new Promise(() => {}); } } } });
    g.PublicKeyCredential = Object.assign(function () {}, { isUserVerifyingPlatformAuthenticatorAvailable: async () => true });
    stubBridge({ ...okBridge, "/passkey/confirm-options": { status: 200, body: { required: true, options: { challenge: "AAAA", rpId: "localhost", allowCredentials: [], timeout: 60000 } } } });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let outcome: any = "pending";
      registerPasskey!("0xabc").then(() => { outcome = "resolved"; }, (e: any) => { outcome = e; });
      await settle(() => asked);
      mock.timers.tick(pe.PASSKEY_CEREMONY_TIMEOUT_MS);
      await settle(() => outcome !== "pending");
      assert.equal(outcome?.name, "TimeoutError");
      assert.equal(await pe.explainPasskeyAddError(outcome), M.cancelled);
    } finally { mock.timers.reset(); }
  });

  flowTest("registerPasskey: a bridge call that never answers → generic error after 15 s, no prompt", async () => {
    let created = false;
    stubBrowser({ create: async () => { created = true; return new Promise(() => {}); } });
    for (const hang of ["/passkey/confirm-options", "/passkey/register-options"]) {
      calls.length = 0;
      let sawAbort = false;
      g.fetch = (url: string, init: any) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path === hang) {
          // Like a real fetch: only the abort ends it. A second variant below ignores it.
          return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => { sawAbort = true; reject(dom("AbortError", "aborted")); }));
        }
        const a = (okBridge as any)[path];
        return Promise.resolve({ ok: true, status: 200, json: async () => a.body });
      };
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        let outcome: any = "pending";
        registerPasskey!("0xabc").then(() => { outcome = "resolved"; }, (e: any) => { outcome = e; });
        await settle(() => calls.includes(hang));
        mock.timers.tick(pe.PASSKEY_FETCH_TIMEOUT_MS - 1);
        await settle(() => false, 5);
        assert.equal(outcome, "pending", hang);
        mock.timers.tick(1);
        await settle(() => outcome !== "pending");
        assert.equal(sawAbort, true, "the request is aborted");
        assert.equal(outcome?.network, true, hang);
        assert.notEqual(outcome?.name, "AbortError", "never read as the user cancelling");
        assert.equal(created, false, "no prompt after a failed call");
        assert.equal(await pe.explainPasskeyAddError(outcome), M.failed, hang);
      } finally { mock.timers.reset(); }
    }
    // A request that ignores the abort entirely still ends at the limit.
    g.fetch = () => new Promise(() => {});
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let outcome: any = "pending";
      registerPasskey!("0xabc").then(() => { outcome = "resolved"; }, (e: any) => { outcome = e; });
      await settle(() => false, 5);
      mock.timers.tick(pe.PASSKEY_FETCH_TIMEOUT_MS);
      await settle(() => outcome !== "pending");
      assert.equal(await pe.explainPasskeyAddError(outcome), M.failed);
    } finally { mock.timers.reset(); }
  });

  flowTest("registerPasskey: the bridge saving the new passkey never answers → generic error", async () => {
    stubBrowser({ create: async () => ({ id: "cred", rawId: new Uint8Array([1]).buffer, type: "public-key", response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([1]).buffer, getTransports: () => [] }, getClientExtensionResults: () => ({}), authenticatorAttachment: "platform" }) });
    calls.length = 0;
    g.fetch = (url: string, init: any) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/passkey/register") return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(dom("AbortError"))));
      return Promise.resolve({ ok: true, status: 200, json: async () => (okBridge as any)[path].body });
    };
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let outcome: any = "pending";
      registerPasskey!("0xabc").then(() => { outcome = "resolved"; }, (e: any) => { outcome = e; });
      await settle(() => calls.includes("/passkey/register"));
      mock.timers.tick(pe.PASSKEY_FETCH_TIMEOUT_MS);
      await settle(() => outcome !== "pending");
      assert.equal(await pe.explainPasskeyAddError(outcome), M.failed);
    } finally { mock.timers.reset(); }
  });

  flowTest("registerPasskey: a stale session (401 session_required) → 'sign in again', no prompt", async () => {
    let created = false;
    stubBrowser({ create: async () => { created = true; return new Promise(() => {}); } });
    stubBridge({ "/passkey/confirm-options": { status: 401, body: { error: "Sign in with your wallet first.", code: "session_required" } } });
    const err = await registerPasskey!("0xabc").catch((e: any) => e);
    assert.equal(err?.status, 401);
    assert.equal(created, false);
    assert.deepEqual(calls, ["/passkey/confirm-options"]);
    assert.equal(await pe.explainPasskeyAddError(err), M.signedOut);
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
