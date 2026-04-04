export enum FlagType {
  PRICE_ALERT = 'PRICE_ALERT',
  GAS_SPIKE = 'GAS_SPIKE',
  APY_CHANGE = 'APY_CHANGE',
  STANDING_ORDER = 'STANDING_ORDER',
  PORTFOLIO_DRIFT = 'PORTFOLIO_DRIFT',
  USER_MESSAGE = 'USER_MESSAGE',
}

export enum Verdict {
  AUTO_EXECUTE = 'AUTO_EXECUTE',
  NEEDS_APPROVAL = 'NEEDS_APPROVAL',
  BLOCKED = 'BLOCKED',
}

export interface Flag {
  id: string;
  type: FlagType;
  source: string;
  summary: string;
  data: Record<string, unknown>;
  processed: boolean;
  createdAt: string;
}

export interface TransactionStep {
  protocol: string;
  action: string;
  params: Record<string, unknown>;
  estimatedGasWei: string;
  order: number;
}

export interface ActionPlan {
  id: string;
  flagId: string;
  summary: string;
  steps: TransactionStep[];
  totalEstimatedValueUsd: number;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
  createdAt: string;
  updatedAt: string;
}

export interface RiskAssessment {
  id: string;
  planId: string;
  verdict: Verdict;
  reasons: string[];
  riskScore: number;
  requiresLedger: boolean;
  assessedAt: string;
}

export interface LedgerMessage {
  id: string;
  planId: string;
  assessmentId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  summary: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface UserProfile {
  address: string;
  safeAddress: string;
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  autoApproveLimit: number;
  preferredTokens: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StandingOrder {
  id: string;
  userAddress: string;
  type: 'dca' | 'rebalance' | 'yield_optimize';
  description: string;
  params: Record<string, unknown>;
  active: boolean;
  intervalMs: number;
  lastTriggeredAt: string | null;
  createdAt: string;
}

export interface VaultPosition {
  id: string;
  userAddress: string;
  protocol: string;
  vaultAddress: string;
  tokenSymbol: string;
  depositedAmount: string;
  currentApyBps: number;
  enteredAt: string;
  updatedAt: string;
}

export interface TradeHistoryEntry {
  id: string;
  planId: string;
  stepIndex: number;
  txHash: string;
  protocol: string;
  action: string;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  gasUsedWei: string;
  status: 'success' | 'reverted' | 'pending';
  executedAt: string;
}
