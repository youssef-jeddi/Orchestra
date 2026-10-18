import "dotenv/config";

import { ethers } from "ethers";
import { ALLOWANCE_MODULE_ADDRESS } from "../types/safe";

export interface AppConfig {
  agentPrivateKey?: string;
  agentAddress?: string;
  safeAddress?: string;
  ledgerOwnerAddress?: string;
  sepoliaRpcUrl: string;
  mainnetRpcUrl: string;
  allowanceModuleAddress: string;
}

function getOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getConfig(): AppConfig {
  const agentPrivateKey = getOptionalString("AGENT_PRIVATE_KEY");
  const agentAddress = agentPrivateKey
    ? new ethers.Wallet(agentPrivateKey).address
    : undefined;

  return {
    agentPrivateKey,
    agentAddress,
    safeAddress: getOptionalString("SAFE_ADDRESS"),
    ledgerOwnerAddress: getOptionalString("LEDGER_OWNER_ADDRESS"),
    sepoliaRpcUrl: getOptionalString("SEPOLIA_RPC_URL") || "https://ethereum-sepolia-rpc.publicnode.com",
    mainnetRpcUrl: getOptionalString("MAINNET_RPC_URL") || "https://ethereum-rpc.publicnode.com",
    allowanceModuleAddress: ALLOWANCE_MODULE_ADDRESS,
  };
}

export function getRpcUrl(chainId: number, config: AppConfig = getConfig()): string {
  return chainId === 1 ? config.mainnetRpcUrl : config.sepoliaRpcUrl;
}
