import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { ALLOWANCE_MODULE_ADDRESS } from '../../types/safe';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo';

// Sepolia token addresses
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';
const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const WETH_SEPOLIA = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';

// AllowanceModule ABI (only the functions we need)
const ALLOWANCE_ABI = [
  'function addDelegate(address delegate)',
  'function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)',
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
  'function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, address next)',
];

// OrchestraPolicy ABI for updateSpendingLimit
const POLICY_ABI = [
  'function updateSpendingLimit(uint256 newLimitUSD) external',
];

// Helper: fresh Safe SDK instance (avoids stale nonce after tx execution)
async function initSafe(safeAddress: string, signerPrivateKey: string) {
  return Safe.init({ provider: SEPOLIA_RPC, signer: signerPrivateKey, safeAddress });
}

// Helper: wait for nonce to increment on-chain
async function waitForNonce(safeAddress: string, signerPrivateKey: string, expectedNonce: number, maxWaitMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const safe = await initSafe(safeAddress, signerPrivateKey);
    const current = await safe.getNonce();
    if (current >= expectedNonce) return;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.warn(`[Safe] Nonce wait timeout — expected ${expectedNonce}`);
}

// Helper: create, sign, execute one Safe tx with nonce confirmation
async function execSafeTx(safeAddress: string, signerPrivateKey: string, to: string, data: string): Promise<string> {
  const safe = await initSafe(safeAddress, signerPrivateKey);
  const nonce = await safe.getNonce();
  const tx = await safe.createTransaction({ transactions: [{ to, value: '0', data }] });
  const signedTx = await safe.signTransaction(tx);
  const result = await safe.executeTransaction(signedTx);
  const hash = (result as any).hash || '';
  // Wait for nonce to increment (confirms tx was mined)
  await waitForNonce(safeAddress, signerPrivateKey, nonce + 1);
  return hash;
}

export async function setInitialSpendingLimits(
  safeAddress: string,
  agentWalletAddress: string,
  limitUSD: number,
  signerPrivateKey: string
): Promise<void> {
  console.log(`[Safe] Setting spending limits on ${safeAddress}...`);
  console.log(`[Safe]   delegate: ${agentWalletAddress}`);
  console.log(`[Safe]   limitUSD: $${limitUSD}`);

  const allowanceIface = new ethers.Interface(ALLOWANCE_ABI);

  // 1. Enable AllowanceModule on the Safe
  const safe = await initSafe(safeAddress, signerPrivateKey);
  const isEnabled = await safe.isModuleEnabled(ALLOWANCE_MODULE_ADDRESS);
  if (!isEnabled) {
    console.log('[Safe] Enabling AllowanceModule...');
    const nonceBefore = await safe.getNonce();
    const enableTx = await safe.createEnableModuleTx(ALLOWANCE_MODULE_ADDRESS);
    const signedEnableTx = await safe.signTransaction(enableTx);
    const enableResult = await safe.executeTransaction(signedEnableTx);
    console.log(`[Safe] AllowanceModule enabled: ${(enableResult as any).hash || 'ok'}`);
    // Wait for nonce to increment before proceeding
    await waitForNonce(safeAddress, signerPrivateKey, nonceBefore + 1);
  } else {
    console.log('[Safe] AllowanceModule already enabled');
  }

  // 2. Add agent wallet as delegate (required before setAllowance)
  const rpcProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const moduleContract = new ethers.Contract(ALLOWANCE_MODULE_ADDRESS, ALLOWANCE_ABI, rpcProvider);
  const delegates = await moduleContract.getDelegates(safeAddress, 0, 10);
  const isDelegate = delegates.results.map((a: string) => a.toLowerCase()).includes(agentWalletAddress.toLowerCase());

  if (!isDelegate) {
    console.log('[Safe] Adding agent as delegate...');
    const addDelegateData = allowanceIface.encodeFunctionData('addDelegate', [agentWalletAddress]);
    const hash = await execSafeTx(safeAddress, signerPrivateKey, ALLOWANCE_MODULE_ADDRESS, addDelegateData);
    console.log(`[Safe] Delegate added: ${hash}`);
  } else {
    console.log('[Safe] Agent already a delegate');
  }

  // 3. Set allowances for each token
  const usdcAmount = BigInt(limitUSD) * 1000000n;
  const ethAmount = ethers.parseEther((limitUSD / 2500).toFixed(8));

  const tokens = [
    { address: USDC_SEPOLIA, amount: usdcAmount, name: 'USDC' },
    { address: WETH_SEPOLIA, amount: ethAmount, name: 'WETH' },
    { address: ETH_ADDRESS, amount: ethAmount, name: 'ETH' },
  ];

  for (const token of tokens) {
    console.log(`[Safe] Setting ${token.name} allowance: ${token.amount}`);
    const data = allowanceIface.encodeFunctionData('setAllowance', [
      agentWalletAddress, token.address, token.amount, 1440, 0,
    ]);
    const hash = await execSafeTx(safeAddress, signerPrivateKey, ALLOWANCE_MODULE_ADDRESS, data);
    console.log(`[Safe] ${token.name} allowance set: ${hash}`);
  }

  console.log('[Safe] All spending limits configured');
}

export async function updateSpendingLimit(
  safeAddress: string,
  agentWalletAddress: string,
  newLimitUSD: number,
  signerPrivateKey: string
): Promise<string[]> {
  console.log(`[Safe] Updating spending limit to $${newLimitUSD}...`);

  const allowanceIface = new ethers.Interface(ALLOWANCE_ABI);
  const txHashes: string[] = [];

  const usdcAmount = BigInt(newLimitUSD) * 1000000n;
  const ethAmount = ethers.parseEther((newLimitUSD / 2500).toFixed(8));

  const tokens = [
    { address: USDC_SEPOLIA, amount: usdcAmount },
    { address: WETH_SEPOLIA, amount: ethAmount },
    { address: ETH_ADDRESS, amount: ethAmount },
  ];

  for (const token of tokens) {
    const data = allowanceIface.encodeFunctionData('setAllowance', [
      agentWalletAddress, token.address, token.amount, 1440, 0,
    ]);
    const hash = await execSafeTx(safeAddress, signerPrivateKey, ALLOWANCE_MODULE_ADDRESS, data);
    txHashes.push(hash);
  }

  // Also update OrchestraPolicy on-chain
  const policyAddress = process.env.ORCHESTRA_POLICY_ADDRESS;
  if (policyAddress) {
    const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
    const wallet = new ethers.Wallet(signerPrivateKey, provider);
    const policy = new ethers.Contract(policyAddress, POLICY_ABI, wallet);
    const policyTx = await policy.updateSpendingLimit(newLimitUSD * 100);
    await policyTx.wait();
    txHashes.push(policyTx.hash);
    console.log(`[Safe] OrchestraPolicy updated: ${policyTx.hash}`);
  }

  console.log('[Safe] Spending limits updated');
  return txHashes;
}

// ── Ledger-signed limit update ──
// Builds a single unsigned tx that batches all 3 setAllowance calls via MultiSend
// through the Safe. The Ledger owner signs this as a regular ETH tx.

const MULTISEND_ADDRESS = '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526';

const SAFE_EXEC_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
];

/** Pack inner txs into MultiSend's `transactions` bytes (packed encoding). */
function encodeMultiSendData(txs: Array<{ to: string; value: string; data: string }>): string {
  const parts: string[] = [];
  for (const tx of txs) {
    const dataBytes = ethers.getBytes(tx.data);
    const packed = ethers.solidityPacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [0, tx.to, BigInt(tx.value || '0'), dataBytes.length, tx.data],
    );
    parts.push(packed.slice(2)); // strip 0x for concat
  }
  return '0x' + parts.join('');
}

/**
 * Build an unsigned ETH transaction that, when sent by `ledgerAddress`,
 * executes a MultiSend of 3 setAllowance calls through the Safe.
 * Returns { to, data, value } — caller adds nonce/gas/chainId and signs on Ledger.
 */
export function buildLimitUpdateTx(
  safeAddress: string,
  ledgerAddress: string,
  agentWalletAddress: string,
  newLimitUSD: number,
): { to: string; data: string; value: string; gasLimit: number } {
  const allowanceIface = new ethers.Interface(ALLOWANCE_ABI);

  const usdcAmount = BigInt(newLimitUSD) * 1000000n;
  const ethAmount = ethers.parseEther((newLimitUSD / 2500).toFixed(8));

  const innerTxs = [
    { to: ALLOWANCE_MODULE_ADDRESS, value: '0', data: allowanceIface.encodeFunctionData('setAllowance', [agentWalletAddress, USDC_SEPOLIA, usdcAmount, 1440, 0]) },
    { to: ALLOWANCE_MODULE_ADDRESS, value: '0', data: allowanceIface.encodeFunctionData('setAllowance', [agentWalletAddress, WETH_SEPOLIA, ethAmount, 1440, 0]) },
    { to: ALLOWANCE_MODULE_ADDRESS, value: '0', data: allowanceIface.encodeFunctionData('setAllowance', [agentWalletAddress, ETH_ADDRESS, ethAmount, 1440, 0]) },
  ];

  // Pack into MultiSend calldata
  const packed = encodeMultiSendData(innerTxs);
  const multiSendIface = new ethers.Interface(['function multiSend(bytes transactions)']);
  const multiSendCalldata = multiSendIface.encodeFunctionData('multiSend', [packed]);

  // Owner pre-approved signature: when msg.sender is a Safe owner and v=1,
  // the Safe contract accepts it without an ECDSA check (threshold=1).
  const ownerSig = ethers.solidityPacked(
    ['uint256', 'uint256', 'uint8'],
    [BigInt(ledgerAddress), 0n, 1],
  );

  // Encode Safe.execTransaction (DELEGATECALL to MultiSend)
  const safeIface = new ethers.Interface(SAFE_EXEC_ABI);
  const execData = safeIface.encodeFunctionData('execTransaction', [
    MULTISEND_ADDRESS,    // to
    0,                     // value
    multiSendCalldata,     // data
    1,                     // operation = DELEGATECALL
    0,                     // safeTxGas
    0,                     // baseGas
    0,                     // gasPrice
    ethers.ZeroAddress,    // gasToken
    ethers.ZeroAddress,    // refundReceiver
    ownerSig,              // signatures
  ]);

  return { to: safeAddress, data: execData, value: '0', gasLimit: 500000 };
}
