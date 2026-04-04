# SafeSwarm × Uniswap — Technical Integration Guide
*ETHGlobal Cannes 2026 | Best Uniswap API Integration Track ($10k)*

---

## 1. The Uniswap Stack You're Actually Working With

There are two distinct layers to Uniswap that you need to mentally separate:

| Layer | What it is | Your usage |
|---|---|---|
| **Trading API** | Hosted REST API by Uniswap Labs | Quote, approval check, swap execution — your agent's primary tool |
| **Protocol** (v2/v3/v4 + UniswapX) | On-chain smart contracts | What the API routes through — mostly abstracted away for you |

For SafeSwarm at a hackathon, **the Trading API does 95% of the heavy lifting**. You do NOT need to interact with smart contracts directly for basic swaps. The API handles routing, calldata generation, Permit2 messages, and UniswapX order submission.

Get your API key here: [developers.uniswap.org/dashboard](https://developers.uniswap.org/dashboard)
Base URL: `https://trade-api.gateway.uniswap.org/v1`

---

## 2. The Three-Step Swap Workflow (The Core Loop)

Every swap through the Trading API follows this exact flow. Understand this cold before writing a line of code.

```
Step 1: /check_approval  → Does the user's wallet allow Permit2 to spend their token?
Step 2: /quote           → Get the best route + pre-built calldata + Permit2 message
Step 3: /swap or /order  → Submit the signed transaction or gasless order
```

### Step 1 — Check Approval

```typescript
const BASE = 'https://trade-api.gateway.uniswap.org/v1';
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.UNISWAP_API_KEY!,
};

const approval = await fetch(`${BASE}/check_approval`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({
    walletAddress: userAddress,
    token: TOKEN_IN,          // e.g. WETH address on Sepolia
    tokenOut: TOKEN_OUT,      // e.g. USDC address on Sepolia
    amount: amountInWei,      // string, raw wei
    chainId: 11155111,        // Sepolia testnet
  }),
});

const { approval: approvalTx } = await approval.json();

// Only sign + send if approval is needed (often it's already done)
if (approvalTx) {
  // This is where Ledger signs: approvalTx is a ready-to-send tx object
  const signedApproval = await ledgerSign(approvalTx); 
  await provider.sendTransaction(signedApproval);
}
```

**Important:** Once approved, the token stays approved indefinitely. On testnet you'll only do this once per token per wallet.

### Step 2 — Get a Quote

```typescript
const quoteRes = await fetch(`${BASE}/quote`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({
    swapper: userAddress,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    tokenInChainId: 11155111,
    tokenOutChainId: 11155111,
    amount: amountInWei,
    type: 'EXACT_INPUT',
    // SafeSwarm-specific: request best price across all protocols
    protocols: ['V3', 'V4', 'UNISWAPX_V2'],
    routingPreference: 'BEST_PRICE',
    // urgency matters for your gas-aware agent
    urgency: 'normal',   // or 'urgent' if gas already low
    autoSlippage: 'DEFAULT',
  }),
});

const { quote, permitData, routing } = await quoteRes.json();
// routing will be: 'CLASSIC' (v2/v3/v4) or 'DUTCH_V2' / 'DUTCH_V3' (UniswapX)
// permitData will contain the Permit2 message if needed
```

**What's inside `quote`:** the API returns fully pre-built calldata. You don't need to construct transactions — you just need to sign and broadcast. This is what your agent passes to Ledger for approval.

**What's inside `permitData`:** a Permit2 EIP-712 message. This is an off-chain signature (not a transaction). Your agent asks the user to sign this on their Ledger device as well.

### Step 3a — Classic Swap (v2/v3/v4 pools)

```typescript
// Sign the Permit2 message on Ledger (off-chain, EIP-712)
let permit2Signature: string | undefined;
if (permitData) {
  permit2Signature = await signerEth.signTypedData({
    domain: permitData.domain,
    types: permitData.types,
    message: permitData.values,
  }); // This triggers the Ledger device
}

// Submit the swap
const swapRes = await fetch(`${BASE}/swap`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({
    quote,
    permitData,
    signature: permit2Signature,
  }),
});

const { swap: swapTx } = await swapRes.json();
// swapTx is a ready-to-send transaction — broadcast it
await provider.sendTransaction(swapTx);
```

### Step 3b — UniswapX Gasless Order (DUTCH_V2 / DUTCH_V3)

```typescript
// When routing === 'DUTCH_V2' or 'DUTCH_V3', use /order instead of /swap
// The Permit2 signature IS the order authorization — no on-chain gas tx needed
const orderRes = await fetch(`${BASE}/order`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({
    quote,
    signature: permit2Signature, // from signing on Ledger
  }),
});
// A filler network picks this up and executes it — user pays no gas
```

---

## 3. SafeSwarm-Specific Integration Points

### 3.1 The Agent's Role in the Swap Pipeline

Your agent swarm doesn't need to manage swap logic itself — it just needs to:

1. **Decide** what to swap (sentiment agent + arbitrage agent → trade proposal)
2. **Call `/quote`** to get real execution data (price, route, calldata)
3. **Assess risk** using the quote response fields (liquidity check, token verification, USD value)
4. **Either auto-execute or pause for Ledger approval** based on the risk engine

```typescript
// Agent-side trade proposal → quote → risk assessment
async function proposeAndAssess(trade: TradingSignal) {
  const quoteData = await fetchQuote(trade);
  
  const riskContext = {
    valueUSD: quoteData.quote.priceImpact,
    routing: quoteData.routing,       // UniswapX = more protected
    tokenVerified: isVerifiedToken(quoteData.quote.tokenIn),
    poolLiquidity: quoteData.quote.liquidityUSD,
    gasPriceGwei: quoteData.quote.gasFeeUSD,
  };
  
  const riskLevel = riskEngine.assess(riskContext);
  
  if (riskLevel === 'autonomous') {
    await executeSwap(quoteData); // signs with agent hot wallet
  } else {
    await requestLedgerApproval(quoteData); // pauses for hardware sign
  }
}
```

### 3.2 Gas-Aware Agent — The "Swap When Gas < 5 Gwei" Feature

This is your key demo feature. The `urgency` field in `/quote` controls price vs. speed tradeoffs, and you can poll gas before quoting:

```typescript
async function executeWhenGasIsLow(trade: TradingSignal, maxGwei: number) {
  while (true) {
    const feeData = await provider.getFeeData();
    const currentGwei = Number(feeData.gasPrice) / 1e9;
    
    if (currentGwei <= maxGwei) {
      // Gas is cheap enough — get a quote with urgent execution
      const quoteData = await fetchQuote({ ...trade, urgency: 'urgent' });
      await executeSwap(quoteData);
      break;
    }
    
    console.log(`Gas at ${currentGwei.toFixed(1)} gwei. Waiting for ≤${maxGwei}...`);
    await sleep(15_000); // check every 15 seconds
  }
}
// Agent instruction: "swap my ETH to USDC when gas drops below 5 gwei"
// → executeWhenGasIsLow({ tokenIn: WETH, tokenOut: USDC, amount: ... }, 5)
```

### 3.3 Token Risk Scoring Using Quote Response

The `/quote` response contains everything your risk engine needs to classify a trade. No extra calls needed:

```typescript
function assessTokenRisk(quote: QuoteResponse): RiskScore {
  return {
    // High price impact = low liquidity = HIGH RISK
    highPriceImpact: parseFloat(quote.priceImpact) > 1.0,
    // UniswapX routing means MEV-protected = LOWER RISK
    mevProtected: ['DUTCH_V2', 'DUTCH_V3'].includes(quote.routing),
    // Raw USD value of the trade
    tradeSizeUSD: parseFloat(quote.gasUseEstimateUSD) * 100, // rough proxy
    // If routing is CLASSIC and through obscure v2 pool = HIGHER RISK
    usesObscurePool: quote.routing === 'CLASSIC' && quote.route?.length > 2,
  };
}
```

---

## 4. Special Uniswap Features Worth Using in SafeSwarm

### 4.1 UniswapX — The MEV Protection Angle

This is **the most important feature to highlight in your demo** for the Uniswap judges.

<br>

When your agent proposes a large trade, routing through UniswapX (DUTCH_V2/V3) instead of classic AMM pools gives:

- **MEV protection**: orders execute via a private filler auction, sandwiching is impossible
- **Gasless execution**: the filler pays gas, your user only signs a Permit2 message
- **No failed transactions**: if the order can't be filled at the quoted price, it simply expires — the user pays nothing

For SafeSwarm specifically: **a UniswapX order still requires a Ledger signature** (the Permit2 EIP-712 message). So you keep the human-in-the-loop even for gasless orders. This is a genuinely novel pairing.

```
Ledger + UniswapX = hardware-authenticated, MEV-protected, gasless DeFi
```

### 4.2 Routing Preference — Let Your Agent Be Smart About It

Your agent can vary `protocols` based on its risk classification:

```typescript
// For safe, blue-chip pairs (ETH/USDC, ETH/WBTC): allow UniswapX
const safeProtocols = ['V3', 'V4', 'UNISWAPX_V2'];

// For unverified/low-liq tokens: classic AMM only, more predictable
const conservativeProtocols = ['V3', 'V4'];

// For time-sensitive arbitrage: fastest route only
const arbiProtocols = ['V3'];   // + routingPreference: 'FASTEST'
```

### 4.3 Permit2 + Ledger — The Deep Integration

Permit2 signatures are EIP-712 typed data. This is exactly what Ledger's Clear Signing is designed to display beautifully on the device screen. When your agent triggers a Permit2 signing request:

- Without Clear Signing: Ledger shows raw hex hash — blind signing
- With your ERC-7730 descriptor: Ledger shows *"Allow Uniswap to spend up to 1 ETH until [timestamp]"*

This is the precise integration point where both tracks intersect. Build the ERC-7730 file for Permit2 messages, and every Ledger approval in SafeSwarm becomes fully human-readable.

### 4.4 `autoSlippage` + `spreadOptimization` — Agent Quality-of-Life

Two underused API parameters that your agent should use intelligently:

```typescript
{
  autoSlippage: 'DEFAULT',          // Let Uniswap calculate optimal slippage
  spreadOptimization: 'EXECUTION',  // Optimize for execution quality (not just price)
  urgency: 'normal'                 // 'urgent' for time-sensitive agent trades
}
```

---

## 5. Sepolia Testnet Setup

### Key Addresses (Sepolia)

```typescript
// Uniswap Universal Router on Sepolia
const UNIVERSAL_ROUTER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';

// Permit2 on Sepolia
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Common test tokens on Sepolia
const WETH_SEPOLIA  = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const USDC_SEPOLIA  = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
```

### Faucets
- ETH Sepolia: [sepoliafaucet.com](https://sepoliafaucet.com) or Alchemy Faucet
- USDC Sepolia: mint directly from the Circle Sepolia faucet

### Chain ID
```typescript
const CHAIN_ID = 11155111; // Sepolia — use this in ALL API calls
```

---

## 6. The Exact Quote → Ledger Approval Flow

This is the combined Uniswap + Ledger integration in one sequence:

```
Agent proposes: "Swap 0.5 ETH → USDC"
        │
        ▼
POST /quote (Uniswap API)
Returns: { quote, permitData, routing: 'DUTCH_V2' }
        │
        ▼
Risk Engine: trade > $1000 → REQUIRES_LEDGER_APPROVAL
        │
        ▼
Agent sends to frontend bridge:
  {
    tradeId,
    summary: "Swap 0.5 ETH → ~1,247 USDC via UniswapX (MEV Protected)",
    permitData,   ← EIP-712 message to sign
    routing: 'DUTCH_V2'
  }
        │
        ▼
Frontend calls: signerEth.signTypedData(permitData)
  → Ledger device shows (with Clear Signing):
    "Approve Uniswap to spend 0.5 ETH
     Valid for: 30 minutes
     Via: UniswapX"
        │
   [User presses ✓ on device]
        │
        ▼
signature returned to frontend
        │
        ▼
POST /order (UniswapX gasless)
  body: { quote, signature }
        │
        ▼
Filler network executes — no gas paid by user
Agent logs: { orderId, txHash, status: 'FILLED' }
```

---

## 7. What to Build (Prioritized for the Hackathon)

### Must-Have (Day 1)
- [ ] API key provisioned from [developers.uniswap.org/dashboard](https://developers.uniswap.org/dashboard)
- [ ] `/check_approval` + `/quote` + `/swap` happy path on Sepolia
- [ ] Quote response feeding into the risk engine (price impact + routing type)
- [ ] One real testnet transaction hash (required for submission)

### Core Demo Features (Day 2)
- [ ] Gas-watch loop: "execute when gas < X gwei" using `/quote` + `urgency`
- [ ] UniswapX routing detection → show "MEV Protected" badge in UI
- [ ] Agent logs showing quote → risk assessment → Ledger approval → execution
- [ ] Multiple transactions on Sepolia for the submission video

### Stretch Goals
- [ ] Routing comparison: show agent choosing V3 vs UniswapX based on token risk
- [ ] Sentiment agent driving trade pair selection (0G OpenClaw → Uniswap quote)
- [ ] `/check_approval` result integrated into pre-flight risk display on Ledger screen

---

## 8. Packages to Install

```bash
npm install axios ethers    # HTTP calls + tx construction
# No Uniswap SDK needed — the Trading API handles everything
```

The Trading API returns fully-formed transaction calldata. You don't need `@uniswap/sdk-core`, `@uniswap/v3-sdk`, or any on-chain SDK packages for basic swaps. The REST API is self-contained.

---

## 9. Judging Angle

The Uniswap track explicitly calls out: *"AI-driven systems... automated strategies... agent-based systems."* SafeSwarm is a textbook answer to this.

Your submission narrative: **"SafeSwarm is an AI hedge fund that uses the Uniswap Trading API as its execution engine — it quotes, routes, and executes DeFi strategies autonomously, but gates high-value trades behind hardware approval via Ledger. It's the first system where UniswapX's gasless MEV protection is paired with physical hardware authentication."**

The transaction IDs from Sepolia are required — get them early on Day 1.
