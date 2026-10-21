import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { getAgentWallet } from './agentWallet';
import type { TxTracker } from './inflight';
import { shortAddr } from "../../utils/redact";
import { sepoliaRpcUrl } from '../../utils/rpc';
import { spendingModuleAddress, moduleVersion, SPENDING_MODULE_V2_ABI } from './spendingModule';
import { UserFacingError } from '../../utils/userFacing';

/** Safe's SafeModuleSetup helper on Sepolia: its enableModules runs by delegatecall during setup. */
export const SAFE_MODULE_SETUP = '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47';

/**
 * How a new account is set up:
 * - owner: legacy, the agent is a co-owner (local dev only; refused in production)
 * - v1: the user is the only owner and SpendingLimitModule is enabled at setup
 * - v2: as v1, but SpendingLimitModuleV2's helper also records the account's own agent key (ORC-38)
 */
export type AccountSetup =
  | { kind: 'owner' }
  | { kind: 'v1'; module: string }
  | { kind: 'v2'; module: string; setupHelper: string };

/** New accounts can't be created: production without a module (there is no agent-as-owner fallback). */
export class AccountSetupUnavailable extends UserFacingError {
  readonly code = 'setup_unavailable';
  constructor(detail: string) {
    super("Account setup isn't available right now. Please try again later.", 503);
    console.error(`[Safe] ${detail}`);
  }
}

/** The setup from the env alone (no chain read): owner when unset, v1 shape when set. */
export function envAccountSetup(env: NodeJS.ProcessEnv = process.env): AccountSetup {
  const module = spendingModuleAddress(); // a malformed value throws
  if (module) return { kind: 'v1', module };
  if (env.NODE_ENV === 'production') {
    throw new AccountSetupUnavailable('SPENDING_MODULE_ADDRESS is not set: refusing to create an account with the agent as owner in production.');
  }
  return { kind: 'owner' };
}

/** The setup for new accounts, asking the module which version it is (v2 also gives its setup helper). */
export async function resolveAccountSetup(provider: ethers.ContractRunner): Promise<AccountSetup> {
  const base = envAccountSetup();
  if (base.kind !== 'v1') return base;
  if ((await moduleVersion(base.module, provider)) < 2) return base;
  const helper = await new ethers.Contract(base.module, SPENDING_MODULE_V2_ABI, provider).setupHelper();
  return { kind: 'v2', module: base.module, setupHelper: ethers.getAddress(helper) };
}

const setupHelperIface = new ethers.Interface(['function setupModule(address module, address agent)']);

/**
 * The one Safe configuration every user's account is created from. The address is
 * derived from it (CREATE2), so changing the owner order, the threshold or adding a
 * saltNonce would silently move every user's account — safe.test.ts pins it.
 * `agentAddress` is the shared agent for owner/v1 and the account's own agent key for v2.
 */
export function predictedSafeConfig(userAddress: string, agentAddress: string, setup: AccountSetup = envAccountSetup()) {
  if (setup.kind === 'owner') {
    return {
      safeAccountConfig: {
        owners: [agentAddress, userAddress],
        threshold: 1,
      },
    };
  }
  if (setup.kind === 'v2') {
    // The helper (delegatecalled by setup) enables the module and records this account's agent.
    return {
      safeAccountConfig: {
        owners: [userAddress],
        threshold: 1,
        to: setup.setupHelper,
        data: setupHelperIface.encodeFunctionData('setupModule', [setup.module, agentAddress]),
      },
    };
  }
  // With the on-chain cap the user is the only owner and the agent acts through the module,
  // which Safe enables while setting itself up (a delegatecall to SafeModuleSetup).
  return {
    safeAccountConfig: {
      owners: [userAddress],
      threshold: 1,
      to: SAFE_MODULE_SETUP,
      data: new ethers.Interface(["function enableModules(address[] modules)"]).encodeFunctionData("enableModules", [[setup.module]]),
    },
  };
}

/** The user's account address, known before it is deployed. */
export async function predictSafeAddress(userAddress: string, agentAddress: string, setup?: AccountSetup): Promise<string> {
  const safe = await Safe.init({
    provider: sepoliaRpcUrl(),
    predictedSafe: predictedSafeConfig(userAddress, agentAddress, setup),
  });
  return safe.getAddress();
}

/**
 * Deploys the account. The shared key (AGENT_PRIVATE_KEY) pays for the deployment in every mode;
 * `agentAddress` only goes into the configuration (see predictedSafeConfig).
 */
export async function deploySafe(
  ledgerAddress: string,
  agentAddress: string,
  provider: ethers.Provider,
  tracker?: TxTracker,
  setup?: AccountSetup,
): Promise<string> {
  console.log('[Safe] Deploying new Safe...');
  console.log('[Safe]   threshold: 1');

  const agentWallet = getAgentWallet(provider);

  const safe = await Safe.init({
    provider: sepoliaRpcUrl(),
    signer: agentWallet.privateKey,
    predictedSafe: predictedSafeConfig(ledgerAddress, agentAddress, setup),
  });

  const safeAddress = await safe.getAddress();
  console.log(`[Safe] Predicted address: ${shortAddr(safeAddress)}`);

  // Never deploy twice: the second CREATE2 would revert and burn the agent's gas.
  if ((await provider.getCode(safeAddress)) !== '0x') {
    console.log('[Safe] Already deployed — skipping');
    return safeAddress;
  }

  const deploymentTx = await safe.createSafeDeploymentTransaction();
  await tracker?.begin(); // refuses while an earlier deploy may still confirm
  const txResponse = await agentWallet.sendTransaction({
    to: deploymentTx.to,
    value: BigInt(deploymentTx.value),
    data: deploymentTx.data,
  });

  console.log(`[Safe] Deployment tx: ${txResponse.hash}`);
  await tracker?.sent(txResponse.hash);
  const receipt = await txResponse.wait();
  await tracker?.settled();
  console.log(`[Safe] Deployed at: ${shortAddr(safeAddress)} (block ${receipt?.blockNumber})`);

  return safeAddress;
}
