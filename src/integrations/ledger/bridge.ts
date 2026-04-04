// ─── SafeSwarm × Ledger — WebSocket Bridge Server ───
// Bidirectional channel between the agent backend and the browser frontend.

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HTTPServer } from "http";
import type { ApprovalRequest, ApprovalResult, BridgeMessage } from "./types";

interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class BridgeServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private pending = new Map<string, PendingApproval>();
  private approvalTimeoutMs: number;

  constructor(server: HTTPServer, opts?: { path?: string; timeoutMs?: number }) {
    this.approvalTimeoutMs = opts?.timeoutMs ?? 300_000; // 5 min default
    this.wss = new WebSocketServer({ server, path: opts?.path ?? "/ws" });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      console.log(`[bridge] client connected (${this.clients.size} total)`);

      ws.on("message", (raw) => {
        try {
          const msg: BridgeMessage = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch (err) {
          console.error("[bridge] bad message:", err);
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`[bridge] client disconnected (${this.clients.size} total)`);
      });
    });
  }

  /** Send an approval request to all connected browser clients and wait for the result. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.tradeId);
        reject(new Error(`Approval timed out for trade ${request.tradeId}`));
      }, this.approvalTimeoutMs);

      this.pending.set(request.tradeId, { resolve, reject, timeout });

      this.broadcast({
        type: "APPROVAL_REQUIRED",
        payload: request,
      });

      console.log(`[bridge] approval requested: ${request.tradeId} — "${request.summary}"`);
    });
  }

  /** Broadcast a message to all connected clients. */
  private broadcast(msg: BridgeMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /** Handle incoming messages from browser clients. */
  private handleMessage(msg: BridgeMessage): void {
    if (msg.type === "APPROVAL_RESULT") {
      const pending = this.pending.get(msg.payload.tradeId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(msg.payload);
        this.pending.delete(msg.payload.tradeId);
        console.log(
          `[bridge] approval result: ${msg.payload.tradeId} → ${msg.payload.approved ? "APPROVED" : "REJECTED"}`
        );
      }
    }
  }

  /** Number of connected browser clients. */
  get clientCount(): number {
    return this.clients.size;
  }
}
