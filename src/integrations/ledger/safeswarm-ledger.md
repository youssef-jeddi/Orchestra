# SafeSwarm × Ledger — Technical Integration Guide
*ETHGlobal Cannes 2026 | AI Agents x Ledger Track ($6k) + Clear Signing Track ($4k)*

---

## 1. What Ledger Gives You (and Why It Fits Perfectly)

SafeSwarm's core thesis is **hardware-gated AI execution**. Ledger's current SDK stack maps directly onto this in three layers:

| Layer | Ledger Tool | Your Use Case |
|---|---|---|
| Device comms | **DMK** (Device Management Kit) | Detect device, manage session, send signing requests |
| Transaction display | **Clear Signing / ERC-7730** | Show human-readable swap details on Ledger screen |
| Agent payments | **x402 flow** | Sub-$100 autonomous agent ops, paid natively |
| Trust layer | **Device-backed approval** | The physical "approve" button = human-in-the-loop |

---

## 2. The Three Ledger Features You Must Use

### 2.1 DMK — Device Management Kit (`@ledgerhq/device-management-kit`)

This is the **current, non-deprecated** way to talk to a Ledger device. It replaces the old `hw-transport-*` libraries.

```typescript
import { DeviceManagementKitBuilder, ConsoleLogger } from "@ledgerhq/device-management-kit";
import { webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";

// Initialize ONCE at app startup
export const dmk = new DeviceManagementKitBuilder()
  .addLogger(new ConsoleLogger())
  .addTransport(webHidTransportFactory) // WebHID for browser, WebSocket for Node/Electron
  .build();
```

Key DMK concepts you'll use:
- `dmk.listenToAvailableDevices()` → Observable of connected devices
- `dmk.startDiscovering()` → Start USB scanning
- `dmk.connect({ device })` → Returns a `sessionId`
- `dmk.getDeviceSessionState({ sessionId })` → Check if locked/unlocked
- `dmk.executeDeviceAction(...)` → Observable of device action states (pending → approved/rejected)

**Critical for SafeSwarm**: The `executeDeviceAction` observable emits states you can map directly to your agent's state machine:
```
DeviceActionStatus.Pending     → "Waiting for user on device"
DeviceActionStatus.Completed   → "Human approved — execute trade"
DeviceActionStatus.Error       → "User rejected — abort"
```

---

### 2.2 Device Signer Kit — Signing Ethereum Transactions

Once you have a `sessionId`, you use the **Ethereum Signer** to request transaction signatures:

```typescript
import { EthAppBinder } from "@ledgerhq/device-signer-kit-ethereum";

const signerEth = new EthAppBinder({ dmk, sessionId });

// This pauses execution and shows TX on the Ledger screen
const { observable } = signerEth.signTransaction({
  derivationPath: "44'/60'/0'/0/0",
  transaction: unsignedTx,   // ethers.js Transaction object
  options: { domain }         // EIP-712 domain if needed
});

observable.subscribe({
  next: (state) => {
    if (state.status === DeviceActionStatus.Completed) {
      const { v, r, s } = state.output;
      // broadcast the signed tx
    }
  }
});
```

The agent **literally cannot proceed** without the physical button press. This is your hardware gate.

---

### 2.3 Clear Signing / ERC-7730 — The Killer Differentiator

This is where SafeSwarm gets **both tracks** in one shot. Without Clear Signing, Ledger shows raw hex on the device screen ("blind signing"). With it, users see:

```
Swap ETH → USDC
Amount:   0.5 ETH
You get:  ~1,247 USDC
Router:   Uniswap Universal Router
Gas:      ~4.2 gwei
```

You need to create an **ERC-7730 JSON descriptor** for the Uniswap Universal Router. This is a JSON file that tells Ledger how to decode and display calldata.

**Minimal ERC-7730 for a Uniswap swap:**
```json
{
  "$schema": "https://eips.ethereum.org/assets/eip-7730/erc7730-v1.schema.json",
  "context": {
    "contract": {
      "abi": "https://api.etherscan.io/api?module=contract&action=getabi&address=0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
      "deployments": [
        { "chainId": 1, "address": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" }
      ]
    }
  },
  "metadata": {
    "owner": "Uniswap",
    "info": { "url": "https://uniswap.org", "name": "Uniswap Universal Router" }
  },
  "display": {
    "formats": {
      "execute(bytes commands, bytes[] inputs, uint256 deadline)": {
        "intent": "Swap via Uniswap",
        "fields": [
          { "path": "deadline", "label": "Valid Until", "format": "date" }
        ],
        "required": ["commands", "inputs", "deadline"]
      }
    }
  }
}
```

**Validate with the CLI tool:**
```bash
pip install erc7730
erc7730 lint calldata-UniswapUniversalRouter.json
```

👉 **Hackathon tip**: Even a partial/demo ERC-7730 file wins you the Clear Signing track bonus ($4k second track). Build it alongside the agent demo.

---

## 3. The Human-in-the-Loop Architecture

### 3.1 Risk Engine (runs inside your agent swarm)

```typescript
type RiskLevel = "autonomous" | "requires_approval" | "blocked";

function assessRisk(trade: ProposedTrade): RiskLevel {
  if (trade.valueUSD < 100 && trade.tokenVerified && trade.liquidityUSD > 1_000_000) {
    return "autonomous";
  }
  if (trade.valueUSD >= 1000 || !trade.tokenVerified || trade.liquidityUSD < 100_000) {
    return "requires_approval";
  }
  return "autonomous";
}
```

### 3.2 Execution Flow

```
Agent proposes trade
        │
        ▼
   Risk Engine
        │
   ┌────┴─────┐
   │          │
 LOW RISK   HIGH RISK
(<$100,      (>$1k, low
verified)    liquidity,
   │         unverified)
   │              │
Auto-execute   PAUSE SWARM
via Uniswap        │
                Ping Ledger
                   │
              DMK sends TX
              to device screen
                   │
            ┌──────┴──────┐
            │             │
         APPROVED      REJECTED
            │             │
        Broadcast      Log + Abort
        signed TX      notify user
```

### 3.3 Notification Bridge

Since Ledger devices have no network capability, your backend must bridge the agent's pause state to the user's connected Ledger. The flow:

1. Agent sets status to `PENDING_HARDWARE_APPROVAL` in your state store
2. Your frontend (running DMK) watches for this state
3. Frontend calls `signerEth.signTransaction(...)` — device lights up
4. User physically approves/rejects
5. Signature returned → agent resumes or aborts

This means your agent needs a **callback/webhook architecture**:
```typescript
// Agent side (Python/Node)
await agentBus.emit("APPROVAL_REQUIRED", {
  tradeId: uuid,
  tx: unsignedTxHex,
  summary: "Swap 1 ETH → USDC, route via Uniswap V3, gas 4.2 gwei"
});

// Frontend side (browser with DMK)
agentBus.on("APPROVAL_REQUIRED", async ({ tradeId, tx }) => {
  const result = await requestLedgerApproval(tx); // triggers device
  await agentBus.emit("APPROVAL_RESULT", { tradeId, approved: result });
});
```

---

## 4. x402 — Bonus Qualification Criterion

This directly checks the Ledger track's first bullet: *"Build agents that pay for APIs, tools, or services with Ledger-secured payment flows, including x402-style experiences."*

Your sentiment-reading agent or arbitrage detector likely calls external APIs. You can make those payments x402-native:

```typescript
// Agent calls a paid data API
async function fetchSentimentData(token: string) {
  const response = await fetch(`https://data-api.example.com/sentiment/${token}`);
  
  if (response.status === 402) {
    const { paymentRequired } = await response.json();
    // paymentRequired = { amount: "0.01", currency: "USDC", address: "0x..." }
    
    // For small amounts (<$1), agent pays autonomously from its own wallet
    // For larger amounts, Ledger approval required — same risk engine
    await processX402Payment(paymentRequired);
    return fetch(`https://data-api.example.com/sentiment/${token}`); // retry
  }
  return response.json();
}
```

This is a **demo-able feature**: show the agent autonomously paying for data, then show it pausing for Ledger approval on a bigger trade. Clean narrative arc.

---

## 5. What to Build at the Hackathon (Prioritized)

### Day 1 — Core Loop (non-negotiable)
- [ ] DMK setup + device detection in browser UI
- [ ] Risk engine with the $100/$1000 thresholds
- [ ] Agent → DMK bridge (WebSocket or polling)
- [ ] Mock Uniswap swap tx → request Ledger approval → display signed hash

### Day 2 — Polish + Second Track
- [ ] ERC-7730 JSON file for Uniswap Universal Router
- [ ] Clear Signing metadata validated with `erc7730 lint`
- [ ] x402 mock flow for one of the agent's API calls
- [ ] Agent swarm UI showing agent states (researching / proposing / paused / executing)

### Stretch Goals
- [ ] Real Uniswap quote via Uniswap API
- [ ] Submit ERC-7730 PR to Ledger's official registry
- [ ] Policy engine: let user configure thresholds from UI → stored on device

---

## 6. Tech Stack Recommendation

| Layer | Choice | Why |
|---|---|---|
| Agent Swarm | 0G OpenClaw (Python) | Required for 0G track |
| DMK Frontend | Next.js + TypeScript | Best DMK compat, WebHID support |
| Agent↔Frontend bridge | WebSocket (ws) | Low-latency, easy to mock |
| Signing | `@ledgerhq/device-signer-kit-ethereum` | Ethereum native |
| TX Construction | ethers.js v6 | Standard, works with DMK |
| Clear Signing | ERC-7730 JSON + Python CLI | Lightweight, submittable |
| Uniswap | Uniswap SDK / Universal Router | Quote + calldata generation |

---

## 7. Packages to Install

```bash
npm install @ledgerhq/device-management-kit \
            @ledgerhq/device-transport-kit-web-hid \
            @ledgerhq/device-signer-kit-ethereum \
            ethers \
            rxjs

pip install erc7730  # for Clear Signing validation
```

---

## 8. Judging Angle

SafeSwarm hits **both Ledger tracks** with one codebase:

- **AI Agents x Ledger ($6k)**: Human-in-the-loop DeFi swarm with Ledger as the hardware trust gate. Physical device = unforgeable approval.
- **Clear Signing ($4k)**: ERC-7730 descriptor for Uniswap makes the swap human-readable on device. Wins the "build Clear Signing tooling" criterion.

The narrative is crisp: *"AI does 99% of the work. Your thumb does the other 1% — but only when it counts."*
