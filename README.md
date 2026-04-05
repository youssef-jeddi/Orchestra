# Orchestra

An AI financial agent that manages your onchain portfolio via natural language. Talk to it like an assistant — *"swap 10 USDC for ETH"*, *"send 0.5 ETH to vitalik.eth"*, *"check my balance"* — and it handles everything autonomously. High-value transactions require physical Ledger hardware approval; small ones execute instantly.

Built for **ETHGlobal Cannes 2026**.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Next.js Frontend                   │
│  Chat UI ─ Ledger Connect ─ Safe Panel ─ Settings    │
└──────────────────┬───────────────────────────────────┘
                   │ HTTP + WebSocket
┌──────────────────▼───────────────────────────────────┐
│                  Bridge Server (Express)              │
│                    POST /intent                       │
│                                                       │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────┐ │
│  │  Planner AI  │───▶│ Gatekeeper AI │───▶│ Executor │ │
│  └─────────────┘    └──────────────┘    └──────────┘ │
│         │                  │                  │       │
│    0G Compute         0G Storage          Uniswap    │
│    (inference)     (plans, profiles)    (swap routing)│
└──────────────────────────────────────────────────────┘
         │                                      │
    ┌────▼────┐                          ┌──────▼──────┐
    │  Ledger  │                          │ Safe Account │
    │ (signing)│                          │ (custody)    │
    └─────────┘                          └─────────────┘
```

### Intent Pipeline

Every user message flows through:

1. **Planner AI** — Parses natural language into a structured plan (swap, send, balance, add_liquidity) with steps, params, and USD estimate. Runs on Groq or 0G Compute.
2. **Gatekeeper AI** — Reads the plan and user profile (including spending limit) from 0G Storage. Assesses risk and decides: `AUTO_EXECUTE`, `NEEDS_APPROVAL`, or `BLOCKED`.
3. **Server-side safety net** — Recomputes USD value independently and overrides the AI verdict if the math is clearly wrong (e.g. AI approves a $500 swap when the limit is $5).
4. **Executor** — For swaps: fetches Uniswap quote, builds tx. For sends: builds transfer tx. Auto-executed intents go straight through; approval-required intents prompt the Ledger.

### Agents

| Agent | Role | Inference | Storage |
|-------|------|-----------|---------|
| **Planner** | NL → structured plan (steps, params, USD) | Groq / 0G Compute | Writes plans to 0G |
| **Gatekeeper** | Risk assessment against user profile & limits | Groq / 0G Compute | Reads plans + profile from 0G, writes assessments |
| **Watcher** | Background portfolio monitoring | Groq / 0G Compute | Reads/writes portfolio snapshots |

Each agent follows the same runtime: **Providers** (gather context from 0G Storage) → **LLM inference** → **Actions** (write results back to 0G Storage).

---

## Tracks

### 0G — Decentralized AI & Storage

- **0G Compute**: Decentralized LLM inference for both agents (Planner + Gatekeeper). Runtime-switchable between Groq (fast, dev) and 0G Compute (decentralized, demo) via the UI settings.
- **0G Storage**: Shared agent memory — plans, risk assessments, user profiles, portfolio snapshots, and spending limits are all persisted to 0G's decentralized storage network. Agents read/write through a unified `read()` / `write()` / `readMany()` / `append()` API.

### Uniswap — Swap Execution

- Real swap routing via Uniswap API with Permit2 support
- Quote fetching with gas estimation
- Supports both classic swaps and UniswapX orders
- Sepolia testnet (USDC, WETH, ETH)

### Ledger — Hardware Security

- Ledger Device Management Kit (DMK) for browser-based BLE connection
- Transaction signing for swaps (approval tx + permit2 typed data + swap tx)
- Spending limit updates require Ledger signature (on-chain Safe AllowanceModule tx)
- Only triggered when the Gatekeeper flags `NEEDS_APPROVAL`

### Safe — Smart Account Custody

- Auto-deployed Safe smart account per user (Ledger as owner, agent wallet as delegate)
- On-chain spending limits via AllowanceModule (ETH, WETH, USDC)
- `OrchestraPolicy.sol` — on-chain registry of per-user policies (Safe address, agent wallet, spending limit)
- Agent wallet can execute within limits; exceeding limits requires Ledger co-signature

---

## Frontend

Next.js 16 + React 19 app with:

- **Chat interface** — Clean black UI, typewriter responses, Planner/Gatekeeper reasoning display
- **Ledger connection** — BLE discovery, address display, transaction signing
- **Settings panel** — Model selector (Groq / 0G Compute), spending limit modifier (Ledger-signed on-chain update)
- **Safe panel** — Deploy Safe, view balances, manage spending limits
- **Approval overlay** — Floating cards for pending Ledger approval requests via WebSocket

---

## Setup

### Prerequisites

- Node.js 18+
- A Ledger hardware wallet (Nano S/X) with Bluetooth
- Sepolia testnet ETH (for gas)

### Environment

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

| Variable | Source |
|----------|--------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `ZERO_G_PRIVATE_KEY` | Funded wallet for 0G transactions ([faucet.0g.ai](https://faucet.0g.ai)) |
| `ZERO_G_API_KEY` | 0G Compute marketplace |
| `UNISWAP_API_KEY` | [hub.uniswap.org](https://hub.uniswap.org) |
| `SEPOLIA_RPC_URL` | Alchemy / Infura Sepolia endpoint |
| `AGENT_PRIVATE_KEY` | Generate with `npx tsx src/scripts/generate-agent-wallet.ts` |
| `ETHERSCAN_API_KEY` | [etherscan.io/apis](https://etherscan.io/apis) |

### Install & Run

```bash
# Backend
npm install
npx tsx src/integrations/ledger/serve.ts

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

The bridge server runs on `localhost:3001`, the frontend on `localhost:3000`.

### Smart Contracts (optional)

```bash
cd contracts
forge build
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
```

---

## Project Structure

```
src/
├── agents/
│   ├── planner/          # NL → structured plan
│   │   ├── index.ts      # Agent config + system prompt
│   │   ├── actions/      # writePlan
│   │   └── providers/    # latestMessageProvider
│   ├── gatekeeper/       # Risk assessment
│   │   ├── index.ts      # Agent config + system prompt
│   │   ├── actions/      # writeRiskAssessment
│   │   └── providers/    # userProfileProvider, latestPlanProvider, ...
│   ├── watcher/          # Portfolio monitoring
│   └── runtime.ts        # Agent execution engine (providers → LLM → actions)
├── integrations/
│   ├── ledger/
│   │   ├── serve.ts      # Bridge server (Express + WS), /intent handler
│   │   ├── bridge.ts     # WebSocket approval bridge
│   │   └── dmk.ts        # Ledger DMK wrapper
│   ├── uniswap/
│   │   ├── api.ts        # Quote + approval check
│   │   ├── routing.ts    # Route fetching
│   │   ├── execution.ts  # Swap execution
│   │   └── types.ts      # Token addresses, chain config
│   ├── safe/
│   │   ├── deploy.ts     # Safe deployment
│   │   ├── detect.ts     # Detect existing Safe
│   │   ├── spendingLimit.ts  # AllowanceModule integration
│   │   └── transaction.ts    # Safe transaction helpers
│   └── zero-g/
│       ├── compute.ts    # LLM inference (Groq / 0G Compute switch)
│       └── storage.ts    # 0G Storage read/write/append
├── executor.ts           # Plan execution dispatcher
└── types/                # TypeScript types (agents, storage, safe)

contracts/
└── src/OrchestraPolicy.sol   # On-chain policy registry

frontend/
├── src/
│   ├── app/page.js           # Main page
│   ├── components/
│   │   ├── FuturisticNotebook.jsx  # Chat UI
│   │   ├── ConnectWallet.jsx       # Ledger connection
│   │   ├── ApprovalOverlay.jsx     # Pending approval cards
│   │   └── SafePanel.jsx          # Safe management
│   ├── hooks/
│   │   ├── useLedger.js      # Ledger DMK lifecycle
│   │   ├── useBridge.js      # WebSocket auto-reconnect
│   │   └── useSafe.js        # Safe account management
│   ├── context/
│   │   └── OrchestraContext.jsx  # Central state (ledger + bridge + safe)
│   └── lib/
│       ├── bridge.js         # HTTP API helpers
│       └── ledger.js         # Ledger DMK wrapper
└── next.config.mjs
```

---

## How It Works (Example)

**User types:** *"swap 10 USDC for ETH"*

1. Frontend sends `POST /intent { message: "swap 10 USDC for ETH", autoApproveLimit: 5 }`
2. **Planner AI** generates: `{ steps: [{ action: "swap", params: { symbolIn: "USDC", symbolOut: "ETH", amount: 10 } }], totalEstimatedValueUsd: 10 }`
3. **Gatekeeper AI** reads user profile from 0G (`autoApproveLimit: 5`), sees $10 > $5 → `NEEDS_APPROVAL`
4. Server-side confirms: $10 > $5 → `NEEDS_APPROVAL` (safety net agrees)
5. Bridge server fetches Uniswap quote, returns full response to frontend
6. Frontend shows reasoning + "Sign & Swap" button
7. User clicks → Ledger prompts for signature → tx broadcast → swap confirmed

If the limit had been $100, step 3 would return `AUTO_EXECUTE` and the swap would proceed without Ledger interaction.

---

## Team

Built by the Orchestra team at ETHGlobal Cannes 2025.
