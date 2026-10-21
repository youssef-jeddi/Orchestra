// ─── Safe — the on-chain $1000/day cap (SpendingLimitModule v1 and v2) ───
// When SPENDING_MODULE_ADDRESS is set, the agent is not an owner of new accounts: it moves funds
// only through the module, Call-only (no MultiSend / DelegateCall).
// - v1 (ORC-107): one shared agent key (AGENT_PRIVATE_KEY) calls exec(safe, calls[]).
// - v2 (ORC-38): each account has its own agent key (agentKeys.ts); it signs an EIP-712 Exec and the
//   shared key only relays it and pays gas (execSigned). Which one runs is read from the chain
//   (VERSION()), so switching the env value to a v2 module is the whole switch.
// A malformed SPENDING_MODULE_ADDRESS refuses everything (never a silent fallback to the owner path);
// unset keeps the old owner path for local dev only (new accounts are refused in production, deploy.ts).
// Owner-sign fallback for an over-cap request is in ownerSign.ts (owner may still use MultiSend).

import { ethers } from "ethers";
import Safe from "@safe-global/protocol-kit";
import { UserFacingError, OverCapError } from "../../utils/userFacing";
import { makeSepoliaProvider, sepoliaRpcUrl } from "../../utils/rpc";
import { safeErr } from "../../utils/redact";
import { safeGasLimit } from "./transaction";
import { faultOn } from "../../utils/faultInject";
import { getAgentSigner, adoptAgentIfAccepted } from "./agentKeys";
import { signExec, routerCallProblem, type ModuleCall } from "./agentAuth";

export const SPENDING_MODULE_ABI = [
  "function exec(address safe, (address to, uint256 value, bytes data)[] calls)",
  "function remainingToday(address safe) view returns (uint256)",
  "function spentToday(address safe) view returns (uint256)",
  "function DAILY_LIMIT_CENTS() view returns (uint256)",
  "error DailyLimitExceeded(uint256 spentCents, uint256 wouldSpendCents, uint256 limitCents)",
  "error ExecFailed()",
  "error TargetNotAllowed()",
  "error SelectorNotAllowed()",
  "error BadSpender()",
  "error BadRecipient()",
  "error BadToken()",
  "error BlockedTarget()",
  "error StalePrice()",
  "error BadPrice()",
  "error EmptyBatch()",
];

/** SpendingLimitModuleV2 additions (ORC-38): per-account agents, signed batches, global pause. */
export const SPENDING_MODULE_V2_ABI = [
  ...SPENDING_MODULE_ABI.filter((f) => !f.startsWith("function exec(")),
  "function VERSION() view returns (uint256)",
  "function setupHelper() view returns (address)",
  "function universalRouter() view returns (address)",
  "function paused() view returns (bool)",
  "function agentOf(address safe) view returns (address)",
  "function nonces(address safe) view returns (uint256)",
  "function execSigned(address safe, (address to, uint256 value, bytes data)[] calls, uint256 deadline, bytes signature)",
  "function proposeAgentSigned(address safe, address newAgent, uint256 deadline, bytes signature)",
  "function acceptAgent(address safe)",
  "function pendingAgentOf(address safe) view returns (address agent, uint64 readyAt)",
  "error Paused()",
  "error Expired()",
  "error NoAgent()",
  "error BadSignature()",
  "error CommandNotAllowed(uint8 command)",
  "error NoPendingAgent()",
  "error TooEarly(uint256 readyAt)",
  "error Reentrancy()",
  "error NestedMulticall()",
];

/** The module's fixed daily ceiling, for wording only; the contract is what enforces it. */
export const DAILY_CAP_USD = 1000;

/** Safe operation codes (owner-sign path only; the module never DelegateCalls). */
export const OPERATION = { Call: 0, DelegateCall: 1 } as const;

/** SPENDING_MODULE_ADDRESS is set but isn't an address: refuse rather than guess. */
export class ModuleConfigError extends UserFacingError {
  readonly code = "module_misconfigured";
  constructor(detail: string) {
    super("Automatic actions aren't available right now, so nothing was sent. Please try again later.", 503);
    console.error(`[safe] ${detail}`);
  }
}

/** The configured module (checksummed), or null when unset. A malformed value throws: never a silent "unset". */
export function spendingModuleAddress(): string | null {
  const raw = process.env.SPENDING_MODULE_ADDRESS?.trim();
  if (!raw) return null;
  if (!ethers.isAddress(raw)) throw new ModuleConfigError("SPENDING_MODULE_ADDRESS is set but isn't a valid address; refusing to act until it's fixed.");
  return ethers.getAddress(raw);
}

/**
 * Does this server run the on-chain cap? Any non-empty value counts, malformed included, so a typo
 * can never fall back to the agent-as-owner path (the address read then refuses).
 */
export function isSpendingModuleEnabled(): boolean {
  return !!process.env.SPENDING_MODULE_ADDRESS?.trim();
}

/** Startup problem with the module setting, or null. Production must name a valid module. */
export function moduleConfigProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SPENDING_MODULE_ADDRESS?.trim();
  if (raw && !ethers.isAddress(raw)) return "SPENDING_MODULE_ADDRESS is set but isn't a valid address: every on-chain action is refused until it's fixed.";
  if (!raw && env.NODE_ENV === "production") return "SPENDING_MODULE_ADDRESS is not set: new accounts are refused in production (there is no agent-as-owner fallback any more).";
  return null;
}

const versions = new Map<string, number>();

/**
 * 2 for SpendingLimitModuleV2, 1 for the original module (no VERSION(): the call reverts).
 * A network failure throws, so a wrong guess can never pick the setup or signing path.
 */
export async function moduleVersion(address: string, provider: ethers.ContractRunner = makeSepoliaProvider()): Promise<number> {
  const key = address.toLowerCase();
  const known = versions.get(key);
  if (known) return known;
  let version: number;
  try {
    version = Number(await new ethers.Contract(address, SPENDING_MODULE_V2_ABI, provider).VERSION());
  } catch (err: any) {
    if (err?.code !== "CALL_EXCEPTION" && err?.code !== "BAD_DATA") throw err;
    version = 1;
  }
  versions.set(key, version);
  return version;
}

/** Test hook: forget detected module versions. */
export function _resetModuleVersions(): void {
  versions.clear();
}

/** What the user reads when a request would go past the on-chain daily ceiling. */
export const OVER_CAP_TEXT =
  `Your account's on-chain daily ceiling is $${DAILY_CAP_USD}, and this would go over what's left today. ` +
  "You can sign this yourself with your wallet as the account owner, or try again after the daily reset.";

/** Same limit, when signing it yourself isn't available for this session. */
export const OVER_CAP_NO_OWNER_TEXT =
  `Your account's on-chain daily ceiling is $${DAILY_CAP_USD}, and this would go over what's left today. ` +
  "Try a smaller amount, or try again after the daily reset.";

export { OverCapError };

/** The module reverted with DailyLimitExceeded (the real spend went past the ceiling). */
export class DailyCapRevert extends Error {}

/** Tolerance on the USD estimate: the contract measures the real outflow, this is only the early check. */
const ESTIMATE_TOLERANCE_PERCENT = 1n;

/**
 * Would a request worth `valueUsd` go past what's left of today's ceiling (`remainingCents`)?
 * Pure; an unreadable amount fails closed (counts as over).
 */
export function exceedsRemaining(valueUsd: number, remainingCents: bigint): boolean {
  if (!Number.isFinite(valueUsd) || valueUsd < 0) return true;
  const cents = BigInt(Math.ceil(valueUsd * 100));
  const allowed = remainingCents + (remainingCents * ESTIMATE_TOLERANCE_PERCENT) / 100n;
  return cents > allowed;
}

/** Cents the account can still spend today through the module. */
export async function remainingToday(safeAddress: string, provider: ethers.ContractRunner = makeSepoliaProvider()): Promise<bigint> {
  // Dev-only: pretend nothing is left today so the over-cap path can be exercised without funding.
  if (faultOn("remaining-zero")) return 0n;
  const module = new ethers.Contract(spendingModuleAddress()!, SPENDING_MODULE_ABI, provider);
  return BigInt(await module.remainingToday(safeAddress));
}

export interface SafeCall {
  to: string;
  value: string;
  data: string;
  operation: number;
}

/**
 * Encode a batch the way the Safe owner path would (including MultiSend for several steps).
 * Used only for the owner-sign fallback — the module path never DelegateCalls.
 */
export async function safeCallFor(safeAddress: string, transactions: Array<{ to: string; value: string; data: string }>): Promise<SafeCall & { nonce: number }> {
  const safe = await Safe.init({ provider: sepoliaRpcUrl(), safeAddress });
  const tx = await safe.createTransaction({ transactions });
  const d = tx.data;
  return { to: d.to, value: String(d.value), data: d.data, operation: Number(d.operation), nonce: Number(d.nonce) };
}

/** Did this error come from the module's DailyLimitExceeded revert? */
export function isDailyCapRevert(err: any): boolean {
  return revertName(err) === "DailyLimitExceeded";
}

/** The module's custom error name in an ethers error, if any. */
export function revertName(err: any): string | undefined {
  return err?.revert?.name ?? err?.errorName ?? undefined;
}

/** What the user reads when the guardian or admin has paused the module for everyone. */
export const PAUSED_TEXT =
  "Automatic actions are paused for everyone right now as a safety measure. Nothing was sent and your funds stay in your account. Please try again later.";

/** The account's agent key was revoked, or doesn't match what the account expects. */
export const AGENT_MISSING_TEXT =
  "Automatic actions are switched off for your account right now, so nothing was sent. Your funds stay in your account.";

/** A Uniswap route the account's on-chain rules would refuse. */
export const ROUTE_REFUSED_TEXT =
  "Uniswap suggested a route your account's safety rules don't allow, so nothing was sent. Please try again in a moment.";

/** Plain errors for the v2 module's refusals; anything else is passed through unchanged. */
export function v2RevertError(err: any): Error | null {
  switch (revertName(err)) {
    case "Paused": return new UserFacingError(PAUSED_TEXT, 503);
    case "NoAgent":
    case "BadSignature": return new UserFacingError(AGENT_MISSING_TEXT, 409);
    case "CommandNotAllowed": return new UserFacingError(ROUTE_REFUSED_TEXT, 422);
    default: return null;
  }
}

/**
 * Run a batch through SpendingLimitModule.exec(safe, calls[]) with the agent key.
 * Each step is a Call checked by the module; no MultiSend. A DailyLimitExceeded revert
 * throws DailyCapRevert.
 */
export async function execViaModule(
  safeAddress: string,
  agentPrivateKey: string,
  transactions: Array<{ to: string; value: string; data: string }>,
  fallbackGasLimit?: string,
): Promise<string> {
  const calls = transactions.map((t) => ({
    to: t.to,
    value: t.value ?? "0",
    data: t.data && t.data !== "" ? t.data : "0x",
  }));
  const wallet = new ethers.Wallet(agentPrivateKey, makeSepoliaProvider());
  const module = new ethers.Contract(spendingModuleAddress()!, SPENDING_MODULE_ABI, wallet);
  const args = [safeAddress, calls] as const;

  let capRevert = false;
  let gasLimit: string | undefined;
  try {
    gasLimit = await safeGasLimit(async () => {
      try {
        return await module.exec.estimateGas(...args);
      } catch (err: any) {
        if (isDailyCapRevert(err)) capRevert = true;
        throw err;
      }
    }, fallbackGasLimit);
  } catch (err) {
    if (capRevert) throw new DailyCapRevert("DailyLimitExceeded");
    throw err;
  }

  const tx = await module.exec(...args, gasLimit ? { gasLimit } : {});
  const receipt = await tx.wait();
  if (receipt && Number(receipt.status) === 0) {
    console.error(`[safe] module transaction reverted on-chain: ${tx.hash}`);
    throw new UserFacingError(`This didn't go through, so your funds were not moved. You can see what happened here: https://sepolia.etherscan.io/tx/${tx.hash}`);
  }
  return tx.hash;
}

/** How long a signed batch stays valid: long enough to confirm, short enough to be useless later. */
export const SIGNED_BATCH_TTL_SECONDS = 15 * 60;

/** What execViaModuleV2 reads from the module before signing. */
export interface V2Reads { paused: boolean; agent: string; nonce: bigint; router: string; chainId: bigint }

export interface SignedExec { safe: string; calls: Array<{ to: string; value: bigint; data: string }>; deadline: bigint; signature: string }

export interface V2Deps {
  reads: (module: string, safe: string) => Promise<V2Reads>;
  /** The account's agent signer (its wallet), or null when it has none. */
  agentSigner: (account: string) => Promise<ethers.Signer | null>;
  adopt: (account: string, onChainAgent: string) => Promise<boolean>;
  /** Relay the signed batch with the shared key and wait for it; returns the tx hash. */
  submit: (module: string, exec: SignedExec, relayerKey: string, fallbackGasLimit?: string) => Promise<string>;
  now: () => number;
}

async function realReads(module: string, safe: string): Promise<V2Reads> {
  const provider = makeSepoliaProvider();
  const m = new ethers.Contract(module, SPENDING_MODULE_V2_ABI, provider);
  const [paused, agent, nonce, router, network] = await Promise.all([
    m.paused(), m.agentOf(safe), m.nonces(safe), m.universalRouter(), provider.getNetwork(),
  ]);
  return { paused, agent, nonce: BigInt(nonce), router, chainId: network.chainId };
}

async function realSubmit(moduleAddress: string, e: SignedExec, relayerKey: string, fallbackGasLimit?: string): Promise<string> {
  const relayer = new ethers.Wallet(relayerKey, makeSepoliaProvider());
  const module = new ethers.Contract(moduleAddress, SPENDING_MODULE_V2_ABI, relayer);
  const args = [e.safe, e.calls, e.deadline, e.signature] as const;
  let gasLimit: string | undefined;
  try {
    gasLimit = await safeGasLimit(() => module.execSigned.estimateGas(...args), fallbackGasLimit);
  } catch (err) {
    if (isDailyCapRevert(err)) throw new DailyCapRevert("DailyLimitExceeded");
    throw v2RevertError(err) ?? err;
  }
  const tx = await module.execSigned(...args, gasLimit ? { gasLimit } : {});
  const receipt = await tx.wait();
  if (receipt && Number(receipt.status) === 0) {
    console.error(`[safe] module transaction reverted on-chain: ${tx.hash}`);
    throw new UserFacingError(`This didn't go through, so your funds were not moved. You can see what happened here: https://sepolia.etherscan.io/tx/${tx.hash}`);
  }
  return tx.hash;
}

export const realV2Deps: V2Deps = {
  reads: realReads,
  agentSigner: (account) => getAgentSigner(account),
  adopt: adoptAgentIfAccepted,
  submit: realSubmit,
  now: () => Math.floor(Date.now() / 1000),
};

/**
 * Run a batch through SpendingLimitModuleV2: the account's own key signs an Exec for exactly these
 * calls, and the relayer (AGENT_PRIVATE_KEY) submits it and pays gas. Refuses before signing when
 * the module is paused, the account has no matching agent, or a router call breaks the module's
 * rules. A DailyLimitExceeded revert throws DailyCapRevert.
 */
export async function execViaModuleV2(
  safeAddress: string,
  account: string,
  relayerKey: string,
  transactions: Array<{ to: string; value: string; data: string }>,
  fallbackGasLimit?: string,
  deps: V2Deps = realV2Deps,
): Promise<string> {
  const moduleAddress = spendingModuleAddress()!;
  const calls: ModuleCall[] = transactions.map((t) => ({ to: t.to, value: t.value ?? "0", data: t.data && t.data !== "" ? t.data : "0x" }));
  const r = await deps.reads(moduleAddress, safeAddress);
  if (r.paused) throw new UserFacingError(PAUSED_TEXT, 503);
  if (r.agent === ethers.ZeroAddress) {
    console.warn(`[safe] account ${safeAddress.slice(0, 8)}… has no agent on the module (revoked, or not set up for v2)`);
    throw new UserFacingError(AGENT_MISSING_TEXT, 409);
  }
  for (const c of calls) {
    if (c.to.toLowerCase() !== r.router.toLowerCase()) continue;
    const problem = routerCallProblem(c.data, safeAddress);
    if (problem) {
      console.warn(`[safe] refused a router call before signing: ${problem}`);
      throw new UserFacingError(ROUTE_REFUSED_TEXT, 422);
    }
  }

  const matches = async (s: ethers.Signer | null) => !!s && (await s.getAddress()).toLowerCase() === r.agent.toLowerCase();
  let signer = await deps.agentSigner(account);
  // The module may have accepted a rotation since: switch to the successor key if it's the one named.
  if (signer && !(await matches(signer)) && (await deps.adopt(account, r.agent))) signer = await deps.agentSigner(account);
  if (!signer || !(await matches(signer))) {
    console.warn(`[safe] account ${safeAddress.slice(0, 8)}…: the stored agent key isn't the one the module names`);
    throw new UserFacingError(AGENT_MISSING_TEXT, 409);
  }

  const deadline = BigInt(deps.now() + SIGNED_BATCH_TTL_SECONDS);
  const signature = await signExec(signer, moduleAddress, r.chainId, safeAddress, calls, r.nonce, deadline);
  return deps.submit(moduleAddress, {
    safe: safeAddress,
    calls: calls.map((c) => ({ to: c.to, value: BigInt(c.value || 0), data: c.data })),
    deadline,
    signature,
  }, relayerKey, fallbackGasLimit);
}

/** Log a read failure without its detail reaching the user. */
export function logCapReadFailure(err: unknown): void {
  console.warn(`[safe] couldn't read today's remaining ceiling: ${safeErr(err)}`);
}
