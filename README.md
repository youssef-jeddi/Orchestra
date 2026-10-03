# Orchestra

An AI financial agent that manages your onchain portfolio through natural language. Talk to it like an assistant — *"swap 10 USDC for ETH"*, *"send 0.5 ETH to vitalik.eth"*, *"fund my Safe with 0.01 ETH"*, *"add liquidity with 25 USDC and 0.01 ETH"*, *"what's my balance?"* — and it handles the rest. Small, routine transactions execute instantly from your Safe; anything risky waits for your approval, which you can confirm on your phone after seeing exactly what will execute.

The LLM only **interprets** what you asked. Whether funds move is decided by deterministic, tested code — the model can't approve anything.

Built for **ETHGlobal Cannes 2026**. Runs on the Sepolia testnet.

---

## Architecture

```
  Browser (Next.js)                              Phone
  /simple chat · / presentation app              Telegram bot · /phone/approve (passkey)
        │  HTTPS, Authorization: Bearer <session>        │
        ▼                                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Bridge server (Express) — src/integrations/ledger/serve.ts             │
│                                                                        │
│  POST /intent                                                          │
│  ┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │ Planner  │──▶│ Resolver │──▶│ Policy       │──▶│ Adapter         │  │
│  │ 1 LLM    │   │ tokens,  │   │ pure code:   │   │ swap · send ·   │  │
│  │ call     │   │ ENS,     │   │ AUTO_EXECUTE │   │ deposit · LP    │  │
│  │ (schema- │   │ amounts, │   │ NEEDS_APPROVAL│  │ quote guard     │  │
│  │ checked) │   │ balances │   │ BLOCKED      │   │                 │  │
│  └──────────┘   └──────────┘   └──────────────┘   └───────┬─────────┘  │
│                                                           │            │
│           AUTO_EXECUTE ─▶ agent wallet executes via the Safe            │
│           NEEDS_APPROVAL ─▶ server-held approval (payload + hash) ─▶    │
│                 passkey · Telegram · phone passkey · your own wallet   │
└────────────────────────────────────────────────────────────────────────┘
      │ Groq / Claude     │ 0G Storage          │ Uniswap Trading API │ Sepolia
      │ (planner)         │ (profiles, passkeys,│ (v3 + v4 routes)    │ (Safe, RPC)
                          │  links, activity)
```

### The intent pipeline

Every chat message goes through `POST /intent` (`src/intent/`):

1. **Planner** (`planner.ts`, `prompt.ts`, `schema.ts`) — one LLM call turns the message and recent conversation into JSON: `actions` (swap, send, deposit, add_liquidity, remove_liquidity, balance, price, positions), `clarify`, `reply` or `unsupported`. The output is validated against a strict Zod schema; an invalid reply gets one repair retry with the concrete errors, then the user is asked to rephrase. Unvalidated model output never reaches the rest of the pipeline.
2. **Resolver** (`resolve.ts`) — turns the plan into exact values: token symbols → registry addresses, ENS → address, `"all"` / `"50%"` / `"$20"` → exact amounts. It **rejects amounts above your balance** before anything is built (no failed transaction, no wasted gas), keeps a little ETH for gas where your wallet pays it, and writes the summary from the resolved values — so what you approve is what executes. Anything ambiguous becomes a clarifying question, not a guess.
3. **Policy** (`src/policy/`) — `decide()` computes the verdict from scratch, with no LLM input. See [Risk policy](#risk-policy).
4. **Adapter** (`src/executor/adapters.ts`) — builds the transaction. Swaps fetch a Uniswap quote (v3 and v4 routes, native-ETH pools included) and are **refused if the quote returns more than 5% below market value** at the reference price feed (thin or mispriced pools — common on testnets). Liquidity mints a **full-range Uniswap v3 position** from the Safe, and is refused when the pool's price is more than 5% from market (depositing at a wrong price hands value to arbitrageurs). Removing liquidity finds the Safe's positions (asking which one when several match), withdraws a share or all of it together with the fees earned, and returns WETH as ETH; it isn't price-guarded, since refusing would only trap the funds. Auto-approved swaps, sends and liquidity execute through the Safe with the agent wallet; deposits are only ever signed by your own wallet.

Read-only requests (balance, price, liquidity positions) and conversational replies return straight after the planner and resolver.

---

## Risk policy

The verdict is deterministic, explainable and fail-closed (`src/policy/index.ts`):

| Check | Result |
|---|---|
| Balance / price query | `INFO` |
| Malformed plan, denylisted token | `BLOCKED` |
| Unrecognized action | `NEEDS_APPROVAL` |
| Rolling-24h auto-approved spend would exceed your **daily limit** (default $100) | `NEEDS_APPROVAL` |
| Token outside your verified list *(if configured)* | `NEEDS_APPROVAL` |
| Recipient outside your known addresses *(if configured)* | `NEEDS_APPROVAL` |
| Too many auto-approvals today *(if configured)* | `NEEDS_APPROVAL` |
| More than 10× your typical transaction (median of recent activity, once there are 5+) | `NEEDS_APPROVAL` |
| Otherwise | `AUTO_EXECUTE` |

Rules can only escalate, never weaken. Each wallet has its own policy (`user:profile:<wallet>`), editable from the policy panel. Deposits from your wallet into your own Safe are exempt from the agent limits: you sign them yourself.

---

## Approvals

When the policy says `NEEDS_APPROVAL`, the server stores the **exact payload the agent would execute**, plus its hash, as a pending approval (10-minute expiry, `src/approvals/`). Every approval method approves *that record*; the server never executes a payload sent by the browser. So a compromised frontend can't show you one transaction and execute another.

| Method | How it's confirmed | What you see |
|---|---|---|
| **Passkey** (desktop) | Fingerprint / face in the browser. The WebAuthn challenge is derived from the payload hash. | The chat card |
| **Telegram** | Approve / Reject buttons in a bot chat linked to your wallet | A clear-text description on your phone, **decoded from the stored payload** (amount, full recipient address, why you're asked) — never the planner's summary |
| **Phone passkey** (strongest) | Telegram sends a **Review & approve** link; the phone page shows the decoded transaction and approving takes a passkey on the phone, bound to the payload hash. There is no one-tap Approve button. | The review page on your phone |
| **Ledger** | Signing on the device (`LEDGER_APPROVAL=on`, above the hardware threshold, $1000 by default) | The Ledger screen |
| **Your wallet** | MetaMask / Ledger signs the transaction directly (e.g. deposits) | The wallet's own prompt |

Once a wallet links Telegram, its risky transactions can only be approved there (the desktop passkey is refused for them); once it sets up a phone passkey, only with that passkey. If Telegram can't be reached, nothing executes — there's no fallback to a weaker method.

*Honest limits:* the phone message and review page protect against a compromised browser, not a compromised server — the server builds both the transaction and its description. Only a Ledger decodes the transaction independently. Swaps are re-quoted at execution: you approve the exact input and token pair; the output is guaranteed within the 5% market guard rather than to the unit shown.

---

## Security model

- **Wallet sessions** (`src/auth/`): after connecting, your wallet signs an EIP-712 login once (MetaMask or Ledger, no gas). The server returns an 8-hour HMAC-signed token sent as `Authorization: Bearer`. Every endpoint that acts for a wallet — `/intent`, passkey registration, policy, Safe onboarding, limit updates — takes the wallet **from the session**, never from the request body. The signing secret is generated on first start and kept in `.orchestra/session-secret` (git-ignored); set `SESSION_SECRET` only to share sessions across instances.
- **Telegram linking** requires an EIP-712 signature from the wallet, so nobody can route your approvals to their chat.
- **Phone passkey setup** needs both your signed-in desktop session and your linked Telegram chat: the one-time setup link (10 minutes, single use) is sent there.
- **Spending-limit updates** are only recorded after the chain shows the owner's exact limit-update transaction succeeded.

---

## Tracks

### 0G — Decentralized storage and compute
- **0G Storage** is the agent's persistent memory: per-wallet profiles and policies, activity (for the daily limit and habit baseline), passkeys, Telegram links, Safe records, plans and assessments. Unified `read()` / `write()` / `readMany()` / `append()` API, with an in-memory fallback when the `ZERO_G_*` variables aren't set (nothing survives a restart then).
- **0G Compute** powers the agent runtime (`src/agents/runtime.ts`): the Watcher and the legacy planner agent the eval compares against, switchable between Groq and 0G Compute from the UI. The chat planner uses Groq or Claude (`src/integrations/llm`).

### Uniswap — Swap execution
- Uniswap Trading API with Permit2; v3 and v4 routes (native-ETH pools included)
- Quote sanity check against the reference price feed before anything is signed or executed
- Full-range v3 liquidity positions from the Safe (*"add liquidity with 25 USDC and 0.01 ETH"*): exact-amount approvals reset after the mint, native ETH wrapped and refunded, position NFT held by the Safe
- Positions and removal (*"show my liquidity positions"*, *"withdraw half my USDC/ETH position"*, *"remove liquidity from #1234"*): decrease + collect fees in one call, WETH unwrapped to ETH, the NFT burned when emptied
- Sepolia USDC / WETH / ETH

### Ledger — Hardware security
- Device Management Kit (DMK) over Bluetooth in the browser
- ERC-7730 clear-signing descriptors for Permit2 and the Universal Router (`src/integrations/ledger/`, not yet wired into the signing flow)
- EIP-712 signing for sign-in and Telegram linking; required for spending-limit updates

### Safe — Smart account custody
- A Safe per user (your wallet as owner, the agent wallet as a delegate that executes auto-approved actions)
- On-chain spending limits via the AllowanceModule; `OrchestraPolicy.sol` registry of per-user policies
- Fund it from the chat (*"fund my Safe with 20 USDC"*); the agent can never move funds out of your own wallet

---

## Frontend

Next.js 16 + React 19 (`frontend/`):

- **`/simple`** — the working chat: sign-in, balance and price answers, plan cards with the policy verdict and triggered rules, approve buttons, Safe setup and funding, passkey, Telegram and phone-passkey setup.
- **`/`** — the presentation app (3D scenes, Ledger connection, policy panel, limit updates).
- **`/phone/setup`** and **`/phone/approve/[id]`** — the phone pages opened from Telegram. They call the backend through the `/bridge` proxy (`next.config.mjs`), so only the frontend needs a public address.

---

## Setup

### Prerequisites
- Node.js 18+
- Sepolia ETH for the agent wallet (it pays Safe deployment and execution gas)
- Optional: a Ledger (Nano S/X) with Bluetooth, a Telegram account, `cloudflared` for phone testing

### Environment

```bash
cp .env.example .env
```

| Variable | Needed for |
|---|---|
| `GROQ_API_KEY` | Planner (default provider) — [console.groq.com](https://console.groq.com) |
| `LLM_PROVIDER`, `ANTHROPIC_API_KEY` | Use Claude for the planner instead (`LLM_PROVIDER=anthropic`) |
| `UNISWAP_API_KEY` | Swaps — [hub.uniswap.org](https://hub.uniswap.org) |
| `AGENT_PRIVATE_KEY` | The agent wallet — `npx tsx src/scripts/generate-agent-wallet.ts` |
| `SEPOLIA_RPC_URL` | Sepolia RPC (defaults to a public node) |
| `ZERO_G_PRIVATE_KEY`, `ZERO_G_RPC_URL`, `ZERO_G_INDEXER_URL` | Persistent 0G storage (otherwise in-memory) — tokens at [faucet.0g.ai](https://faucet.0g.ai) |
| `ZERO_G_API_KEY` | 0G Compute for the agent runtime |
| `ORCHESTRA_POLICY_ADDRESS` | On-chain policy registry (optional) |
| `LEDGER_APPROVAL=on` | Require a Ledger above the hardware threshold |
| `TELEGRAM_BOT_TOKEN` | Telegram approvals — create a bot with @BotFather |
| `PUBLIC_APP_URL` | Phone passkey approvals — the frontend's public **https** address |
| `SWAP_MAX_SHORTFALL` | Quote guard threshold (default `0.05`) |
| `LP_MAX_PRICE_DEVIATION` | Liquidity price guard (default `0.05`; `off` for testnet demos, where pools are far from market) |
| `SESSION_SECRET`, `SESSION_TTL_HOURS` | Only to share sessions across instances / change the 8h lifetime |

### Run

```bash
npm install
npm run dev              # bridge server on http://localhost:3001
```

```bash
cd frontend
npm install
npm run dev              # frontend on http://localhost:3000 — open /simple
```

### Telegram and phone passkey approvals (optional)

1. Set `TELEGRAM_BOT_TOKEN` and restart the backend (it long-polls Telegram — no webhook needed).
2. In `/simple`, sign in and click **Link Telegram**: your wallet signs a one-time code, then press Start in the bot chat.
3. For the phone passkey, the frontend needs a public https address. For local testing:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Put the https URL in `PUBLIC_APP_URL` in the backend's `.env` (the frontend reads it from there too) and restart the backend. Then click **Set up phone passkey** and open the link Telegram sends **in Safari or Chrome** — passkeys don't work in Telegram's built-in browser.

Passkeys are bound to a domain: if the address changes (quick tunnels change on every start), set up the phone passkey again. Approvals fall back to the Telegram button until you do.

### Smart contracts (optional)

```bash
cd contracts
forge build
forge script script/DeployOrchestraPolicy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
```

---

## Tests and evaluation

```bash
npm test                 # policy, intent, approvals, Telegram, auth, passkey and liquidity suites (no network)
```

```bash
npm run eval             # score the planner + policy against labelled datasets
```

`eval/run.ts` runs two suites: **parsing** (68 messages → expected structured plans, including typos, multi-turn answers, deposits and liquidity) and **risk** (34 scenarios → expected verdicts, including prompt injection and social engineering). It reports exact/type match, false auto-executions, over-escalation and model latency, and can compare the pipeline against the legacy planner (`--target new,legacy`) or other models (`--provider`, `--model`). Prices, ENS and storage are fixed, and model responses are cached in `eval/.cache` (`--replay` fails on a cache miss instead of calling the API).

---

## Project structure

```
src/
├── intent/                  # NL → validated plan → resolved action
│   ├── planner.ts           # one schema-checked LLM call (+ one repair retry)
│   ├── prompt.ts, schema.ts # planner prompt and output schema
│   ├── resolve.ts           # tokens, ENS, amounts, balance checks, summaries
│   ├── pipeline.ts          # interpretIntent + assessAction (shared with the eval)
│   └── tokens.ts, context.ts
├── policy/                  # deterministic risk engine (pure, tested)
│   ├── index.ts             # decide(), habit profile, valuation
│   ├── quoteCheck.ts        # swap quote vs market guard
│   ├── store.ts             # per-wallet policy + activity (0G, cached)
│   └── prices.ts, priceFeed.ts
├── executor/adapters.ts     # swap · send · deposit · add / remove liquidity · balance
├── approvals/               # server-held approvals + clear-text description
├── auth/                    # EIP-712 login, HMAC session tokens
├── integrations/
│   ├── ledger/serve.ts      # bridge server (Express + WebSocket): all HTTP endpoints
│   ├── llm/                 # Groq / Claude completion client (with eval cache)
│   ├── passkey/             # WebAuthn: desktop + phone passkeys, phone setup links
│   ├── telegram/            # approval bot (linking, messages, long polling)
│   ├── uniswap/             # Trading API client, routing (v3 + v4), liquidity (add, positions, remove)
│   ├── safe/                # deployment, spending limits, Safe transactions
│   └── zero-g/              # 0G storage (+ in-memory fallback), 0G compute
├── agents/                  # agent runtime: Watcher + legacy planner (0G Compute)
└── scripts/                 # agent wallet generation, integration checks

eval/                        # evaluation harness + datasets
contracts/src/OrchestraPolicy.sol

frontend/src/
├── app/simple/              # the chat
├── app/phone/               # phone setup + approval pages
├── app/page.js              # presentation app
├── components/              # notebook, policy panel, Safe panel, 3D scenes
├── hooks/                   # useLedger, useSafe, useSession, useBridge
├── context/                 # OrchestraContext (wallet, Safe, session)
└── lib/                     # bridge client, signing, passkey, phone helpers
```

---

## How it works (example)

**You type:** *"send 150 USDC to vitalik.eth"* (daily limit $100, Telegram and a phone passkey set up)

1. The frontend sends `POST /intent` with your session token.
2. The **planner** returns `{"type":"actions","steps":[{"action":"send","token":"USDC","amount":"150","to":"vitalik.eth"}]}`.
3. The **resolver** maps USDC to its Sepolia address, resolves vitalik.eth, checks your Safe holds 150 USDC, and values the plan at $150.
4. The **policy** sees $150 > $100 daily limit → `NEEDS_APPROVAL`.
5. The adapter builds the transfer; the server stores it as a pending approval and sends Telegram a description decoded from that payload, with a **Review & approve** link.
6. On your phone, the review page shows *Send 150 USDC to 0xd8dA…6045 from your Safe*; you approve with your fingerprint. The passkey's challenge is bound to the payload hash.
7. The agent wallet executes exactly that transfer through the Safe; the page, the Telegram message and the chat show the Etherscan link.

With *"send 20 USDC to vitalik.eth"* instead, step 4 returns `AUTO_EXECUTE` and the transfer executes immediately.

---

## Team

Built by the Orchestra team at ETHGlobal Cannes 2026.
