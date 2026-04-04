// ─── SafeSwarm × Uniswap — Trading API Client ───
// Thin wrapper around the Uniswap REST API. Sepolia testnet.

import {
  UNISWAP_API_BASE,
  CHAIN_ID,
  type CheckApprovalParams,
  type CheckApprovalResponse,
  type QuoteRequest,
  type QuoteResponse,
  type SwapResponse,
  type OrderResponse,
  type PermitData,
} from "./types";

function getHeaders(): Record<string, string> {
  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) throw new Error("UNISWAP_API_KEY env var is not set");
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

async function post<T>(path: string, body: Record<string, any>): Promise<T> {
  console.log(`[uniswap] POST ${path}`, JSON.stringify(body, null, 2));
  const res = await fetch(`${UNISWAP_API_BASE}${path}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Uniswap API ${path} failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Check if the wallet has approved Permit2 to spend the input token.
 * Returns the approval transaction if needed, or null if already approved.
 */
export async function checkApproval(
  params: CheckApprovalParams
): Promise<CheckApprovalResponse["approval"]> {
  const res = await post<CheckApprovalResponse>("/check_approval", {
    walletAddress: params.walletAddress,
    token: params.token,
    tokenOut: params.tokenOut,
    amount: params.amount,
    chainId: params.chainId ?? CHAIN_ID,
  });
  return res.approval;
}

/**
 * Get a quote for a swap. Returns the quote object, permit data (if needed),
 * and routing type (CLASSIC, DUTCH_V2, DUTCH_V3).
 */
export async function getQuote(params: QuoteRequest): Promise<QuoteResponse> {
  const body: Record<string, any> = {
    swapper: params.swapper,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    tokenInChainId: params.tokenInChainId ?? CHAIN_ID,
    tokenOutChainId: params.tokenOutChainId ?? CHAIN_ID,
    amount: params.amount,
    type: params.type ?? "EXACT_INPUT",
  };

  if (params.protocols) body.protocols = params.protocols;
  if (params.routingPreference) body.routingPreference = params.routingPreference;
  if (params.urgency) body.urgency = params.urgency;
  if (params.autoSlippage) body.autoSlippage = params.autoSlippage;

  return post<QuoteResponse>("/quote", body);
}

/**
 * Submit a classic swap (v2/v3/v4 routing).
 * Returns the ready-to-broadcast transaction.
 */
export async function submitSwap(
  quote: Record<string, any>,
  permitData: PermitData | null,
  signature?: string
): Promise<SwapResponse["swap"]> {
  const res = await post<SwapResponse>("/swap", {
    quote,
    permitData,
    signature,
  });
  return res.swap;
}

/**
 * Submit a UniswapX gasless order (DUTCH_V2 / DUTCH_V3 routing).
 * The Permit2 signature IS the order authorization.
 */
export async function submitOrder(
  quote: Record<string, any>,
  signature: string
): Promise<OrderResponse> {
  return post<OrderResponse>("/order", {
    quote,
    signature,
  });
}
