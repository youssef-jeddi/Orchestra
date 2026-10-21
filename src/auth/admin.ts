// ─── Auth — the team's admin access (ORC-39 kill switch) ───
// Two optional settings, both off unless set:
// - ADMIN_TOKEN: a long random secret. `Authorization: Bearer <ADMIN_TOKEN>` opens the /admin routes.
//   Unset (or too short to be safe), those routes answer 404 as if they didn't exist, and the bridge
//   starts as before. The token is compared in constant time and never logged.
// - ADMIN_CHAT_IDS: Telegram chat ids, comma-separated, that may send /pauseall and /resumeall.
//   Unset, no chat can.
// The admin can only pause and resume automatic actions for everyone: no route here moves funds
// or reads a wallet's data.

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

/** A token shorter than this is ignored (with a warning): it could be guessed. */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

/** The configured admin token, or null when unset or too short. */
export function adminToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env.ADMIN_TOKEN ?? "").trim();
  return t.length >= MIN_ADMIN_TOKEN_LENGTH ? t : null;
}

/** A warning to log at startup about the admin settings, or null. Never contains the token. */
export function adminConfigWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env.ADMIN_TOKEN ?? "").trim();
  if (t && t.length < MIN_ADMIN_TOKEN_LENGTH) {
    return `ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters, so it is ignored and the /admin routes are off. Generate one with: openssl rand -hex 32`;
  }
  const bad = rawChatIds(env).filter((s) => !/^-?\d+$/.test(s));
  return bad.length ? `ADMIN_CHAT_IDS has ${bad.length} value(s) that aren't Telegram chat ids; they are ignored.` : null;
}

/** Does this Authorization header carry the admin token? Constant time; false when no token is configured. */
export function isAdminAuthorization(header: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const token = adminToken(env);
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  // Hashing first gives equal lengths, so timingSafeEqual can compare without leaking the length.
  const given = crypto.createHash("sha256").update(header.slice(7).trim()).digest();
  const wanted = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(given, wanted);
}

/** Express guard for /admin routes: 404 when admin access is off, 401 for a wrong or missing token. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!adminToken()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!isAdminAuthorization(req.headers.authorization)) {
    console.warn(`[admin] refused ${req.method} ${req.path}: missing or wrong admin token`);
    res.status(401).json({ error: "Not allowed." });
    return;
  }
  next();
}

function rawChatIds(env: NodeJS.ProcessEnv): string[] {
  return (env.ADMIN_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** The Telegram chats allowed to switch automatic actions off and on for everyone. */
export function adminChatIds(env: NodeJS.ProcessEnv = process.env): Set<number> {
  return new Set(rawChatIds(env).filter((s) => /^-?\d+$/.test(s)).map(Number).filter(Number.isSafeInteger));
}

/** May this chat use /pauseall and /resumeall? */
export function isAdminChat(chatId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return adminChatIds(env).has(chatId);
}
