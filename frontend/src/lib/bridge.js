// ─── Bridge HTTP + WebSocket helpers ───
// All communication with the backend bridge server (localhost:3001)

export const BRIDGE_HTTP = 'http://localhost:3001';
export const BRIDGE_WS = 'ws://localhost:3001/ws';

export async function bridgeFetch(path, options = {}) {
  const res = await fetch(`${BRIDGE_HTTP}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Specific API calls ──

export async function sendIntent(message, walletAddress) {
  return bridgeFetch('/intent', {
    method: 'POST',
    body: JSON.stringify({ message, walletAddress }),
  });
}

export async function getQuote(walletAddress, amount) {
  return bridgeFetch('/quote', {
    method: 'POST',
    body: JSON.stringify({ walletAddress, amount }),
  });
}

export async function submitSwap(quote, permitData, signature, routing) {
  return bridgeFetch('/swap', {
    method: 'POST',
    body: JSON.stringify({ quote, permitData, signature, routing }),
  });
}

export async function broadcast(signedTx) {
  return bridgeFetch('/broadcast', {
    method: 'POST',
    body: JSON.stringify({ signedTx }),
  });
}

export async function getNonce(address) {
  return bridgeFetch(`/nonce/${address}`);
}

export async function checkSafe(address) {
  return bridgeFetch(`/check-safe?address=${address}`);
}

export async function deploySafe(ledgerAddress, spendingLimitUSD) {
  return bridgeFetch('/onboard', {
    method: 'POST',
    body: JSON.stringify({ ledgerAddress, spendingLimitUSD }),
  });
}

export async function getSafeBalances(address) {
  return bridgeFetch(`/safe-balances?address=${address}`);
}

export async function prepareLimitUpdate(newLimitUSD, ledgerAddress) {
  return bridgeFetch('/prepare-limit-update', {
    method: 'POST',
    body: JSON.stringify({ newLimitUSD, ledgerAddress }),
  });
}

export async function finalizeLimitUpdate(newLimitUSD, ledgerAddress, txHash) {
  return bridgeFetch('/finalize-limit-update', {
    method: 'POST',
    body: JSON.stringify({ newLimitUSD, ledgerAddress, txHash }),
  });
}

export async function triggerMockTrade() {
  return bridgeFetch('/mock-trade', {
    method: 'POST',
    body: JSON.stringify({
      summary: 'Swap 0.5 ETH -> ~1,247 USDC via Uniswap V3',
      riskLevel: 'requires_approval',
    }),
  });
}

export async function setComputeProvider(provider) {
  return bridgeFetch('/set-compute-provider', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export async function getComputeProvider() {
  return bridgeFetch('/compute-provider');
}
