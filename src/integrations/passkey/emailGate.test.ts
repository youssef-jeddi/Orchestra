// ─── Passkey — email sign-in rules: no passkey no funds, fresh email code for the first passkey ───
// Run with `npm run test:email-gate`. No network: in-memory storage, software passkeys, and the
// adapters are called only up to the gate (a refused call never reaches the chain).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { softPasskey, TEST_RP as RP } from "./softPasskey";

process.env.STORAGE_BACKEND = "memory";
delete process.env.PASSKEY_RP_ID;
delete process.env.PASSKEY_ORIGIN;

const addr = () => ethers.Wallet.createRandom().address;
const NOW = 1_800_000_000_000; // a fixed "now" (ms) for the pure checks
const sec = (ms: number) => Math.floor(ms / 1000);

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

(async () => {
  const gate = await import("./emailGate");
  const pk = await import("./index");
  const storage = await import("../zero-g/storage");
  const auth = await import("../../auth");
  const { importPrivyPasskeys, _setUserFetcher } = await import("../../auth/privy");
  const { getAdapter } = await import("../../executor/adapters");
  auth._setSecret("test-secret-test-secret-test-secret!");

  // A Privy user as an identity token yields it: an email last verified `agoMs` ago, plus the embedded wallet.
  const emailUser = (id: string, wallet: string, agoMs: number, extra: any[] = []) => ({
    id,
    linked_accounts: [
      { type: "email", address: "a@b.c", latest_verified_at: sec(Date.now() - agoMs) },
      { type: "wallet", address: wallet, chain_type: "ethereum", wallet_client_type: "privy", latest_verified_at: 1 },
      ...extra,
    ],
  }) as any;

  /** Register `key` as the wallet's passkey through the desktop path (options, then verify). */
  const register = async (wallet: string, key = softPasskey()) => {
    const options = await pk.registrationOptions(wallet, RP);
    return pk.verifyRegistration(wallet, key.register(options.challenge), { rp: RP });
  };
  const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code ?? e.message; } return "no error"; };

  // ── Pure decisions ──

  test("isEmailSignIn: only an email user on the Privy-created wallet, without a Privy passkey", () => {
    const w = addr();
    assert.equal(gate.isEmailSignIn(emailUser("u", w, 0), w), true);
    assert.equal(gate.isEmailSignIn(emailUser("u", w, 0), w.toLowerCase()), true);
    assert.equal(gate.isEmailSignIn(emailUser("u", w, 0, [{ type: "passkey", credential_id: "x" }]), w), false, "a passkey user has the factor already");
    assert.equal(gate.isEmailSignIn(emailUser("u", w, 0), addr()), false, "not their wallet");
    const noEmail = { id: "u", linked_accounts: [{ type: "wallet", address: w, chain_type: "ethereum", wallet_client_type: "privy" }] } as any;
    assert.equal(gate.isEmailSignIn(noEmail, w), false);
    const external = { id: "u", linked_accounts: [{ type: "email", address: "a@b.c" }, { type: "wallet", address: w, chain_type: "ethereum", wallet_client_type: "metamask" }] } as any;
    assert.equal(gate.isEmailSignIn(external, w), false, "a MetaMask wallet is never an email wallet");
  });

  test("verification age: fresh inside the window, stale after it, never in the future, missing is stale", () => {
    const win = gate.EMAIL_VERIFICATION_WINDOW_MS;
    assert.equal(gate.isFreshVerification(NOW - 1_000, NOW), true);
    assert.equal(gate.isFreshVerification(NOW - win, NOW), true);
    assert.equal(gate.isFreshVerification(NOW - win - 1_000, NOW), false);
    assert.equal(gate.isFreshVerification(NOW + 10 * 60_000, NOW), false);
    assert.equal(gate.isFreshVerification(null, NOW), false);
    assert.equal(gate.emailVerifiedAtMs({ linked_accounts: [{ type: "email", latest_verified_at: null }] } as any), null);
    assert.equal(gate.emailVerifiedAtMs({ linked_accounts: [{ type: "wallet", latest_verified_at: 1_700_000_000 }] } as any), null, "a wallet link is not a login check");
    assert.equal(gate.emailVerifiedAtMs({ linked_accounts: [{ type: "email", latest_verified_at: 1_700_000_000 }] } as any), 1_700_000_000_000);
  });

  test("passkeyGate: an email wallet without a passkey is refused; everyone else passes", () => {
    assert.equal(gate.passkeyGate({ emailWallet: true, passkeyCount: 0 }).ok, false);
    assert.equal(gate.passkeyGate({ emailWallet: true, passkeyCount: 1 }).ok, true);
    assert.equal(gate.passkeyGate({ emailWallet: false, passkeyCount: 0 }).ok, true);
    const refused = gate.passkeyGate({ emailWallet: true, passkeyCount: 0 });
    assert.ok(!refused.ok && refused.code === "passkey_required" && !/Safe/.test(refused.message));
    assert.ok(!refused.ok && !/email|code/i.test(refused.message), "wording fits social sign-ins too");
  });

  // ── No passkey, no funds ──

  test("an email wallet without a passkey can't move funds; a wallet user can", async () => {
    await storage.clear();
    const email = addr();
    const metamask = addr();
    await gate.markEmailWallet(email, "did:privy:u1");
    assert.equal(await code(pk.requirePasskeyToMoveFunds(email)), "passkey_required");
    assert.equal(await code(pk.requirePasskeyToMoveFunds(metamask)), "no error");
  });

  test("every execution is refused for it, even a small auto-executed send (the registry's execute)", async () => {
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:u2");
    const ctx = { walletAddress: email, safeAddress: addr(), balanceAddress: null, provider: {} as any, params: {}, planSummary: "", planSteps: [], totalEstimatedValueUsd: 1, balances: null };
    const built = { payload: { sendData: { unsignedTx: { to: addr(), data: "0x", value: "1" } }, quoteData: {}, lpData: {}, lpRemoveData: {} } };
    for (const kind of ["send", "swap", "add_liquidity", "remove_liquidity"]) {
      const adapter = getAdapter(kind)!;
      assert.ok(adapter.execute, `${kind} executes`);
      await assert.rejects(adapter.execute!(ctx as any, built as any), (e: any) => e.code === "passkey_required", kind);
    }
    await assert.rejects(getAdapter("send")!.execute!({ ...ctx, walletAddress: undefined } as any, built as any), /No wallet/, "no wallet, no execution");
  });

  test("an approval's execution is refused too: same call executeApproval makes, with the approval's wallet", async () => {
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:u3");
    const ctx = { walletAddress: email, safeAddress: addr(), balanceAddress: null, provider: {} as any, params: {}, planSummary: "", planSteps: [], totalEstimatedValueUsd: 50, balances: null };
    await assert.rejects(getAdapter("send")!.execute!(ctx as any, { payload: { sendData: { unsignedTx: { to: addr(), data: "0x", value: "1" } } } }), (e: any) => e.code === "passkey_required");
  });

  test("signing in again with a signed EIP-712 login doesn't clear the flag", async () => {
    const wallet = ethers.Wallet.createRandom();
    await gate.markEmailWallet(wallet.address, "did:privy:u4");
    const { nonce, typedData } = auth.loginRequest(wallet.address);
    const { EIP712Domain: _, ...types } = typedData.types as any;
    const signature = await wallet.signTypedData(typedData.domain, types, typedData.message);
    const session = auth.login(wallet.address, nonce, signature);
    assert.equal(auth.verifyToken(session.token), wallet.address.toLowerCase());
    assert.equal(await gate.isEmailWallet(wallet.address), true);
    await gate.markEmailWallet(wallet.address, "did:privy:someone-else"); // nor can marking again change whose it is
    assert.equal(await code(pk.requirePasskeyToMoveFunds(wallet.address)), "passkey_required");
    const g = await gate.grantEmailVerification(wallet.address, emailUser("did:privy:someone-else", wallet.address, 0));
    assert.deepEqual(g, { granted: false, reason: "other_user" });
  });

  test("once it holds a passkey, an email wallet moves funds like anyone", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:u5");
    assert.equal((await gate.grantEmailVerification(email, emailUser("did:privy:u5", email, 1_000))).granted, true);
    await register(email);
    assert.equal(await code(pk.requirePasskeyToMoveFunds(email)), "no error");
  });

  // ── First passkey needs a fresh email code ──

  test("ATTACK: a first passkey without a verification is refused (options and registration)", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:a1");
    assert.equal(await code(pk.registrationOptions(email, RP)), "email_verification_required");
    assert.equal(await code(pk.registrationOptions(email, RP, true)), "email_verification_required", "phone setup too");
    assert.equal(await pk.hasAnyPasskey(email), false);
  });

  test("ATTACK: skipping the options step — a verification that is gone by registration time is refused", async () => {
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:a2");
    await gate.grantEmailVerification(email, emailUser("did:privy:a2", email, 1_000));
    const key = softPasskey();
    const options = await pk.registrationOptions(email, RP); // passes: a verification is held
    gate._resetEmailGate(); // …which then expires / is spent elsewhere
    assert.equal(await code(pk.verifyRegistration(email, key.register(options.challenge), { rp: RP })), "email_verification_required");
    assert.equal(await pk.hasAnyPasskey(email), false);
  });

  test("ATTACK: a stale verification (older than the window) is refused", async () => {
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:a3");
    const stale = gate.EMAIL_VERIFICATION_WINDOW_MS + 60_000;
    assert.deepEqual(await gate.grantEmailVerification(email, emailUser("did:privy:a3", email, stale)), { granted: false, reason: "stale" });
    assert.equal(await code(pk.registrationOptions(email, RP)), "email_verification_required");
  });

  test("ATTACK: a verification that was fresh but has expired by the time it's spent is refused", async () => {
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:a4");
    const t = Date.now();
    assert.equal((await gate.grantEmailVerification(email, emailUser("did:privy:a4", email, 0), t)).granted, true);
    assert.equal(gate.hasEmailVerification(email, t + 60_000), true);
    assert.equal(gate.hasEmailVerification(email, t + gate.EMAIL_VERIFICATION_WINDOW_MS + 120_000), false);
    assert.equal(await gate.consumeEmailVerification(email, t + gate.EMAIL_VERIFICATION_WINDOW_MS + 120_000), false);
  });

  test("ATTACK: a verification from the future (clock trick) is refused", async () => {
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:a5");
    assert.deepEqual(await gate.grantEmailVerification(email, emailUser("did:privy:a5", email, -3_600_000)), { granted: false, reason: "stale" });
  });

  test("ATTACK: one verification can't be used for a second registration", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:a6");
    const user = emailUser("did:privy:a6", email, 1_000);
    assert.equal((await gate.grantEmailVerification(email, user)).granted, true);
    await register(email);
    assert.equal(await gate.consumeEmailVerification(email), false, "already spent");
    // Passkeys lost, same identity token sent again: the spent verification is remembered.
    await storage.write(`passkey:${email.toLowerCase()}`, { creds: [] });
    assert.deepEqual(await gate.grantEmailVerification(email, user), { granted: false, reason: "already_used" });
    assert.equal(await code(register(email)), "email_verification_required");
    // A genuinely newer code works again.
    assert.equal((await gate.grantEmailVerification(email, { ...user, linked_accounts: [{ type: "email", latest_verified_at: sec(Date.now()) + 2 }, ...user.linked_accounts.slice(1)] })).granted, true);
  });

  test("ATTACK: wallet A's verification can't register a passkey for wallet B", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const a = addr();
    const b = addr();
    await gate.markEmailWallet(a, "did:privy:userA");
    await gate.markEmailWallet(b, "did:privy:userB");
    assert.equal((await gate.grantEmailVerification(a, emailUser("did:privy:userA", a, 1_000))).granted, true);
    assert.deepEqual(await gate.grantEmailVerification(b, emailUser("did:privy:userA", b, 1_000)), { granted: false, reason: "other_user" });
    assert.equal(await code(pk.registrationOptions(b, RP)), "email_verification_required");
    assert.equal(await gate.consumeEmailVerification(b), false);
    assert.equal(gate.hasEmailVerification(a), true, "A's verification is untouched");
  });

  test("a wallet that isn't an email wallet gets no verification (and needs none)", async () => {
    const metamask = addr();
    assert.deepEqual(await gate.grantEmailVerification(metamask, emailUser("did:privy:z", metamask, 0)), { granted: false, reason: "not_email_wallet" });
    assert.equal(await register(metamask), true);
  });

  test("a fresh verification registers the first passkey; a further one still needs the owner check", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:ok1");
    await gate.grantEmailVerification(email, emailUser("did:privy:ok1", email, 1_000));
    assert.equal(await register(email), true);
    assert.equal(await pk.hasAnyPasskey(email), true);
    // ORC-67 stays: a second passkey without an assertion from the first is refused…
    assert.equal(await code(register(email)), "passkey_required");
    // …and the last passkey can't be removed.
    const [only] = await pk.listPasskeys(email);
    assert.equal(await code(pk.removePasskey(email, only.id)), "last_passkey");
  });

  // ── The Privy sign-in passkey import ──

  test("ATTACK: importing a Privy passkey for an email wallet without a fresh verification imports nothing", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:imp1");
    const privyKey = softPasskey();
    _setUserFetcher(async (id) => ({ id, linked_accounts: [{ type: "passkey", credential_id: privyKey.id, public_key: privyKey.publicKey }] }) as any);
    const stale = emailUser("did:privy:imp1", email, 3_600_000, [{ type: "passkey", credential_id: privyKey.id }]);
    assert.deepEqual(await importPrivyPasskeys(stale, email, RP.rpID), { held: 0, added: 0 });
    assert.equal(await pk.hasAnyPasskey(email), false);
    // The same call straight at the lowest layer, with no verification held at all.
    assert.deepEqual(await pk.addExternalCredentials(email, [{ id: privyKey.id, publicKey: privyKey.publicKey, rpID: RP.rpID, source: "privy" }]), { held: 0, added: 0 });
    assert.equal(await pk.hasAnyPasskey(email), false);
  });

  test("a Privy passkey is imported for an email wallet when the token carries a fresh email code — once", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const email = addr();
    await gate.markEmailWallet(email, "did:privy:imp2");
    const privyKey = softPasskey();
    _setUserFetcher(async (id) => ({ id, linked_accounts: [{ type: "passkey", credential_id: privyKey.id, public_key: privyKey.publicKey }] }) as any);
    const fresh = emailUser("did:privy:imp2", email, 5_000, [{ type: "passkey", credential_id: privyKey.id }]);
    assert.deepEqual(await importPrivyPasskeys(fresh, email, RP.rpID), { held: 1, added: 1 });
    assert.equal(await pk.hasAnyPasskey(email), true);
    assert.deepEqual(await gate.grantEmailVerification(email, fresh), { granted: false, reason: "already_used" });
  });


  // ── Social sign-ins follow the same rules ──

  const socialUser = (id: string, wallet: string, type: string, agoMs: number, extra: any[] = []) => ({
    id,
    linked_accounts: [
      { type, subject: "s1", email: "a@b.c", latest_verified_at: sec(Date.now() - agoMs) },
      { type: "wallet", address: wallet, chain_type: "ethereum", wallet_client_type: "privy", latest_verified_at: 1 },
      ...extra,
    ],
  }) as any;

  test("isEmbeddedSignIn: Google, Apple, X, Discord, GitHub and phone users on their Privy wallet match; a passkey or MetaMask user does not", () => {
    const w = addr();
    for (const type of ["google_oauth", "apple_oauth", "twitter_oauth", "discord_oauth", "github_oauth", "phone"]) {
      assert.equal(gate.isEmbeddedSignIn(socialUser("u", w, type, 0), w), true, type);
    }
    assert.equal(gate.isEmbeddedSignIn(socialUser("u", w, "google_oauth", 0, [{ type: "passkey", credential_id: "x" }]), w), false);
    const external = { id: "u", linked_accounts: [{ type: "google_oauth", latest_verified_at: 1 }, { type: "wallet", address: w, chain_type: "ethereum", wallet_client_type: "metamask" }] } as any;
    assert.equal(gate.isEmbeddedSignIn(external, w), false);
  });

  test("a social sign-in is flagged and refused without a passkey; MetaMask is not affected", async () => {
    await storage.clear();
    const { noteEmailSignIn } = await import("../../auth/privy");
    const google = addr();
    const metamask = addr();
    assert.equal(await noteEmailSignIn(socialUser("did:privy:g1", google, "google_oauth", 0), google), true);
    assert.equal(await code(pk.requirePasskeyToMoveFunds(google)), "passkey_required");
    const mm = { id: "did:privy:m1", linked_accounts: [{ type: "wallet", address: metamask, chain_type: "ethereum", wallet_client_type: "metamask" }] } as any;
    assert.equal(await noteEmailSignIn(mm, metamask), false);
    assert.equal(await code(pk.requirePasskeyToMoveFunds(metamask)), "no error");
  });

  test("ATTACK: a stale social re-verification is refused for the first passkey; a fresh one is accepted once", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const w = addr();
    await gate.markEmailWallet(w, "did:privy:g2");
    assert.deepEqual(await gate.grantEmailVerification(w, socialUser("did:privy:g2", w, "google_oauth", 30 * 60_000)), { granted: false, reason: "stale" });
    assert.equal(await code(register(w)), "email_verification_required");
    assert.equal((await gate.grantEmailVerification(w, socialUser("did:privy:g2", w, "google_oauth", 2_000))).granted, true);
    await register(w);
    assert.equal(await pk.hasAnyPasskey(w), true);
    assert.equal((await gate.grantEmailVerification(w, socialUser("did:privy:g2", w, "google_oauth", 2_000))).granted, false, "spent");
  });

  test("ATTACK: a social login for another Privy user can't verify this wallet", async () => {
    const w = addr();
    await gate.markEmailWallet(w, "did:privy:g3");
    assert.deepEqual(await gate.grantEmailVerification(w, socialUser("did:privy:other", w, "google_oauth", 0)), { granted: false, reason: "other_user" });
  });

  // ── An embedded wallet that only signs in by wallet signature ──

  test("ATTACK: a Privy embedded wallet that signs in by EIP-712 only is recognised through Privy and gated", async () => {
    await storage.clear();
    const embedded = ethers.Wallet.createRandom();
    const calls: string[] = [];
    gate._setWalletLookup(async (a) => { calls.push(a); return socialUser("did:privy:e1", embedded.address, "google_oauth", 0); });
    const { nonce, typedData } = auth.loginRequest(embedded.address);
    const { EIP712Domain: _, ...types } = typedData.types as any;
    auth.login(embedded.address, nonce, await embedded.signTypedData(typedData.domain, types, typedData.message));
    assert.equal(await code(pk.requirePasskeyToMoveFunds(embedded.address)), "passkey_required");
    assert.equal(await code(getAdapter("send")!.execute!({ walletAddress: embedded.address, safeAddress: addr(), params: {}, planSteps: [], totalEstimatedValueUsd: 1 } as any, { payload: { sendData: { unsignedTx: { to: addr(), data: "0x", value: "1" } } } } as any)), "passkey_required");
    // recognised once, then flagged for good (and bound to that Privy user)
    gate._setWalletLookup(null);
    assert.equal(await gate.isEmailWallet(embedded.address), true);
    assert.deepEqual(await gate.grantEmailVerification(embedded.address, socialUser("did:privy:x", embedded.address, "google_oauth", 0)), { granted: false, reason: "other_user" });
    assert.equal(calls.length, 1);
  });

  test("an external wallet (MetaMask) is not gated by the lookup, and the answer is remembered", async () => {
    await storage.clear();
    const mm = addr();
    let n = 0;
    gate._setWalletLookup(async () => { n++; return { id: "did:privy:m2", linked_accounts: [{ type: "wallet", address: mm, chain_type: "ethereum", wallet_client_type: "metamask" }] } as any; });
    assert.equal(await code(pk.requirePasskeyToMoveFunds(mm)), "no error");
    assert.equal(await code(pk.requirePasskeyToMoveFunds(mm)), "no error");
    assert.equal(n, 1, "not asked again");
    const unknown = addr();
    gate._setWalletLookup(async () => null);
    assert.equal(await code(pk.requirePasskeyToMoveFunds(unknown)), "no error", "Privy doesn't know the address");
  });

  test("fail closed: if Privy can't be asked, funds don't move for an unflagged wallet", async () => {
    await storage.clear();
    gate._setWalletLookup(async () => { throw new Error("Privy is down"); });
    const w = addr();
    await assert.rejects(pk.requirePasskeyToMoveFunds(w), /Privy is down/);
    gate._setWalletLookup(async () => null);
    assert.equal(await code(pk.requirePasskeyToMoveFunds(w)), "no error", "an error is not remembered as 'external'");
    gate._setWalletLookup(null);
  });


  // ── Top-up: the one thing a passkey-gated wallet may sign itself ──

  const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
  const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
  const erc20 = new ethers.Interface(["function transfer(address,uint256)", "function approve(address,uint256)", "function transferFrom(address,address,uint256)"]);
  const depositCtx = (wallet: string, safe: string, params: any) => ({ walletAddress: wallet, safeAddress: safe, balanceAddress: safe, provider: {} as any, params, planSummary: "", planSteps: [], totalEstimatedValueUsd: 1, balances: null }) as any;

  test("a passkey-gated social/email wallet with a passkey can top up its own account (ETH and USDC) through the deposit path", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const wallet = addr();
    const safe = addr();
    await gate.markEmailWallet(wallet, "did:privy:t1");
    assert.equal(await code(pk.requirePasskeyToMoveFunds(wallet)), "passkey_required", "no passkey, no top-up either");
    assert.equal((await gate.grantEmailVerification(wallet, socialUser("did:privy:t1", wallet, "google_oauth", 1_000))).granted, true);
    await register(wallet);
    assert.equal(await code(pk.requirePasskeyToMoveFunds(wallet)), "no error");
    const deposit = getAdapter("deposit")!;
    const eth = await deposit.build(depositCtx(wallet, safe, { symbol: "ETH", amount: "0.01" }));
    assert.equal((eth.payload as any).depositData.unsignedTx.to, safe);
    const usdc = await deposit.build(depositCtx(wallet, safe, { symbol: "USDC", amount: "5", token: USDC }));
    const tx = (usdc.payload as any).depositData.unsignedTx;
    assert.equal(tx.to, USDC);
    assert.equal(erc20.parseTransaction({ data: tx.data })!.args[0], safe);
    assert.equal(deposit.execute, undefined, "the server never moves the user's own wallet funds");
  });

  test("an outgoing send from that wallet is still refused (passkey_required) while it has no passkey; the deposit adapter can't be used to send", async () => {
    const wallet = addr();
    await gate.markEmailWallet(wallet, "did:privy:t2");
    const send = getAdapter("send")!;
    await assert.rejects(send.execute!(depositCtx(wallet, addr(), {}), { payload: { sendData: { unsignedTx: { to: addr(), data: "0x", value: "1" } } } } as any), (e: any) => e.code === "passkey_required");
    // a deposit asked to go to someone else still goes to the account (the recipient is not a parameter)
    const safe = addr();
    const thief = addr();
    const built = await getAdapter("deposit")!.build(depositCtx(wallet, safe, { symbol: "ETH", amount: "1", to: thief }));
    assert.equal((built.payload as any).depositData.unsignedTx.to, safe);
    assert.ok(!JSON.stringify(built).toLowerCase().includes(thief.toLowerCase()));
  });

  test("ATTACK: a 'top-up' whose recipient isn't the user's own account is refused", async () => {
    const { isTopUpToOwnAccount: ok } = await import("../../executor/topUp");
    const safe = addr();
    const thief = addr();
    const t = (to: string, data = "0x", value = "0") => ({ to, data, value });
    assert.equal(ok(t(safe, "0x", "5"), safe), true);
    assert.equal(ok(t(USDC, erc20.encodeFunctionData("transfer", [safe, 5n])), safe), true);
    assert.equal(ok(t(WETH, erc20.encodeFunctionData("transfer", [safe, 5n])), safe), true);
    assert.equal(ok(t(thief, "0x", "5"), safe), false, "ETH to a third party");
    assert.equal(ok(t(USDC, erc20.encodeFunctionData("transfer", [thief, 5n])), safe), false, "token transfer to a third party");
    assert.equal(ok(t(USDC, erc20.encodeFunctionData("approve", [thief, 5n])), safe), false, "approve");
    assert.equal(ok(t(USDC, erc20.encodeFunctionData("approve", [safe, 5n])), safe), false, "approve even to the account");
    assert.equal(ok(t(USDC, erc20.encodeFunctionData("transferFrom", [addr(), safe, 5n])), safe), false, "transferFrom");
    assert.equal(ok(t(addr(), erc20.encodeFunctionData("transfer", [safe, 5n])), safe), false, "unsupported token");
    assert.equal(ok(t(USDC, erc20.encodeFunctionData("transfer", [safe, 5n]) + "00", "0"), safe), false, "extra bytes");
    assert.equal(ok(t(USDC, erc20.encodeFunctionData("transfer", [safe, 5n]), "1"), safe), false, "token transfer carrying ETH");
    assert.equal(ok(t(safe, "0xa9059cbb", "0"), safe), false, "a call into the account");
    assert.equal(ok(t(safe), "not-an-address"), false);
    // a send whose params are crafted to look like a deposit: the adapter refuses an unsupported token
    const bad = await getAdapter("deposit")!.build(depositCtx(addr(), safe, { symbol: "XYZ", amount: "1", token: thief }));
    assert.ok(bad.refusal && !bad.payload);
  });


  // ── Social first passkey: the same provider account, signed in again ──

  const googleUser = (id: string, wallet: string, subject: string, agoMs: number, extra: any[] = []) => ({
    id,
    linked_accounts: [
      { type: "google_oauth", subject, email: "a@b.c", latest_verified_at: sec(Date.now() - agoMs) },
      { type: "wallet", address: wallet, chain_type: "ethereum", wallet_client_type: "privy", latest_verified_at: 1 },
      ...extra,
    ],
  }) as any;

  test("social: signing in again with the same Google account is accepted for the first passkey, once", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const { noteEmailSignIn } = await import("../../auth/privy");
    const w = addr();
    assert.equal(await noteEmailSignIn(googleUser("did:privy:s1", w, "g-111", 3_600_000), w), true);
    assert.deepEqual(await gate.verificationAccountTypes(w), ["google_oauth"]);
    assert.equal((await gate.grantEmailVerification(w, googleUser("did:privy:s1", w, "g-111", 2_000))).granted, true);
    await register(w);
    assert.equal(await pk.hasAnyPasskey(w), true);
  });

  test("ATTACK (social): a stale sign-in is refused", async () => {
    const w = addr();
    await gate.markEmailWallet(w, "did:privy:s2", gate.loginAccountKeys(googleUser("did:privy:s2", w, "g-222", 0)));
    assert.deepEqual(await gate.grantEmailVerification(w, googleUser("did:privy:s2", w, "g-222", gate.EMAIL_VERIFICATION_WINDOW_MS + 60_000)), { granted: false, reason: "stale" });
  });

  test("ATTACK (social): another Privy user's fresh sign-in is refused", async () => {
    const w = addr();
    await gate.markEmailWallet(w, "did:privy:s3", gate.loginAccountKeys(googleUser("did:privy:s3", w, "g-333", 0)));
    assert.deepEqual(await gate.grantEmailVerification(w, googleUser("did:privy:intruder", w, "g-333", 0)), { granted: false, reason: "other_user" });
  });

  test("ATTACK (social): a different Google account linked later can't supply the proof, however fresh", async () => {
    const w = addr();
    await gate.markEmailWallet(w, "did:privy:s4", gate.loginAccountKeys(googleUser("did:privy:s4", w, "g-444", 0)));
    const linkedLater = { type: "google_oauth", subject: "g-EVIL", email: "x@y.z", latest_verified_at: sec(Date.now() - 1_000) };
    const user = googleUser("did:privy:s4", w, "g-444", 3_600_000, [linkedLater]); // the original is old, the new one fresh
    assert.deepEqual(await gate.grantEmailVerification(w, user), { granted: false, reason: "other_account" });
    assert.equal(gate.hasEmailVerification(w), false);
    assert.equal(await code(register(w)), "email_verification_required");
    // the original account signing in again is still what works
    assert.equal((await gate.grantEmailVerification(w, googleUser("did:privy:s4", w, "g-444", 1_000, [linkedLater]))).granted, true);
  });

  test("ATTACK (social): the same sign-in can't be used twice", async () => {
    await storage.clear();
    gate._resetEmailGate();
    const w = addr();
    await gate.markEmailWallet(w, "did:privy:s5", gate.loginAccountKeys(googleUser("did:privy:s5", w, "g-555", 0)));
    const proof = googleUser("did:privy:s5", w, "g-555", 2_000);
    assert.equal((await gate.grantEmailVerification(w, proof)).granted, true);
    await register(w);
    assert.deepEqual(await gate.grantEmailVerification(w, proof), { granted: false, reason: "already_used" });
  });

  test("an email user keeps the email path; a user with both can verify with either of the accounts they had", async () => {
    const w = addr();
    const both = (agoEmail: number, agoGoogle: number) => ({ id: "did:privy:s6", linked_accounts: [
      { type: "email", address: "a@b.c", latest_verified_at: sec(Date.now() - agoEmail) },
      { type: "google_oauth", subject: "g-666", latest_verified_at: sec(Date.now() - agoGoogle) },
      { type: "wallet", address: w, chain_type: "ethereum", wallet_client_type: "privy" },
    ] }) as any;
    await gate.markEmailWallet(w, "did:privy:s6", gate.loginAccountKeys(both(0, 0)));
    assert.deepEqual(await gate.verificationAccountTypes(w), ["email", "google_oauth"]);
    assert.equal((await gate.grantEmailVerification(w, both(1_000, 3_600_000))).granted, true);
  });

  console.log("email gate");
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
