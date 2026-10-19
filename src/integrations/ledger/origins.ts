// ─── Bridge — which websites may talk to it (CORS + WebSocket origin allowlist) ───
// The browser sends an Origin header on cross-site requests and on every WebSocket upgrade. A
// site that isn't on the list is refused outright (not just left without CORS headers), so a
// page on another domain can't drive the bridge from a visitor's browser. Plain HTTP requests with
// no Origin (curl, server-to-server, the bridge's own pages) pass this check; sessions still gate
// the routes. A WebSocket upgrade must carry an allowed Origin (browsers always send one).
// In production ALLOWED_ORIGINS must be set (assertOriginConfig stops the bridge starting without it).
// Pure and env-driven so it is tested without network. Used by serve.ts and bridge.ts.

import type { NextFunction, Request, Response } from "express";

/**
 * Used when ALLOWED_ORIGINS is unset and NODE_ENV isn't production: local development only. A
 * deployed bridge must list its frontends explicitly (the production site, previews of a staging
 * bridge), so no domain or team name is built in.
 */
export const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*"].join(",");

const isProduction = () => process.env.NODE_ENV === "production";
interface Rule {
  protocol: string;
  host: RegExp;
  /** A fixed port ("" = the scheme's default) or any port. */
  port: string | "*";
}

const LABEL = "[a-z0-9-]+";

/**
 * One entry → a rule: `scheme://host[:port]`. In the host, a leading `*.` stands for one or more
 * subdomain labels and a `*` inside a label for any letters, digits or hyphens; a port of `*`
 * means any port. Anything else must match exactly. Returns null for an entry that isn't valid.
 */
function parseRule(entry: string): Rule | null {
  const m = /^(https?):\/\/([^/:?#@\s]+)(?::(\d{1,5}|\*))?$/i.exec(entry.trim());
  if (!m) return null;
  const protocol = `${m[1].toLowerCase()}:`;
  const host = m[2].toLowerCase();
  let source = "";
  let rest = host;
  if (rest.startsWith("*.")) { source = `(?:${LABEL}\\.)+`; rest = rest.slice(2); }
  // A label must be literal or contain literal characters: a bare `*` (or `*.com`) would open it to the world.
  if (!/^[a-z0-9*.-]+$/.test(rest) || rest.split(".").some((l) => !l || l === "*")) return null;
  if (source && !rest.includes(".")) return null;
  source += rest.split("*").map((p) => p.replace(/[.]/g, "\\.")).join(LABEL);
  const port = m[3] ?? "";
  if (port !== "" && port !== "*") {
    // A port is written the way the browser writes it: not the scheme's default, no leading zero.
    if (String(Number(port)) !== port || Number(port) > 65535) return null;
  }
  return { protocol, host: new RegExp(`^${source}$`), port: port as string | "*" };
}

/** The rules from a comma-separated list; invalid entries are dropped (and reported) so a typo can only narrow access. */
export function parseAllowedOrigins(list: string): Rule[] {
  const rules: Rule[] = [];
  for (const entry of list.split(",").map((e) => e.trim()).filter(Boolean)) {
    const rule = parseRule(entry);
    if (rule) rules.push(rule); else console.warn(`[origins] ignoring invalid ALLOWED_ORIGINS entry: ${entry}`);
  }
  return rules;
}

/** The origin of PUBLIC_APP_URL (the phone pages reach the bridge through the app's proxy on that host), or null. */
function publicAppOrigin(): string | null {
  try { return new URL(process.env.PUBLIC_APP_URL || "").origin; } catch { return null; }
}

/** The configured list; unset means local dev, and in production nothing (never localhost or previews by default). */
function listFromEnv(): string {
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  if (configured) return configured;
  return isProduction() ? "" : DEFAULT_ALLOWED_ORIGINS;
}

/**
 * Startup check. In production ALLOWED_ORIGINS must hold at least one valid origin, otherwise the
 * bridge would silently serve nobody (or, worse, be configured by copy-paste from dev). Throws with
 * what to set; returns warnings (e.g. localhost listed in production, which is honoured as explicit config).
 */
export function assertOriginConfig(): string[] {
  if (!isProduction()) return [];
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  const example = "ALLOWED_ORIGINS=https://getorchestra.xyz,https://www.getorchestra.xyz";
  if (!configured) {
    throw new Error(`ALLOWED_ORIGINS must be set when NODE_ENV=production: list the exact https origins of your frontend, comma-separated, e.g. ${example}`);
  }
  const rules = parseAllowedOrigins(configured);
  if (!rules.length) {
    throw new Error(`None of the entries in ALLOWED_ORIGINS is a valid origin (use scheme://host[:port]), e.g. ${example}`);
  }
  const warnings: string[] = [];
  if (rules.some((r) => r.host.test("localhost") || r.host.test("127.0.0.1"))) {
    warnings.push("ALLOWED_ORIGINS lists localhost or 127.0.0.1 while NODE_ENV=production: any page running on a visitor's own machine can call this bridge.");
  }
  return warnings;
}

/** Is this Origin header value one of the allowed sites? Strict: scheme, host and port are compared after parsing. */
export function isOriginAllowed(origin: string): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  // "null" (sandboxed pages), paths, credentials and the like are never a legitimate Origin.
  if (url.origin === "null" || url.origin !== origin) return false;
  if (origin === publicAppOrigin()) return true;
  const rules = parseAllowedOrigins(listFromEnv());
  return rules.some((r) =>
    r.protocol === url.protocol &&
    r.host.test(url.hostname) &&
    (r.port === "*" || r.port === url.port));
}

/** For plain HTTP: no Origin is fine (not a browser cross-site call); otherwise it must be allowed. */
export function originPermitted(origin: string | undefined): boolean {
  return origin === undefined || isOriginAllowed(origin);
}

/** For a WebSocket upgrade: browsers always send Origin, so a missing one is refused too. */
export function wsOriginPermitted(origin: string | undefined): boolean {
  return origin !== undefined && isOriginAllowed(origin);
}

/** Express middleware: refuse a disallowed Origin with 403, answer preflights, add CORS headers for allowed sites. */
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  // The answer depends on Origin, so say so on every response (allowed, refused, or none sent):
  // a cache must never serve one site's answer to another. No Allow-Credentials is ever sent: the
  // session travels in the Authorization header, not a cookie.
  res.vary("Origin");
  if (origin !== undefined) {
    if (!isOriginAllowed(origin)) {
      res.status(403).json({ error: "This website isn't allowed to use Orchestra.", code: "origin_not_allowed" });
      return;
    }
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}

/** /mock-trade injects fake approvals: only on a local dev bridge that opted in, never in production mode. */
export function mockTradeEnabled(): boolean {
  return process.env.ENABLE_MOCK_TRADE === "1" && process.env.NODE_ENV !== "production";
}
