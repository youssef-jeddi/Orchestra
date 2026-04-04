// ─── SafeSwarm × Ledger — Shared Types ───

/** Risk classification for a proposed trade */
export type RiskLevel = "autonomous" | "requires_approval" | "blocked";

/** A trade proposed by an agent, before risk assessment */
export interface ProposedTrade {
  tradeId: string;
  fromToken: string;
  toToken: string;
  amountIn: string;
  valueUSD: number;
  tokenVerified: boolean;
  liquidityUSD: number;
  routerAddress: string;
  calldataHex: string;
  summary: string;
}

/** Payload sent over the agent↔frontend bridge */
export interface ApprovalRequest {
  tradeId: string;
  unsignedTxHex: string;
  summary: string;
  riskLevel: RiskLevel;
  timestamp: number;
}

/** Result returned after the user acts on the Ledger */
export interface ApprovalResult {
  tradeId: string;
  approved: boolean;
  signature?: { v: number; r: string; s: string };
  error?: string;
}

/** Device connection states surfaced to the UI */
export type DeviceStatus =
  | "disconnected"
  | "scanning"
  | "connected"
  | "locked"
  | "ready"
  | "signing"
  | "approved"
  | "rejected";

/** WebSocket message protocol */
export type BridgeMessage =
  | { type: "APPROVAL_REQUIRED"; payload: ApprovalRequest }
  | { type: "APPROVAL_RESULT"; payload: ApprovalResult }
  | { type: "STATUS_UPDATE"; payload: { tradeId: string; status: string } };

/** Risk engine thresholds (configurable) */
export interface RiskThresholds {
  autoExecuteMaxUSD: number;
  approvalMinUSD: number;
  minLiquidityUSD: number;
  highLiquidityUSD: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = {
  autoExecuteMaxUSD: 100,
  approvalMinUSD: 1000,
  minLiquidityUSD: 100_000,
  highLiquidityUSD: 1_000_000,
};
