// ─── Auth — wallet sessions ───
// Proof of wallet ownership for the bridge API. The wallet signs an EIP-712
// login (one-time nonce, works for MetaMask and Ledger alike); the server then
// issues a short-lived HMAC-signed session token, sent as
// `Authorization: Bearer <token>`. Endpoints that act for a wallet take the
// wallet from the session, never from the request body.
//
// Stateless tokens: no session table. The signing secret needs no setup: it's
// generated on first start and kept in a local file (SESSION_SECRET_FILE,
// default .orchestra/session-secret), so sessions survive restarts. Setting
// SESSION_SECRET overrides it — only needed when several server instances must
// accept each other's tokens.

import crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import type { Request, Response, NextFunction } from "express";

const CHAIN_ID = 11155111;
const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 8) * 3_600_000;

let secret: Buffer | null = null;
function getSecret(): Buffer {
  if (secret) return secret;
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) return (secret = Buffer.from(configured));
  if (configured) console.warn("[auth] SESSION_SECRET is shorter than 32 characters — ignoring it");
  return (secret = loadOrCreateSecretFile());
}

/** Read the persisted secret, or generate and persist one (owner-only permissions). */
export function loadOrCreateSecretFile(file = process.env.SESSION_SECRET_FILE || path.join(process.cwd(), ".orchestra", "session-secret")): Buffer {
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return Buffer.from(existing, "hex");
    console.warn(`[auth] ${file} is not a valid secret — replacing it`);
  } catch {
    /* first start: no file yet */
  }
  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, fresh.toString("hex") + "\n", { mode: 0o600 });
    console.log(`[auth] generated a session secret in ${file}`);
  } catch (err: any) {
    // Read-only filesystem (some hosts): still works, sessions just reset on restart.
    console.warn(`[auth] couldn't save the session secret (${err.message}) — sessions will reset on restart`);
  }
  return fresh;
}

// ── Login: EIP-712 over a one-time nonce ──

const nonces = new Map<string, { wallet: string; issuedAt: string; expires: number }>();

function loginTypedData(wallet: string, nonce: string, issuedAt: string) {
  return {
    domain: { name: "Orchestra", version: "1", chainId: CHAIN_ID },
    types: {
      Login: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "string" },
        { name: "issuedAt", type: "string" },
        { name: "statement", type: "string" },
      ],
    },
    primaryType: "Login" as const,
    message: {
      wallet: ethers.getAddress(wallet),
      nonce,
      issuedAt,
      statement: "Sign in to Orchestra. This proves you own this wallet; it doesn't move funds or cost gas.",
    },
  };
}

/** Typed data for the wallet to sign (EIP712Domain included for eth_signTypedData_v4). */
export function loginRequest(wallet: unknown) {
  if (typeof wallet !== "string" || !ethers.isAddress(wallet)) throw new AuthError(400, "walletAddress must be a valid address");
  sweepNonces();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const issuedAt = new Date().toISOString();
  nonces.set(nonce, { wallet: wallet.toLowerCase(), issuedAt, expires: Date.now() + NONCE_TTL_MS });
  const td = loginTypedData(wallet, nonce, issuedAt);
  return {
    nonce,
    typedData: {
      ...td,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        ...td.types,
      },
    },
  };
}

/** Verify the signed login and issue a session token. The nonce is single-use either way. */
export function login(wallet: unknown, nonce: unknown, signature: unknown): { token: string; wallet: string; expiresAt: string } {
  if (typeof wallet !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
    throw new AuthError(400, "walletAddress, nonce and signature required");
  }
  const entry = nonces.get(nonce);
  nonces.delete(nonce);
  if (!entry || entry.expires < Date.now() || entry.wallet !== wallet.toLowerCase()) {
    throw new AuthError(401, "Login request expired. Sign in again.");
  }
  const td = loginTypedData(wallet, nonce, entry.issuedAt);
  let signer: string;
  try {
    signer = ethers.verifyTypedData(td.domain, td.types, td.message, signature);
  } catch {
    throw new AuthError(401, "Invalid signature.");
  }
  if (signer.toLowerCase() !== entry.wallet) throw new AuthError(401, "Signature doesn't match this wallet.");
  return issueToken(entry.wallet);
}

// ── Tokens: base64url(payload).base64url(HMAC-SHA256(payload)) ──

export function issueToken(wallet: string, now = Date.now()): { token: string; wallet: string; expiresAt: string } {
  const exp = now + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ w: wallet.toLowerCase(), iat: now, exp })).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, wallet: wallet.toLowerCase(), expiresAt: new Date(exp).toISOString() };
}

/** The wallet a token belongs to, or null if it's malformed, forged or expired. */
export function verifyToken(token: unknown, now = Date.now()): string | null {
  if (typeof token !== "string") return null;
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { w, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof w !== "string" || !ethers.isAddress(w) || typeof exp !== "number" || exp <= now) return null;
    return w.toLowerCase();
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

// ── Express helpers ──

/** The session wallet from `Authorization: Bearer <token>`, or null. */
export function sessionWallet(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return verifyToken(header.slice(7).trim());
}

/** Middleware: 401 unless the request carries a valid session; sets res.locals.wallet. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const wallet = sessionWallet(req);
  if (!wallet) {
    res.status(401).json({ error: "Sign in with your wallet first.", code: "session_required" });
    return;
  }
  res.locals.wallet = wallet;
  next();
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sweepNonces(): void {
  const now = Date.now();
  for (const [n, e] of nonces) if (e.expires < now) nonces.delete(n);
}

/** Test hook: use a fixed secret. */
export function _setSecret(s: string): void {
  secret = Buffer.from(s);
}
