// ─── Bridge — which websites may talk to it (CORS + WebSocket origin allowlist) ───
// The browser sends an Origin header on cross-site requests and on every WebSocket upgrade. A
// site that isn't on the list is refused outright (not just left without CORS headers), so a
// page on another domain can't drive the bridge from a visitor's browser. Requests with no Origin
// (curl, server-to-server, the bridge's own pages) pass this check; sessions still gate the routes.
// Pure and env-driven so it is tested without network. Used by serve.ts and bridge.ts.

import type { NextFunction, Request, Response } from "express";

/** Used when ALLOWED_ORIGINS is unset: the production site and its subdomains, local dev, this project's Vercel previews. */
export const DEFAULT_ALLOWED_ORIGINS = [
  "https://getorchestra.xyz",
  "https://*.getorchestra.xyz",
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://orchestra-*-youssefs-projects-822ed3d0.vercel.app",
].join(",");

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

/** Is this Origin header value one of the allowed sites? Strict: scheme, host and port are compared after parsing. */
export function isOriginAllowed(origin: string): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  // "null" (sandboxed pages), paths, credentials and the like are never a legitimate Origin.
  if (url.origin === "null" || url.origin !== origin) return false;
  if (origin === publicAppOrigin()) return true;
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  const rules = parseAllowedOrigins(configured || DEFAULT_ALLOWED_ORIGINS);
  return rules.some((r) =>
    r.protocol === url.protocol &&
    r.host.test(url.hostname) &&
    (r.port === "*" || r.port === url.port));
}

/** For an incoming header: no Origin is fine (not a browser cross-site call); otherwise it must be allowed. */
export function originPermitted(origin: string | undefined): boolean {
  return origin === undefined || isOriginAllowed(origin);
}

/** Express middleware: refuse a disallowed Origin with 403, answer preflights, add CORS headers for allowed sites. */
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!isOriginAllowed(origin)) {
      res.status(403).json({ error: "This website isn't allowed to use Orchestra.", code: "origin_not_allowed" });
      return;
    }
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
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
