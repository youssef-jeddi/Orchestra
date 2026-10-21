// ─── Safe — one agent key per account, encrypted at rest (ORC-38) ───
// With SpendingLimitModuleV2 every account has its own agent key, recorded per Safe on-chain, so a
// leaked key reaches one account (and at most its $1000/day) instead of every account. The keys
// never hold ETH: they only sign EIP-712 authorisations, and the shared relayer (AGENT_PRIVATE_KEY)
// submits them and pays gas (agentAuth.ts, spendingModule.ts).
//
// Keys live in the normal storage under `agentkey:<wallet>`, encrypted with AES-256-GCM under
// AGENT_KEY_ENCRYPTION_KEY. The ciphertext is bound to the wallet and the key's address (GCM
// associated data), so a record copied onto another wallet doesn't decrypt. In production a missing
// or malformed encryption key refuses every use (fail closed); local dev falls back to a fixed,
// public dev key so nothing needs configuring.
//
// `getAgentSigner(account)` is the only way to get a signer: moving the keys into Azure Key Vault
// (ORC-112) replaces this file and nothing else.

import crypto from "node:crypto";
import { ethers } from "ethers";
import { read, write } from "../zero-g/storage";
import { UserFacingError } from "../../utils/userFacing";

const RECORD_VERSION = 1;
const recordKey = (account: string) => `agentkey:${account.toLowerCase()}`;

/** Public on purpose: only for local development, where there's nothing worth protecting. */
const DEV_ENCRYPTION_KEY = crypto.createHash("sha256").update("orchestra-local-dev-agent-key-encryption").digest();

interface SealedKey {
  address: string;
  iv: string;
  tag: string;
  ct: string;
  createdAt: string;
}

interface AgentKeyRecord {
  v: number;
  current: SealedKey;
  /** A successor created for a rotation; becomes current once the module has accepted it. */
  pending?: SealedKey;
}

/** The deployment can't use per-account keys (missing or malformed encryption key in production). */
export class AgentKeyConfigError extends UserFacingError {
  readonly code = "agent_keys_unavailable";
  constructor(detail: string) {
    super("Automatic actions aren't available right now, so nothing was sent. Please try again later.", 503);
    console.error(`[agent-keys] ${detail}`);
  }
}

let warnedDev = false;

/**
 * The 32-byte key that encrypts agent keys at rest. AGENT_KEY_ENCRYPTION_KEY is 64 hex characters
 * (`openssl rand -hex 32`). Required in production; local dev uses a public default.
 */
export function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.AGENT_KEY_ENCRYPTION_KEY?.trim();
  if (raw) {
    const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new AgentKeyConfigError("AGENT_KEY_ENCRYPTION_KEY must be 64 hex characters (32 bytes), e.g. from `openssl rand -hex 32`.");
    }
    return Buffer.from(hex, "hex");
  }
  if (env.NODE_ENV === "production") {
    throw new AgentKeyConfigError("AGENT_KEY_ENCRYPTION_KEY is not set: per-account agent keys are refused in production without it.");
  }
  if (!warnedDev) {
    warnedDev = true;
    console.warn("[agent-keys] AGENT_KEY_ENCRYPTION_KEY unset: using the public local-dev key (never do this on a deployed bridge).");
  }
  return DEV_ENCRYPTION_KEY;
}

/** Startup problem for a production bridge, or null when the configuration is usable. */
export function agentKeyConfigProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== "production") return null;
  const raw = env.AGENT_KEY_ENCRYPTION_KEY?.trim();
  if (!raw) return "AGENT_KEY_ENCRYPTION_KEY is not set: accounts on SpendingLimitModuleV2 can't act until it is (generate one with `openssl rand -hex 32`).";
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return "AGENT_KEY_ENCRYPTION_KEY must be 64 hex characters (32 bytes).";
  return null;
}

const aad = (account: string, address: string) => Buffer.from(`orchestra-agent-key:v1:${account.toLowerCase()}:${address.toLowerCase()}`);

function seal(account: string, wallet: ethers.Wallet | ethers.HDNodeWallet, key: Buffer): SealedKey {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(account, wallet.address));
  const ct = Buffer.concat([cipher.update(Buffer.from(wallet.privateKey.slice(2), "hex")), cipher.final()]);
  return { address: wallet.address, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64"), createdAt: new Date().toISOString() };
}

function unseal(account: string, sealed: SealedKey, key: Buffer): ethers.Wallet {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(aad(account, sealed.address));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const pk = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
    const wallet = new ethers.Wallet("0x" + pk.toString("hex"));
    // The stored address is the one the module knows; a mismatch means a damaged or swapped record.
    if (wallet.address !== ethers.getAddress(sealed.address)) throw new Error("address mismatch");
    return wallet;
  } catch {
    throw new AgentKeyConfigError(`the stored agent key for an account couldn't be decrypted (wrong AGENT_KEY_ENCRYPTION_KEY, or a damaged record).`);
  }
}

async function readRecord(account: string): Promise<AgentKeyRecord | null> {
  const rec = (await read(recordKey(account))) as AgentKeyRecord | null;
  return rec && rec.v === RECORD_VERSION && rec.current ? rec : null;
}

// Two requests for the same account must not each create a key (the account's address depends on
// it), so creation is serialised per account within this bridge process.
const creating = new Map<string, Promise<unknown>>();
async function serialised<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const k = account.toLowerCase();
  const before = creating.get(k) ?? Promise.resolve();
  const run = before.then(fn, fn);
  creating.set(k, run.catch(() => {}));
  try {
    return await run;
  } finally {
    if (creating.get(k) === run) creating.delete(k);
  }
}

/**
 * The account's agent signer, connected to `provider` when given. With `create`, a key is made
 * (and stored encrypted) the first time; without it a missing key returns null. The account is the
 * user's wallet address, never anything from a request body.
 */
export async function getAgentSigner(
  account: string,
  opts: { create?: boolean; provider?: ethers.Provider } = {},
): Promise<ethers.Wallet | null> {
  if (!ethers.isAddress(account)) throw new Error("getAgentSigner needs the account's wallet address");
  const key = encryptionKey();
  const connect = (w: ethers.Wallet) => (opts.provider ? w.connect(opts.provider) : w);
  const existing = await readRecord(account);
  if (existing) return connect(unseal(account, existing.current, key));
  if (!opts.create) return null;
  return serialised(account, async () => {
    const again = await readRecord(account);
    if (again) return connect(unseal(account, again.current, key));
    const fresh = ethers.Wallet.createRandom();
    await write(recordKey(account), { v: RECORD_VERSION, current: seal(account, fresh, key) } satisfies AgentKeyRecord);
    console.log(`[agent-keys] created an agent key for an account`);
    return connect(new ethers.Wallet(fresh.privateKey));
  });
}

/** The account's agent address, creating its key if needed (onboarding: the address goes into the Safe's setup). */
export async function agentAddressFor(account: string): Promise<string> {
  return (await getAgentSigner(account, { create: true }))!.address;
}

/** The pending successor key of a rotation, if any. */
export async function getPendingAgentSigner(account: string): Promise<ethers.Wallet | null> {
  const rec = await readRecord(account);
  return rec?.pending ? unseal(account, rec.pending, encryptionKey()) : null;
}

/** Start a rotation: create (or reuse) the successor key and return its address. The current key stays in use. */
export async function beginAgentRotation(account: string): Promise<string> {
  const key = encryptionKey();
  return serialised(account, async () => {
    const rec = await readRecord(account);
    if (!rec) throw new Error("this account has no agent key to rotate");
    if (rec.pending) return ethers.getAddress(rec.pending.address);
    const next = ethers.Wallet.createRandom();
    await write(recordKey(account), { ...rec, pending: seal(account, next, key) });
    return next.address;
  });
}

/**
 * The module now names `onChainAgent` for the account: if that's the pending key, make it current
 * (the old key is dropped). Returns whether the current key now matches the chain.
 */
export async function adoptAgentIfAccepted(account: string, onChainAgent: string): Promise<boolean> {
  return serialised(account, async () => {
    const rec = await readRecord(account);
    if (!rec) return false;
    if (same(rec.current.address, onChainAgent)) return true;
    if (!rec.pending || !same(rec.pending.address, onChainAgent)) return false;
    await write(recordKey(account), { v: RECORD_VERSION, current: rec.pending });
    console.log(`[agent-keys] an account's rotated agent key is now in use`);
    return true;
  });
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
