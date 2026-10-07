// ── Shared signing / execution helpers ──
// Turns the bridge's unsigned payloads (sendData / quoteData) into broadcast
// transactions. Supports both kinds of wallet:
//   • Ledger    — sign the raw tx locally, broadcast via the bridge.
//   • Providers — MetaMask, or a Privy wallet (passkey account or a connected
//                 MetaMask/Phantom/WalletConnect…): hand the tx to the wallet
//                 (eth_sendTransaction), which signs and broadcasts it itself.
// Used by the /simple route; the full app has its own inline copy of this flow.

import { broadcast, submitSwap, getNonce } from './bridge';

const CHAIN_ID = 11155111; // Sepolia
const CHAIN_ID_HEX = '0xaa36a7';
const explorer = (h) => `https://sepolia.etherscan.io/tx/${h}`;

/** True for wallets that sign through an EIP-1193 provider (everything but Ledger). */
export function usesProvider(ledger) {
  return !!ledger.connectionType && ledger.connectionType !== 'ledger';
}

// Wallets sign on whatever network is active, so switch to Sepolia first
// (adding it if the wallet doesn't know it). Throws if the user refuses.
// Also needed for EIP-712 signatures: wallets reject typed data whose domain
// chainId isn't the active network ("must match the active chainId").
export async function ensureSepolia(eth) {
  if (!eth) throw new Error('Wallet not available');
  const current = await eth.request({ method: 'eth_chainId' });
  if (String(current).toLowerCase() === CHAIN_ID_HEX) return;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (err) {
    if (err?.code !== 4902) throw new Error('Switch your wallet to the Sepolia test network to continue.');
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: CHAIN_ID_HEX,
        chainName: 'Sepolia',
        nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
        blockExplorerUrls: ['https://sepolia.etherscan.io'],
      }],
    });
  }
  const after = await eth.request({ method: 'eth_chainId' });
  if (String(after).toLowerCase() !== CHAIN_ID_HEX) {
    throw new Error('Switch your wallet to the Sepolia test network to continue.');
  }
}

function toHex(v) {
  if (v == null) return '0x0';
  if (typeof v === 'string' && v.startsWith('0x')) return v;
  try { return '0x' + BigInt(v).toString(16); } catch { return '0x0'; }
}

// Provider wallets: sign + broadcast in one call, returns the tx hash.
async function providerSend(ledger, tx) {
  const eth = ledger.getProvider();
  await ensureSepolia(eth);
  // chainId makes the wallet reject the tx outright if the network changed underneath us.
  return eth.request({
    method: 'eth_sendTransaction',
    params: [{ from: ledger.walletAddress, to: tx.to, data: tx.data || '0x', value: toHex(tx.value), chainId: CHAIN_ID_HEX }],
  });
}

// Ledger: build EIP-1559 tx, sign the bytes, broadcast the signed tx.
async function ledgerSendTx(ledger, tx, gasLimit) {
  const { ethers } = await import('ethers');
  const nonceData = await getNonce(ledger.walletAddress);
  const built = ethers.Transaction.from({
    to: tx.to, data: tx.data || '0x', value: tx.value || '0x0',
    chainId: CHAIN_ID, gasLimit, type: 2,
    maxFeePerGas: BigInt(nonceData.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(nonceData.maxPriorityFeePerGas),
    nonce: nonceData.nonce,
  });
  const sig = await ledger.sign(built.unsignedSerialized);
  const signed = built.clone();
  signed.signature = ethers.Signature.from(sig);
  const result = await broadcast(signed.serialized);
  return result.txHash || result.hash;
}

async function sendTx(ledger, tx, gasLimit) {
  return usesProvider(ledger)
    ? providerSend(ledger, tx)
    : ledgerSendTx(ledger, tx, gasLimit);
}

// ── Fund a Safe from the connected wallet (ETH or ERC-20) ──
export async function depositToSafe(ledger, safeAddress, token, amount) {
  const { ethers } = await import('ethers');
  const t = String(token || 'eth').toLowerCase();
  let tx;
  let gasLimit = 21000;
  if (t === 'eth') {
    tx = { to: safeAddress, value: ethers.parseEther(amount).toString(), data: '0x' };
  } else {
    const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
    const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
    const tokenAddr = t === 'usdc' ? USDC : WETH;
    const decimals = t === 'usdc' ? 6 : 18;
    const iface = new ethers.Interface(['function transfer(address to, uint256 amount)']);
    tx = { to: tokenAddr, value: '0', data: iface.encodeFunctionData('transfer', [safeAddress, ethers.parseUnits(amount, decimals)]) };
    gasLimit = 80000;
  }
  const txHash = await sendTx(ledger, tx, gasLimit);
  return { txHash, explorerUrl: explorer(txHash) };
}

// ── Send: single transfer tx ──
export async function executeSend(ledger, data) {
  const txHash = await sendTx(ledger, data.sendData.unsignedTx, 60000);
  return { txHash, explorerUrl: explorer(txHash) };
}

// ── Swap: (optional approval) → (optional Permit2 typed data) → swap tx ──
export async function executeSwap(ledger, data) {
  const q = data.quoteData;
  if (!q) throw new Error('No quote to sign');
  // The Permit2 typed data is bound to Sepolia too, so switch before any signature.
  if (usesProvider(ledger)) await ensureSepolia(ledger.getProvider());

  // 1. Permit2 / ERC20 approval.
  if (q.approvalNeeded && q.approvalTx) {
    await sendTx(ledger, q.approvalTx, q.approvalTx.gasLimit || 100000);
    await new Promise((r) => setTimeout(r, 5000)); // let it land before the swap
  }

  // 2. Permit2 typed-data signature.
  let permit2Signature;
  if (q.permitData) {
    const { ethers } = await import('ethers');
    const typedData = {
      domain: q.permitData.domain,
      types: q.permitData.types,
      primaryType: q.permitData.primaryType
        || Object.keys(q.permitData.types).find((k) => k !== 'EIP712Domain')
        || 'PermitSingle',
      message: q.permitData.values,
    };
    const sig = await ledger.signTyped(typedData);
    // Ledger returns {v,r,s}; provider wallets return a serialized hex string.
    permit2Signature = typeof sig === 'string'
      ? sig
      : ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized;
  }

  // 3. Resolve the swap calldata from the bridge.
  const swapResult = await submitSwap(q.quote, q.permitData, permit2Signature, q.routing);
  if (swapResult.type === 'uniswapx') {
    return { orderId: swapResult.orderId };
  }

  // 4. Execute the swap tx.
  const unsignedTx = swapResult.unsignedTx;
  const gasLimit = Math.ceil(Number(unsignedTx.gasLimit || unsignedTx.gas || 350000) * 1.2);
  const txHash = await sendTx(ledger, unsignedTx, gasLimit);
  return { txHash, explorerUrl: explorer(txHash) };
}
