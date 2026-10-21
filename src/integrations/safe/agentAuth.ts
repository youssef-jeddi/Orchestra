// ─── Safe — what an account's agent key signs for SpendingLimitModuleV2 (ORC-38) ───
// The per-account key never sends a transaction: it signs an EIP-712 `Exec` (the Safe, the exact
// calls, the Safe's nonce and a deadline; the domain binds chainId and the module) and the shared
// relayer submits it. Replays fail on-chain (nonce), so do signatures for another Safe, module or
// chain. The type strings here must match contracts/src/SpendingLimitModuleV2.sol; a pinned digest
// in both test suites catches any drift.
//
// `routerCallProblem` mirrors the module's Universal Router rules, so a route Uniswap suggests that
// the module would refuse is stopped here with a plain message instead of a failed estimate.

import { ethers } from "ethers";

export const MODULE_DOMAIN_NAME = "Orchestra SpendingLimitModule";
export const MODULE_DOMAIN_VERSION = "2";

export const EXEC_TYPES: Record<string, ethers.TypedDataField[]> = {
  Exec: [
    { name: "safe", type: "address" },
    { name: "calls", type: "Call[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
};

export const PROPOSE_TYPES: Record<string, ethers.TypedDataField[]> = {
  ProposeAgent: [
    { name: "safe", type: "address" },
    { name: "newAgent", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export interface ModuleCall { to: string; value: string | bigint; data: string }

export function moduleDomain(module: string, chainId: bigint | number): ethers.TypedDataDomain {
  return { name: MODULE_DOMAIN_NAME, version: MODULE_DOMAIN_VERSION, chainId, verifyingContract: module };
}

/** The Exec message for `calls` (values normalised the way the contract hashes them). */
export function execMessage(safe: string, calls: ModuleCall[], nonce: bigint, deadline: bigint) {
  return {
    safe,
    calls: calls.map((c) => ({ to: c.to, value: BigInt(c.value || 0), data: c.data && c.data !== "" ? c.data : "0x" })),
    nonce,
    deadline,
  };
}

export function execDigest(module: string, chainId: bigint | number, safe: string, calls: ModuleCall[], nonce: bigint, deadline: bigint): string {
  return ethers.TypedDataEncoder.hash(moduleDomain(module, chainId), EXEC_TYPES, execMessage(safe, calls, nonce, deadline));
}

/** The agent's signature over an Exec. */
export function signExec(signer: ethers.Signer, module: string, chainId: bigint | number, safe: string, calls: ModuleCall[], nonce: bigint, deadline: bigint): Promise<string> {
  return signer.signTypedData(moduleDomain(module, chainId), EXEC_TYPES, execMessage(safe, calls, nonce, deadline));
}

/** The current agent's signature proposing `newAgent` (routine rotation). */
export function signPropose(signer: ethers.Signer, module: string, chainId: bigint | number, safe: string, newAgent: string, nonce: bigint, deadline: bigint): Promise<string> {
  return signer.signTypedData(moduleDomain(module, chainId), PROPOSE_TYPES, { safe, newAgent, nonce, deadline });
}

// ── Universal Router rules (same as SpendingLimitCallPolicyV2._checkRouter) ────

const UR_EXECUTE_DEADLINE = "0x3593564c";
const UR_EXECUTE = "0x24856bc3";
const RECIPIENT_FIRST = new Set([0x00, 0x01, 0x0b, 0x0c]); // V3 exact-in/out, WRAP_ETH, UNWRAP_WETH
const RECIPIENT_SECOND = new Set([0x04, 0x05, 0x06]); // SWEEP, TRANSFER, PAY_PORTION
const MARKERS = ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"];
const coder = ethers.AbiCoder.defaultAbiCoder();

/**
 * Why the module would refuse this Universal Router call for `safe`, or null if it's allowed.
 * For logs only: the user sees one plain sentence.
 */
export function routerCallProblem(data: string, safe: string): string | null {
  const sel = data.slice(0, 10).toLowerCase();
  let commands: string;
  let inputs: string[];
  try {
    if (sel === UR_EXECUTE_DEADLINE) [commands, inputs] = coder.decode(["bytes", "bytes[]", "uint256"], "0x" + data.slice(10)) as any;
    else if (sel === UR_EXECUTE) [commands, inputs] = coder.decode(["bytes", "bytes[]"], "0x" + data.slice(10)) as any;
    else return `selector ${sel} not allowed`;
  } catch {
    return "undecodable router call";
  }
  const cmds = ethers.getBytes(commands);
  if (cmds.length === 0 || cmds.length !== inputs.length) return "commands and inputs don't match";
  const allowed = [safe.toLowerCase(), ...MARKERS];
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i];
    if (cmd & 0xc0) return `command 0x${cmd.toString(16)} has flags`;
    const word = RECIPIENT_FIRST.has(cmd) ? 0 : RECIPIENT_SECOND.has(cmd) ? 1 : -1;
    if (word < 0) return `command 0x${cmd.toString(16).padStart(2, "0")} not allowed`;
    const input = ethers.getBytes(inputs[i]);
    if (input.length < (word + 1) * 32) return "short command input";
    const raw = input.slice(word * 32, word * 32 + 32);
    if (raw.slice(0, 12).some((b) => b !== 0)) return "recipient isn't a clean address";
    const recipient = ethers.hexlify(raw.slice(12)).toLowerCase();
    if (!allowed.includes(recipient)) return `command 0x${cmd.toString(16).padStart(2, "0")} pays someone other than the account`;
  }
  return null;
}
