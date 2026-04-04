// ─── SafeSwarm × Ledger — Risk Engine ───
// Pure logic: classifies a proposed trade into a risk tier.

import {
  type RiskLevel,
  type ProposedTrade,
  type RiskThresholds,
  DEFAULT_THRESHOLDS,
} from "./types";

let thresholds: RiskThresholds = { ...DEFAULT_THRESHOLDS };

/**
 * Classify a proposed trade into a risk tier.
 *
 * - autonomous:         value < $100 AND token verified AND liquidity > $1M
 * - requires_approval:  value ≥ $1000 OR token unverified OR liquidity < $100K
 * - autonomous:         everything else ($100–$999 band, verified, decent liquidity)
 */
export function assessRisk(trade: ProposedTrade): RiskLevel {
  const { valueUSD, tokenVerified, liquidityUSD } = trade;

  // Hard blocks
  if (valueUSD >= thresholds.approvalMinUSD) return "requires_approval";
  if (!tokenVerified) return "requires_approval";
  if (liquidityUSD < thresholds.minLiquidityUSD) return "requires_approval";

  // Low risk — small, verified, liquid
  if (
    valueUSD < thresholds.autoExecuteMaxUSD &&
    tokenVerified &&
    liquidityUSD > thresholds.highLiquidityUSD
  ) {
    return "autonomous";
  }

  // Mid band — ok to auto-execute (verified + decent liquidity)
  return "autonomous";
}

/** Override thresholds at runtime (e.g. from a UI config panel) */
export function setThresholds(overrides: Partial<RiskThresholds>): void {
  thresholds = { ...thresholds, ...overrides };
}

/** Get the current thresholds */
export function getThresholds(): RiskThresholds {
  return { ...thresholds };
}
