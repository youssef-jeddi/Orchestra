// ─── SafeSwarm × Ledger — WebSocket Bridge Server ───
// Bidirectional channel between the agent backend and the browser frontend. A socket sends
// {type:"AUTH", token} (the same session token as the HTTP routes) as its FIRST message, never in
// the URL; until then it receives nothing and is closed after AUTH_TIMEOUT_MS. Each approval goes
// only to sockets signed in as its owner, and only they can answer it.

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HTTPServer } from "http";
import type { ApprovalRequest, ApprovalResult, BridgeMessage } from "./types";

/** How long a new socket has to sign in before it is closed. */
export const AUTH_TIMEOUT_MS = 5_000;

interface PendingApproval {
  wallet: string;
  resolve: (result: ApprovalResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** A connected socket: not signed in until its AUTH message checks out. */
interface Client {
  token: string | null;
  wallet: string | null;
  authTimer: ReturnType<typeof setTimeout>;
}

export class BridgeServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, Client>();
  private pending = new Map<string, PendingApproval>();
  private approvalTimeoutMs: number;
  private verifySession: (token: string) => string | null;

  constructor(server: HTTPServer, opts?: {
    path?: string;
    timeoutMs?: number;
    authTimeoutMs?: number;
    /** The wallet a session token belongs to, or null if forged/expired/unknown (auth's `verifyToken`). */
    verifySession?: (token: string) => string | null;
    verifyOrigin?: (origin: string | undefined) => boolean;
  }) {
    this.approvalTimeoutMs = opts?.timeoutMs ?? 300_000; // 5 min default
    // Fails closed: with no verifier nobody can sign in, so nobody receives anything.
    this.verifySession = opts?.verifySession ?? (() => null);
    const authTimeoutMs = opts?.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    const verifyOrigin = opts?.verifyOrigin;
    this.wss = new WebSocketServer({
      server,
      path: opts?.path ?? "/ws",
      maxPayload: 64 * 1024,
      // Browsers always send Origin on a WebSocket upgrade: refuse the upgrade for sites that aren't allowed.
      ...(verifyOrigin ? { verifyClient: (info: { origin: string }, done: (ok: boolean, code?: number, message?: string) => void) =>
          verifyOrigin(info.origin || undefined) ? done(true) : done(false, 403, "Origin not allowed") } : {}),
    });

    this.wss.on("connection", (ws) => {
      const client: Client = {
        token: null,
        wallet: null,
        authTimer: setTimeout(() => this.refuse(ws, "session_required", "Sign in first."), authTimeoutMs),
      };
      this.clients.set(ws, client);
      console.log(`[bridge] client connected (${this.clients.size} total)`);

      ws.on("message", (raw) => {
        try {
          const msg: BridgeMessage | { type: "AUTH"; token?: unknown } = JSON.parse(raw.toString());
          this.handleMessage(ws, client, msg);
        } catch (err) {
          console.error("[bridge] bad message:", err);
        }
      });

      ws.on("close", () => {
        clearTimeout(client.authTimer);
        this.clients.delete(ws);
        console.log(`[bridge] client disconnected (${this.clients.size} total)`);
      });
    });
  }

  /** Tell the client why, then close it (4401 = sign in again). */
  private refuse(ws: WebSocket, code: string, error: string): void {
    this.send(ws, { type: "ERROR", payload: { code, error } });
    ws.close(4401, code);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** The wallet a client is signed in as right now: its token is checked again, so an expired session stops receiving. */
  private walletOf(ws: WebSocket, client: Client): string | null {
    if (!client.token) return null;
    const wallet = this.verifySession(client.token);
    if (!wallet) { this.refuse(ws, "session_required", "Your session ended. Sign in again."); return null; }
    return wallet.toLowerCase();
  }

  /** Send an approval request to the browser sockets signed in as `wallet` and wait for the result. */
  requestApproval(request: ApprovalRequest, wallet: string): Promise<ApprovalResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.tradeId);
        reject(new Error(`Approval timed out for trade ${request.tradeId}`));
      }, this.approvalTimeoutMs);

      const owner = wallet.toLowerCase();
      this.pending.set(request.tradeId, { wallet: owner, resolve, reject, timeout });

      const data = JSON.stringify({ type: "APPROVAL_REQUIRED", payload: request } satisfies BridgeMessage);
      for (const [ws, client] of this.clients) {
        if (ws.readyState === WebSocket.OPEN && this.walletOf(ws, client) === owner) ws.send(data);
      }

      console.log(`[bridge] approval requested: ${request.tradeId} — "${request.summary}"`);
    });
  }

  /** Handle incoming messages from browser clients. */
  private handleMessage(ws: WebSocket, client: Client, msg: BridgeMessage | { type: "AUTH"; token?: unknown }): void {
    if (msg.type === "AUTH") {
      const wallet = typeof msg.token === "string" ? this.verifySession(msg.token) : null;
      if (!wallet) { this.refuse(ws, "session_required", "Sign in again."); return; }
      clearTimeout(client.authTimer);
      client.token = msg.token as string;
      client.wallet = wallet.toLowerCase();
      this.send(ws, { type: "AUTH_OK", payload: { wallet: client.wallet } });
      return;
    }
    const wallet = this.walletOf(ws, client);
    if (!wallet) {
      if (!client.token) this.refuse(ws, "session_required", "Sign in first.");
      return;
    }
    if (msg.type === "APPROVAL_RESULT") {
      const pending = this.pending.get(msg.payload.tradeId);
      // Someone else's approval and an unknown one look the same.
      if (!pending || pending.wallet !== wallet) {
        this.send(ws, { type: "ERROR", payload: { code: "not_your_approval", error: "That approval isn't yours." } });
        return;
      }
      clearTimeout(pending.timeout);
      pending.resolve(msg.payload);
      this.pending.delete(msg.payload.tradeId);
      console.log(
        `[bridge] approval result: ${msg.payload.tradeId} → ${msg.payload.approved ? "APPROVED" : "REJECTED"}`
      );
    }
  }

  /** Number of connected browser clients. */
  get clientCount(): number {
    return this.clients.size;
  }
}
