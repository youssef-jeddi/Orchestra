// ─── SafeSwarm × Uniswap — Routing & Quote Logic ───
// Selects protocols based on risk tier, fetches quotes with appropriate routing.

import type { RiskLevel } from "../ledger/types";
import { getQuote } from "./api";
import type {
  ProtocolVersion,
  QuoteRequest,
  QuoteResponse,
  RoutingType,
} from "./types";

export interface EnrichedQuote extends QuoteResponse {
  isMevProtected: boolean;
  isGasless: boolean;
  protocols: ProtocolVersion[];
}

/**
 * Select which Uniswap protocols to route through based on risk classification.
 *
 * - autonomous (low risk, blue-chip): allow UniswapX for MEV protection + gasless
 * - requires_approval (high value / unverified): conservative AMM-only routing
 */
export function selectProtocols(riskLevel: RiskLevel): ProtocolVersion[] {
  switch (riskLevel) {
    case "autonomous":
      return ["V3"];
    case "requires_approval":
    case "blocked":
      return ["V3"];
  }
}

/**
 * Fetch a quote from Uniswap with routing adapted to the trade's risk level.
 * Returns an enriched result with MEV/gasless flags.
 */
export async function fetchQuoteWithRouting(
  params: Omit<QuoteRequest, "protocols">,
  riskLevel: RiskLevel
): Promise<EnrichedQuote> {
  const protocols = selectProtocols(riskLevel);

  const result = await getQuote({
    ...params,
    protocols,
  });

  const isUniswapX = (["DUTCH_V2", "DUTCH_V3"] as RoutingType[]).includes(
    result.routing
  );

  return {
    ...result,
    isMevProtected: isUniswapX,
    isGasless: isUniswapX,
    protocols,
  };
}
