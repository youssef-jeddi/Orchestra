// ─── Safe — per-account agent keys and SpendingLimitModuleV2 signing (ORC-38) ───
// No network: storage is in memory, the module reads and the relay are injected.
// Run with `npm run test:agent-keys`.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { read, write } from "../zero-g/storage";
import {
  getAgentSigner, agentAddressFor, encryptionKey, agentKeyConfigProblem, AgentKeyConfigError,
  beginAgentRotation, getPendingAgentSigner, adoptAgentIfAccepted,
} from "./agentKeys";
import { execDigest, signExec, signPropose, routerCallProblem, moduleDomain, EXEC_TYPES, PROPOSE_TYPES, execMessage } from "./agentAuth";
import {
  execViaModuleV2, v2RevertError, moduleConfigProblem, PAUSED_TEXT, AGENT_MISSING_TEXT, ROUTE_REFUSED_TEXT,
  SIGNED_BATCH_TTL_SECONDS, type V2Deps, type SignedExec,
} from "./spendingModule";
import { executeForAccount, type AccountExecDeps } from "./accountExec";
import { selectProtocols } from "../uniswap/routing";
import { errorResponse } from "../ledger/errors";
import { UserFacingError } from "../../utils/userFacing";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const MODULE = "0x00000000000000000000000000000000000000C3";
const SAFE = "0x00000000000000000000000000000000000000d4";
const ROUTER = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const CHAIN = 11155111n;
const RELAYER_KEY = "0x" + "22".repeat(32);
const wallet = () => ethers.Wallet.createRandom().address;
const coder = ethers.AbiCoder.defaultAbiCoder();

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  } catch (e) { restore(); throw e; }
}

const quiet = <T>(fn: () => T): T => {
  const err = console.error, warn = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.error = err; console.warn = warn; }
};

const routerData = (commands: string, inputs: string[]) =>
  "0x3593564c" + coder.encode(["bytes", "bytes[]", "uint256"], [commands, inputs, 1_800_000_000]).slice(2);
const v3In = (to: string) => coder.encode(["address", "uint256", "uint256", "bytes", "bool"], [to, 1_000_000, 0, "0x", true]);

// ── encryption key and storage ──────────────────────────────────────────────

test("production without AGENT_KEY_ENCRYPTION_KEY refuses: no key is created or read", async () => {
  await quiet(() => withEnv({ NODE_ENV: "production", AGENT_KEY_ENCRYPTION_KEY: undefined }, async () => {
    assert.throws(() => encryptionKey(), (e: any) => e instanceof AgentKeyConfigError && e.status === 503);
    await assert.rejects(getAgentSigner(wallet(), { create: true }), AgentKeyConfigError);
    assert.match(agentKeyConfigProblem()!, /AGENT_KEY_ENCRYPTION_KEY is not set/);
  }));
});

test("a malformed AGENT_KEY_ENCRYPTION_KEY refuses everywhere, dev included", () => {
  quiet(() => {
    for (const bad of ["abc", "zz".repeat(32), "11".repeat(31)]) {
      withEnv({ AGENT_KEY_ENCRYPTION_KEY: bad, NODE_ENV: "" }, () => assert.throws(() => encryptionKey(), AgentKeyConfigError));
      withEnv({ AGENT_KEY_ENCRYPTION_KEY: bad, NODE_ENV: "production" }, () => assert.match(agentKeyConfigProblem()!, /64 hex/));
    }
  });
  withEnv({ AGENT_KEY_ENCRYPTION_KEY: "0x" + "ab".repeat(32), NODE_ENV: "production" }, () => {
    assert.equal(encryptionKey().length, 32);
    assert.equal(agentKeyConfigProblem(), null);
  });
  withEnv({ AGENT_KEY_ENCRYPTION_KEY: undefined, NODE_ENV: "" }, () => {
    assert.equal(quiet(() => encryptionKey()).length, 32, "local dev works with no configuration");
    assert.equal(agentKeyConfigProblem(), null);
  });
});

test("one key per account: created once, then the same key; none without create", async () => {
  const a = wallet(), b = wallet();
  assert.equal(await getAgentSigner(a), null);
  const first = await agentAddressFor(a);
  assert.equal((await getAgentSigner(a))!.address, first);
  assert.equal(await agentAddressFor(a), first);
  assert.notEqual(await agentAddressFor(b), first, "accounts never share a key");
});

test("concurrent first uses for one account create a single key", async () => {
  const a = wallet();
  const got = await Promise.all([1, 2, 3, 4, 5].map(() => agentAddressFor(a)));
  assert.equal(new Set(got).size, 1);
});

test("keys are encrypted at rest: no private key in storage, and a record moved to another account doesn't open", async () => {
  const a = wallet(), b = wallet();
  const signer = await getAgentSigner(a, { create: true });
  const stored = JSON.stringify(await read(`agentkey:${a.toLowerCase()}`));
  assert.ok(!stored.toLowerCase().includes(signer!.privateKey.slice(2).toLowerCase()), "plaintext key in storage");
  await write(`agentkey:${b.toLowerCase()}`, await read(`agentkey:${a.toLowerCase()}`));
  await quiet(() => assert.rejects(getAgentSigner(b), AgentKeyConfigError));
});

test("a different encryption key can't open existing keys (fails closed, never a new key)", async () => {
  const a = wallet();
  await withEnv({ AGENT_KEY_ENCRYPTION_KEY: "11".repeat(32) }, () => agentAddressFor(a));
  await quiet(() => withEnv({ AGENT_KEY_ENCRYPTION_KEY: "22".repeat(32) }, () => assert.rejects(getAgentSigner(a, { create: true }), AgentKeyConfigError)));
});

test("rotation: a successor key waits as pending and becomes current only when the module names it", async () => {
  const a = wallet();
  const current = await agentAddressFor(a);
  const next = await beginAgentRotation(a);
  assert.notEqual(next, current);
  assert.equal(await beginAgentRotation(a), next, "a second begin reuses the pending key");
  assert.equal((await getPendingAgentSigner(a))!.address, next);
  assert.equal((await getAgentSigner(a))!.address, current, "the current key stays in use until accepted");
  assert.equal(await adoptAgentIfAccepted(a, wallet()), false, "an unknown on-chain agent is never adopted");
  assert.equal(await adoptAgentIfAccepted(a, next), true);
  assert.equal((await getAgentSigner(a))!.address, next);
  assert.equal(await getPendingAgentSigner(a), null);
});

// ── EIP-712 and router rules ────────────────────────────────────────────────

test("the Exec digest matches the one pinned in the forge suite (same type strings on both sides)", () => {
  const calls = [{ to: "0x00000000000000000000000000000000000000e5", value: 1n, data: "0x" }, { to: USDC, value: 0n, data: "0xa9059cbb" }];
  assert.equal(execDigest(MODULE, CHAIN, SAFE, calls, 7n, 1_800_000_000n), "0x73b7265f510ed855c99cd65e0d4facd54a586995d44761d52990fc903cb5be47");
});

test("signatures recover to the account's key and are bound to module, chain, Safe and nonce", async () => {
  const key = ethers.Wallet.createRandom();
  const calls = [{ to: USDC, value: "0", data: "0xa9059cbb" }];
  const sig = await signExec(key, MODULE, CHAIN, SAFE, calls, 3n, 99n);
  const msg = execMessage(SAFE, calls, 3n, 99n);
  assert.equal(ethers.verifyTypedData(moduleDomain(MODULE, CHAIN), EXEC_TYPES, msg, sig), key.address);
  assert.notEqual(ethers.verifyTypedData(moduleDomain(MODULE, 1n), EXEC_TYPES, msg, sig), key.address);
  assert.notEqual(ethers.verifyTypedData(moduleDomain(SAFE, CHAIN), EXEC_TYPES, msg, sig), key.address);
  assert.notEqual(ethers.verifyTypedData(moduleDomain(MODULE, CHAIN), EXEC_TYPES, { ...msg, nonce: 4n }, sig), key.address);
  const p = await signPropose(key, MODULE, CHAIN, SAFE, MODULE, 0n, 99n);
  assert.equal(ethers.verifyTypedData(moduleDomain(MODULE, CHAIN), PROPOSE_TYPES, { safe: SAFE, newAgent: MODULE, nonce: 0n, deadline: 99n }, p), key.address);
});

test("router rules match the module: V3 swaps, wrap/unwrap, sweep/transfer/pay back to the account only", () => {
  const ok = routerData("0x0b0001040c06", [
    coder.encode(["address", "uint256"], ["0x0000000000000000000000000000000000000002", 1]),
    v3In("0x0000000000000000000000000000000000000001"),
    coder.encode(["address", "uint256", "uint256", "bytes", "bool"], [SAFE, 1, 2, "0x", true]),
    coder.encode(["address", "address", "uint256"], [USDC, SAFE, 0]),
    coder.encode(["address", "uint256"], [SAFE, 0]),
    coder.encode(["address", "address", "uint256"], [USDC, "0x0000000000000000000000000000000000000001", 10_000]),
  ]);
  assert.equal(routerCallProblem(ok, SAFE), null);
  const attacker = wallet();
  assert.match(routerCallProblem(routerData("0x00", [v3In(attacker)]), SAFE)!, /someone other/);
  assert.match(routerCallProblem(routerData("0x06", [coder.encode(["address", "address", "uint256"], [USDC, attacker, 25])]), SAFE)!, /someone other/);
  for (const cmd of ["0x10", "0x0a", "0x21", "0x08", "0x02"]) assert.match(routerCallProblem(routerData(cmd, [v3In(SAFE)]), SAFE)!, /not allowed/);
  assert.match(routerCallProblem(routerData("0x80", [v3In(SAFE)]), SAFE)!, /flags/);
  assert.match(routerCallProblem(routerData("0x0000", [v3In(SAFE)]), SAFE)!, /don't match/);
  assert.match(routerCallProblem("0xdeadbeef", SAFE)!, /selector/);
});

test("module mode routes V3 only; no module keeps V3+V4", () => {
  assert.deepEqual(selectProtocols("autonomous", true), ["V3"]);
  assert.deepEqual(selectProtocols("requires_approval", true), ["V3"]);
  assert.deepEqual(selectProtocols("autonomous", false), ["V3", "V4"]);
});

test("module config: malformed always refused, missing refused in production", () => {
  withEnv({ SPENDING_MODULE_ADDRESS: "0x12", NODE_ENV: "" }, () => assert.match(moduleConfigProblem()!, /isn't a valid address/));
  withEnv({ SPENDING_MODULE_ADDRESS: undefined, NODE_ENV: "production" }, () => assert.match(moduleConfigProblem()!, /not set/));
  withEnv({ SPENDING_MODULE_ADDRESS: undefined, NODE_ENV: "" }, () => assert.equal(moduleConfigProblem(), null));
  withEnv({ SPENDING_MODULE_ADDRESS: MODULE, NODE_ENV: "production" }, () => assert.equal(moduleConfigProblem(), null));
});

// ── execViaModuleV2: refuse before signing, sign exactly the batch, relay ───

function v2(over: Partial<V2Deps> & { agentKey?: ethers.Wallet | ethers.HDNodeWallet | null; reads?: any } = {}) {
  const agentKey = over.agentKey === undefined ? ethers.Wallet.createRandom() : over.agentKey;
  const submitted: SignedExec[] = [];
  const deps: V2Deps = {
    reads: async () => ({ paused: false, agent: agentKey?.address ?? ethers.ZeroAddress, nonce: 5n, router: ROUTER, chainId: CHAIN }),
    agentSigner: async () => agentKey,
    adopt: async () => false,
    submit: async (_m, e) => { submitted.push(e); return "0xrelayed"; },
    now: () => 1_000,
    ...over,
  };
  return { deps, submitted, agentKey };
}
const send = [{ to: "0x00000000000000000000000000000000000000e5", value: "10", data: "0x" }];
const run = (deps: V2Deps, batch = send) => withEnv({ SPENDING_MODULE_ADDRESS: MODULE }, () => execViaModuleV2(SAFE, wallet(), RELAYER_KEY, batch, undefined, deps));

test("v2: the account's key signs exactly the batch (nonce, deadline, chain, module) and the relayer submits", async () => {
  const { deps, submitted, agentKey } = v2();
  assert.equal(await run(deps), "0xrelayed");
  const e = submitted[0];
  assert.equal(e.deadline, BigInt(1_000 + SIGNED_BATCH_TTL_SECONDS));
  assert.deepEqual(e.calls, [{ to: send[0].to, value: 10n, data: "0x" }]);
  const digest = execDigest(MODULE, CHAIN, SAFE, e.calls, 5n, e.deadline);
  assert.equal(ethers.recoverAddress(digest, e.signature), agentKey!.address);
});

test("v2: paused module refuses before signing, with a plain message", async () => {
  const { deps, submitted } = v2({ reads: async () => ({ paused: true, agent: wallet(), nonce: 0n, router: ROUTER, chainId: CHAIN }) });
  await assert.rejects(run(deps), (e: any) => e instanceof UserFacingError && e.message === PAUSED_TEXT && e.status === 503);
  assert.equal(submitted.length, 0);
  assert.equal(errorResponse(new UserFacingError(PAUSED_TEXT, 503)).body.error, PAUSED_TEXT);
});

test("v2: a revoked agent or a key the module doesn't name refuses (never signs with the wrong key)", async () => {
  await quiet(async () => {
    const revoked = v2({ reads: async () => ({ paused: false, agent: ethers.ZeroAddress, nonce: 0n, router: ROUTER, chainId: CHAIN }) });
    await assert.rejects(run(revoked.deps), (e: any) => e.message === AGENT_MISSING_TEXT);
    const other = v2({ reads: async () => ({ paused: false, agent: wallet(), nonce: 0n, router: ROUTER, chainId: CHAIN }) });
    await assert.rejects(run(other.deps), (e: any) => e.message === AGENT_MISSING_TEXT);
    const none = v2({ agentKey: null, reads: async () => ({ paused: false, agent: wallet(), nonce: 0n, router: ROUTER, chainId: CHAIN }) });
    await assert.rejects(run(none.deps), (e: any) => e.message === AGENT_MISSING_TEXT);
    assert.equal(revoked.submitted.length + other.submitted.length + none.submitted.length, 0);
  });
});

test("v2: after an accepted rotation the successor key is adopted and used", async () => {
  const oldKey = ethers.Wallet.createRandom(), newKey = ethers.Wallet.createRandom();
  let current: ethers.Wallet | ethers.HDNodeWallet = oldKey;
  const { deps, submitted } = v2({
    agentKey: oldKey,
    reads: async () => ({ paused: false, agent: newKey.address, nonce: 0n, router: ROUTER, chainId: CHAIN }),
    agentSigner: async () => current,
    adopt: async (_a, onChain) => { if (onChain === newKey.address) { current = newKey; return true; } return false; },
  });
  await run(deps);
  assert.equal(ethers.recoverAddress(execDigest(MODULE, CHAIN, SAFE, submitted[0].calls, 0n, submitted[0].deadline), submitted[0].signature), newKey.address);
});

test("v2: a Uniswap route paying someone else is refused before anything is signed", async () => {
  const { deps, submitted } = v2();
  await quiet(() => assert.rejects(run(deps, [{ to: ROUTER, value: "0", data: routerData("0x00", [v3In(wallet())]) }]), (e: any) => e.message === ROUTE_REFUSED_TEXT));
  await quiet(() => assert.rejects(run(deps, [{ to: ROUTER, value: "0", data: routerData("0x10", [v3In(SAFE)]) }]), (e: any) => e.message === ROUTE_REFUSED_TEXT));
  assert.equal(submitted.length, 0);
  assert.equal(await run(deps, [{ to: ROUTER, value: "0", data: routerData("0x00", [v3In(SAFE)]) }]), "0xrelayed");
});

test("v2 reverts map to plain messages; unknown errors pass through", () => {
  assert.equal(v2RevertError({ revert: { name: "Paused" } })!.message, PAUSED_TEXT);
  assert.equal(v2RevertError({ revert: { name: "BadSignature" } })!.message, AGENT_MISSING_TEXT);
  assert.equal(v2RevertError({ errorName: "CommandNotAllowed" })!.message, ROUTE_REFUSED_TEXT);
  assert.equal(v2RevertError({ revert: { name: "StalePrice" } }), null);
});

test("the signed-in wallet reaches the module path (v2 finds the account's key with it)", async () => {
  const seen: (string | undefined)[] = [];
  const deps: AccountExecDeps = {
    gasBudget: async () => {},
    enabled: () => true,
    remainingCents: async () => 100_000n,
    viaModule: async (_s, _k, _b, _f, w) => { seen.push(w); return "0x1"; },
    viaOwner: async () => "0x2",
    offer: async () => null,
  };
  const w = wallet();
  await executeForAccount({ safeAddress: SAFE, agentKey: RELAYER_KEY, batch: send, valueUsd: 1, wallet: w }, deps);
  assert.deepEqual(seen, [w]);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e: any) { console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed${passed === tests.length ? "" : `, ${tests.length - passed} failed`}`);
})();
