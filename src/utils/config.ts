import "dotenv/config";

import { ethers } from "ethers";
import { ALLOWANCE_MODULE_ADDRESS } from "../types/safe";

export interface AppConfig {
  agentPrivateKey?: string;
  agentAddress?: string;
  safeAddress?: string;
  ledgerOwnerAddress?: string;
  autoExecuteLimitUsd: number;
  sepoliaRpcUrl: string;
  mainnetRpcUrl: string;
  allowanceModuleAddress: string;
}

function getOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getOptionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return parsed;
}

export function getConfig(): AppConfig {
  const agentPrivateKey = getOptionalString("AGENT_HOT_WALLET_PRIVATE_KEY");
  const agentAddress = agentPrivateKey
    ? new ethers.Wallet(agentPrivateKey).address
    : undefined;

  return {
    agentPrivateKey,
    agentAddress,
    safeAddress: getOptionalString("SAFE_ADDRESS"),
    ledgerOwnerAddress: getOptionalString("LEDGER_OWNER_ADDRESS"),
    autoExecuteLimitUsd: getOptionalNumber("AUTO_EXECUTE_LIMIT_USD", 100),
    sepoliaRpcUrl: getOptionalString("SEPOLIA_RPC_URL") || "https://rpc.sepolia.org",
    mainnetRpcUrl: getOptionalString("MAINNET_RPC_URL") || "https://cloudflare-eth.com",
    allowanceModuleAddress: ALLOWANCE_MODULE_ADDRESS,
  };
}

export function getRpcUrl(chainId: number, config: AppConfig = getConfig()): string {
  return chainId === 1 ? config.mainnetRpcUrl : config.sepoliaRpcUrl;
}

export function getSpendingLimitWei(
  tokenDecimals: number,
  priceUsd: number,
  limitUsd: number = getConfig().autoExecuteLimitUsd
): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error("priceUsd must be a positive number");
  }

  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    throw new Error("limitUsd must be a positive number");
  }

  const tokenAmount = limitUsd / priceUsd;
  const fractionalDigits = Math.min(tokenDecimals, 12);
  return ethers.parseUnits(tokenAmount.toFixed(fractionalDigits), tokenDecimals);
}
