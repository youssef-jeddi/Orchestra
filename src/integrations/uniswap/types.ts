// ─── SafeSwarm × Uniswap — Shared Types & Constants ───

// ── Sepolia Testnet Constants ──

export const CHAIN_ID = 11155111;

export const WETH_SEPOLIA = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
export const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const UNIVERSAL_ROUTER = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const UNISWAP_API_BASE = "https://trade-api.gateway.uniswap.org/v1";

// ── Routing Types ──

export type RoutingType = "CLASSIC" | "DUTCH_V2" | "DUTCH_V3";
export type ProtocolVersion = "V3" | "V4" | "UNISWAPX_V2";
export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT";
export type Urgency = "normal" | "urgent";

// ── API Request/Response Types ──

export interface CheckApprovalParams {
  walletAddress: string;
  token: string;
  tokenOut: string;
  amount: string; // raw wei
  chainId?: number;
}

export interface CheckApprovalResponse {
  approval: {
    to: string;
    data: string;
    value: string;
    gasLimit: string;
  } | null;
}

export interface QuoteRequest {
  swapper: string;
  tokenIn: string;
  tokenOut: string;
  tokenInChainId?: number;
  tokenOutChainId?: number;
  amount: string; // raw wei
  type?: SwapType;
  protocols?: ProtocolVersion[];
  routingPreference?: "BEST_PRICE" | "FASTEST";
  urgency?: Urgency;
  autoSlippage?: "DEFAULT";
}

export interface PermitData {
  domain: Record<string, any>;
  types: Record<string, any>;
  values: Record<string, any>;
}

export interface QuoteResponse {
  quote: Record<string, any>;
  permitData: PermitData | null;
  routing: RoutingType;
}

export interface SwapResponse {
  swap: {
    to: string;
    data: string;
    value: string;
    gasLimit: string;
  };
}

export interface OrderResponse {
  orderId: string;
}

// ── Token metadata (for UI) ──

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export const SEPOLIA_TOKENS: Record<string, TokenInfo> = {
  WETH: { address: WETH_SEPOLIA, symbol: "WETH", decimals: 18 },
  USDC: { address: USDC_SEPOLIA, symbol: "USDC", decimals: 6 },
};
