# Orchestra

An AI financial agent that manages your onchain portfolio through natural language. Talk to it like an assistant — *"swap 10 USDC for ETH"*, *"send 0.5 ETH to vitalik.eth"*, *"fund my account with 0.01 ETH"*, *"add liquidity with 25 USDC and 0.01 ETH"*, *"what's my balance?"* — and it handles the rest. Small, routine transactions execute instantly from your account; anything risky waits for your approval, which you can confirm on your phone after seeing exactly what will execute.

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
│           AUTO_EXECUTE ─▶ agent wallet executes via your account           │
│           NEEDS_APPROVAL ─▶ server-held approval (payload + hash) ─▶    │
│                 passkey · Telegram · phone passkey · your own wallet   │
└────────────────────────────────────────────────────────────────────────┘
      │ Groq / Claude     │ Local storage       │ Uniswap Trading API │ Sepolia
      │ (planner)         │ (profiles, passkeys,│ (v3 + v4 routes)    │ (account, RPC)
                          │  links, activity)
```

### The intent pipeline

Every chat message goes through `POST /intent` (`src/intent/`):

1. **Planner** (`planner.ts`, `prompt.ts`, `schema.ts`) — one LLM call turns the message and recent conversation into JSON: `actions` (swap, send, deposit, add_liquidity, remove_liquidity, balance, price, positions, address), `clarify`, `reply` or `unsupported`. Planned actions (stake/unstake, lend/withdraw_lend/borrow/repay, deposit_yield/withdraw_yield) are understood too, but `comingSoon.ts` answers them in plain words before resolution, so they never reach the limits, approvals or execution. The output is validated against a strict Zod schema; an invalid reply gets one repair retry with the concrete errors, then the user is asked to rephrase. Unvalidated model output never reaches the rest of the pipeline.
2. **Resolver** (`resolve.ts`) — turns the plan into exact values: token symbols → registry addresses, ENS → address, `"all"` / `"50%"` / `"$20"` → exact amounts. It **rejects amounts above your balance** before anything is built (no failed transaction, no wasted gas), keeps a little ETH for gas where your wallet pays it, and writes the summary from the resolved values — so what you approve is what executes. Anything ambiguous becomes a clarifying question, not a guess.
3. **Policy** (`src/policy/`) — `decide()` computes the verdict from scratch, with no LLM input. See [Risk policy](#risk-policy).
4. **Adapter** (`src/executor/adapters.ts`) — builds the transaction. Swaps fetch a Uniswap quote (v3 and v4 routes, native-ETH pools included) and are **refused if the quote returns more than 5% below market value** at the reference price feed (thin or mispriced pools — common on testnets). Liquidity mints a **full-range Uniswap v3 position** from your account, and is refused when the pool's price is more than 5% from market (depositing at a wrong price hands value to arbitrageurs). Removing liquidity finds your account's positions (asking which one when several match), withdraws a share or all of it together with the fees earned, and returns WETH as ETH; it isn't price-guarded, since refusing would only trap the funds. Auto-approved swaps, sends and liquidity execute through your account with the agent wallet; deposits are only ever signed by your own wallet.

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
| First send to an address the account hasn't sent to before *(always on, sends only)* | `NEEDS_APPROVAL` |
| Too many auto-approvals today *(if configured)* | `NEEDS_APPROVAL` |
| More than 10× your typical transaction (median of recent activity, once there are 5+) | `NEEDS_APPROVAL` |
| Automatic actions **paused** (kill switch: for everyone, or for your wallet), or the switch can't be read | `NEEDS_APPROVAL` |
| A value that can't be worked out (no price) | `NEEDS_APPROVAL` |
| Otherwise | `AUTO_EXECUTE` |

Rules can only escalate, never weaken. A recipient counts as known only after a send to it has gone through (the server records it in its own field of the profile, not in the policy you can edit); your own wallet and your own account are always known, and a daily limit of $0 means every payment asks. Each wallet has its own policy (`user:profile:<wallet>`), editable from the policy panel. Deposits from your wallet into your own account are exempt from the agent limits: you sign them yourself.

**Fails closed.** Nothing that spends is built when the limits, the day's activity or a fresh price can't be read. Prices are fresh only when both ETH and USDC came back within 5 minutes; a swap or liquidity check that has no price to compare with refuses. One wallet's verdicts are taken one at a time, counting automatic spends still in progress, so two requests at once can't run past the daily limit together. A spend record that couldn't be saved pauses that wallet's automatic actions until it is saved. `npm run test:fail-closed` checks each dependency (price feed, storage, RPC, quote API, language model).

### Kill switch

One action stops everything the agent would do on its own; while it is on, every payment, swap or liquidity change waits for the owner's OK (approvals, owner-signed sends and deposits keep working; what would be refused is still refused).

- **For everyone:** `POST /admin/kill-switch` with `{"on": true, "reason": "…"}` (or `false` to turn it off), authorised with `Authorization: Bearer $ADMIN_TOKEN`; `GET /admin/kill-switch` shows it. Chats listed in `ADMIN_CHAT_IDS` can send `/pauseall` and `/resumeall` to the bot. Every linked Telegram chat is told. Without `ADMIN_TOKEN` the routes answer 404. If the switch can't be read (also at startup), automatic actions stay paused.
- **For one wallet:** `/pause` in the linked Telegram chat (instant) or **Pause automatic actions** in the Limits sheet. Turning it back on (**Resume**, in the sheet or the banner) needs the same proof as raising a limit: the passkey, or a wallet signature when the wallet has none; an email sign-in without a passkey can't resume. `/resume` in Telegram only sends the link. `/status` says what is on.
- Every change is kept in `audit:killswitch:global` / `audit:killswitch:<wallet>`, and the wallet's Telegram chat is told.

```bash
# from the bridge's machine, with ADMIN_TOKEN in the environment
curl -s -X POST https://bridge.example/admin/kill-switch -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"on":true,"reason":"price feed looks wrong"}'
```

It stops the server from running anything on its own; a leaked agent key used directly is out of its reach (that's the on-chain `SPENDING_MODULE_ADDRESS` cap).

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

- **Wallet sessions** (`src/auth/`): after connecting, your wallet signs an EIP-712 login once (MetaMask or Ledger, no gas). The server returns an 8-hour HMAC-signed token sent as `Authorization: Bearer`. Every endpoint that acts for a wallet — `/intent`, passkey registration, policy, account setup, limit updates — takes the wallet **from the session**, never from the request body. The signing secret is generated on first start and kept in `.orchestra/session-secret` (git-ignored); set `SESSION_SECRET` only to share sessions across instances.
- **Account and market routes need a session too**: `/quote`, `/swap`, `/broadcast`, `/nonce`, `/check-safe` and `/safe-balances` refuse a visitor without one (401), and an address in the request must be the session's wallet or that wallet's own account (403 otherwise). `/check-safe` reports the same setup state as `/onboard/status`; an unfinished account is never "ready". `/health` stays public.
- **Allowed websites** (`ALLOWED_ORIGINS`, `src/integrations/ledger/origins.ts`): the bridge answers browsers only from the origins you list; any other site gets 403 on a request or WebSocket upgrade (the exact origin is echoed back with `Vary: Origin`, never `*`, and no credentials header: the session travels in the `Authorization` header, there are no cookies). Plain HTTP requests with no `Origin` (curl, servers) are not affected, sessions still gate the routes; a WebSocket upgrade without an `Origin` is refused. With `ALLOWED_ORIGINS` unset (local dev) only `localhost` / `127.0.0.1` on any port are allowed, plus the origin of `PUBLIC_APP_URL`. **In production (`NODE_ENV=production`) it must be set, or the bridge refuses to start**; list only the exact https origins of the production frontend. `/mock-trade` (a fake approval for local demos) is off unless `ENABLE_MOCK_TRADE=1`, never on when `NODE_ENV=production`, and needs a session.
- **The WebSocket** (`/ws`) takes the session as its first message, `{"type":"AUTH","token":"<session token>"}` (never in the URL); a socket that doesn't sign in within 5 seconds, or sends a forged or expired token, is closed (code 4401) and receives nothing. Each approval is sent only to sockets signed in as its owner, and only they can answer it.
- **Telegram linking** requires an EIP-712 signature from the wallet, so nobody can route your approvals to their chat.
- **Phone passkey setup** needs both your signed-in desktop session and your linked Telegram chat: the one-time setup link (10 minutes, single use) is sent there.
- **The daily limit** is changed only through `POST /policy`: lowering applies at once; raising needs your passkey or a wallet signature.

---

## Tracks

### 0G — Decentralized storage and compute (optional)
- **Storage** keeps per-wallet profiles and policies, activity (for the daily limit and habit baseline), passkeys, Telegram links, account records, plans and assessments behind one `read()` / `write()` / `readMany()` / `append()` API. By default it's a local file (`.orchestra/storage.json`, git-ignored) that survives restarts with no setup; **0G Storage** is an opt-in backend (`STORAGE_BACKEND=0g` plus the `ZERO_G_*` keys) and is never selected implicitly.
- **0G Compute** powers the agent runtime (`src/agents/runtime.ts`): the Watcher and the legacy planner agent the eval compares against, switchable between Groq and 0G Compute from the UI. The chat planner uses Groq or Claude (`src/integrations/llm`).

### Uniswap — Swap execution
- Uniswap Trading API with Permit2; v3 and v4 routes (native-ETH pools included)
- Quote sanity check against the reference price feed before anything is signed or executed
- Full-range v3 liquidity positions from your account (*"add liquidity with 25 USDC and 0.01 ETH"*): exact-amount approvals reset after the mint, native ETH wrapped and refunded, position NFT held by your account
- Positions and removal (*"show my liquidity positions"*, *"withdraw half my USDC/ETH position"*, *"remove liquidity from #1234"*): decrease + collect fees in one call, WETH unwrapped to ETH, the NFT burned when emptied
- Sepolia USDC / WETH / ETH

### Ledger — Hardware security
- Device Management Kit (DMK) over Bluetooth in the browser
- ERC-7730 clear-signing descriptors for Permit2 and the Universal Router (`src/integrations/ledger/`, not yet wired into the signing flow)
- EIP-712 signing for sign-in and Telegram linking

### Your account — Smart account custody
- One Orchestra account per user (a Safe smart account under the hood; your wallet and the agent wallet are its owners; the agent executes auto-approved actions)
- One daily limit, enforced by the server's policy engine (there is no on-chain spending limit); `OrchestraPolicy.sol` registry of per-account policies
- Fund it from the chat (*"fund my account with 20 USDC"*); the agent can never move funds out of your own wallet

---

## Frontend

Next.js 16 + React 19 (`frontend/`):

- **`/simple`** — the working chat: sign-in, balance and price answers, plan cards with the policy verdict and triggered rules, approve buttons, account setup and funding, passkey, Telegram and phone-passkey setup.
- **`/`** — the presentation app (3D scenes, Ledger connection, policy panel, limit updates).
- **`/phone/setup`** and **`/phone/approve/[id]`** — the phone pages opened from Telegram. They call the backend through the `/bridge` proxy (`next.config.mjs`), so only the frontend needs a public address.

---

## Setup

### Prerequisites
- Node.js 18+
- Sepolia ETH for the agent wallet (it pays account creation and execution gas)
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
| `STORAGE_BACKEND`, `STORAGE_FILE` | Where data is kept: a local file by default (`.orchestra/storage.json`); `memory` for throwaway runs; `0g` to opt into 0G Storage |
| `ZERO_G_PRIVATE_KEY`, `ZERO_G_RPC_URL`, `ZERO_G_INDEXER_URL` | Only with `STORAGE_BACKEND=0g` — tokens at [faucet.0g.ai](https://faucet.0g.ai) |
| `ZERO_G_API_KEY` | 0G Compute for the agent runtime |
| `ORCHESTRA_POLICY_ADDRESS` | On-chain policy registry (optional) |
| `SPENDING_MODULE_ADDRESS` | Turns on the on-chain $1000/day cap (optional). New accounts then have the user as their only owner; the agent calls `SpendingLimitModule.exec(safe, calls[])` (Call-only batches, no MultiSend). A request past what is left today is refused and the user can sign it themselves. Unset, behaviour is unchanged. Deploy as in [`contracts/README.md`](contracts/README.md). |
| `LEDGER_APPROVAL=on` | Require a Ledger above the hardware threshold |
| `TELEGRAM_BOT_TOKEN` | Telegram approvals — create a bot with @BotFather |
| `PUBLIC_APP_URL` | Phone passkey approvals — the frontend's public **https** address |
| `PRIVY_APP_ID` | Sign-in with a passkey, email or any wallet (see below); without it, MetaMask + Ledger |
| `PRIVY_APP_SECRET` | Lets passkey users approve with their sign-in passkey (server only) |
| `SWAP_MAX_SHORTFALL` | Quote guard threshold (default `0.05`) |
| `LP_MAX_PRICE_DEVIATION` | Liquidity price guard (default `0.05`; `off` for testnet demos, where pools are far from market) |
| `ALLOWED_ORIGINS` | Websites that may call the bridge (HTTP and WebSocket), comma-separated; `*` works in a host (`https://*.example.com`) or a port (`http://localhost:*`). Unset: `http://localhost:*,http://127.0.0.1:*` (local dev). **Required in production** — the bridge won't start without it: e.g. `https://getorchestra.xyz,https://www.getorchestra.xyz` (no localhost, no previews). Staging: the staging frontend plus your Vercel team's preview pattern, `https://orchestra-*-<team-slug>.vercel.app`, and its own agent wallet. `PUBLIC_APP_URL`'s origin is always allowed too |
| `ENABLE_MOCK_TRADE=1` | Local dev only: enables `POST /mock-trade`. Off by default and ignored when `NODE_ENV=production` |
| `LOG_USER_MESSAGES=1` | Local dev only: also logs the text of each chat message. Off by default and ignored when `NODE_ENV=production`; the log otherwise holds no message text, no plan summaries, no recipients and only shortened wallet addresses (`0x5879…5723`), with a short request id, outcome, risk score and timings per `/intent` request |
| `SESSION_SECRET`, `SESSION_TTL_HOURS` | Only to share sessions across instances / change the 8h lifetime |
| `ADMIN_TOKEN` | *Optional.* Turns on the team's kill switch, `POST/GET /admin/kill-switch` (see [Kill switch](#kill-switch)). At least 32 characters: `openssl rand -hex 32`. Unset (or shorter), the routes answer 404 and nothing else changes. Keep it secret: it can pause and resume automatic actions for everyone (it can't move funds) |
| `ADMIN_CHAT_IDS` | *Optional.* Telegram chat ids, comma-separated, that may send `/pauseall` and `/resumeall` to the bot (needs `TELEGRAM_BOT_TOKEN`). Unset, no chat can. Your chat id: message @userinfobot |

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

### Privy sign-in (optional)

Newcomers sign up with a passkey (or email) and get a wallet without installing anything; people who already use crypto connect MetaMask, Phantom, Coinbase, Rabby or Trust (WalletConnect). Either way the wallet owns their account, and the bridge session comes from Privy's identity token (`POST /auth/privy`), so there's no second signature. Ledger still connects directly.

1. Create an app at [dashboard.privy.io](https://dashboard.privy.io) and put its ID in `PRIVY_APP_ID` (the frontend reads it from the root `.env` too).
2. In the dashboard: enable the **Passkey**, **Email** and **Wallet** login methods, turn on **identity tokens**, and add `http://localhost:3000` (and your public URL) to the allowed origins.
3. Restart both servers; **Sign in** in `/simple` opens Privy's window.
4. Optional: put the dashboard's app secret in `PRIVY_APP_SECRET` (backend only). A passkey user's sign-in passkey then also approves risky transactions; Privy creates it in our page, so it's bound to our domain and the server checks it against the public key in the user's Privy record. Without the secret they register a second passkey with **Add passkey**.

### Telegram and phone passkey approvals (optional)

1. Set `TELEGRAM_BOT_TOKEN` and restart the backend (it long-polls Telegram — no webhook needed).
2. In `/simple`, sign in and click **Link Telegram**: your wallet signs a one-time code, then press Start in the bot chat.
3. For the phone passkey, the frontend needs a public https address. For local testing:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Put the https URL in `PUBLIC_APP_URL` in the backend's `.env` (the frontend reads it from there too) and restart the backend. Then click **Set up phone passkey** and open the link Telegram sends **in Safari or Chrome** — passkeys don't work in Telegram's built-in browser.

Passkeys are bound to a domain: if the address changes (quick tunnels change on every start), set up the phone passkey again. Approvals fall back to the Telegram button until you do.

### Testing failures (development only)

To see how the app behaves when the stored limits or the day's activity can't be read, start the bridge with `ORCHESTRA_FAULT_INJECT` set to one or more of `profile-read`, `activity-read` (the read fails), `profile-timeout`, `activity-timeout` (it never answers, so the 2-second timeout fires), comma-separated. `price-read` / `price-stale` take the price away, `killswitch-read` makes the bridge start with automatic actions paused, and `activity-write` makes saving a spend fail (that wallet's automatic actions then pause):

```bash
ORCHESTRA_FAULT_INJECT=profile-read PORT=3011 STORAGE_BACKEND=memory TELEGRAM_BOT_TOKEN= npx tsx src/integrations/ledger/serve.ts
```

A send, swap or liquidity request then answers "I can't check your limits right now, so nothing was done" and runs nothing; chat and balance questions still work and the Limits sheet shows an error instead of empty settings. It is ignored when `NODE_ENV=production` or the storage is 0G, and the bridge refuses to start (exit code 1) if it is set with `NODE_ENV=production`.

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

`eval/run.ts` runs two suites: **parsing** (155 messages → expected structured plans: every planner action, including the planned stake, lend and yield ones, with paraphrases, typos, unclear amounts, multi-turn answers and French, Spanish and German) and **risk** (43 scenarios → expected verdicts, including prompt injection, social engineering and planned actions that must do nothing). `npm run test:eval-datasets` (part of `npm test`, no model) checks every expected answer against the planner schema, unique ids and at least 5 cases per action. It reports exact/type match, false auto-executions, over-escalation and model latency, and can compare the pipeline against the legacy planner (`--target new,legacy`) or other models (`--provider`, `--model`). Prices, ENS and storage are fixed, and model responses are cached in `eval/.cache` (`--replay` fails on a cache miss instead of calling the API).

---

## Project structure

```
src/
├── intent/                  # NL → validated plan → resolved action
│   ├── planner.ts           # one schema-checked LLM call (+ one repair retry)
│   ├── prompt.ts, schema.ts # planner prompt and output schema
│   ├── resolve.ts           # tokens, ENS, amounts, balance checks, summaries
│   ├── pipeline.ts          # interpretIntent + assessAction (shared with the eval)
│   ├── comingSoon.ts        # plain answers for planned actions (stake, lend, yield)
│   └── tokens.ts, context.ts
├── policy/                  # deterministic risk engine (pure, tested)
│   ├── index.ts             # decide(), habit profile, valuation
│   ├── quoteCheck.ts        # swap quote vs market guard
│   ├── store.ts             # per-wallet policy + activity (cached)
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
│   └── zero-g/              # storage (local file by default, 0G opt-in), 0G compute
├── agents/                  # agent runtime: Watcher + legacy planner (0G Compute)
└── scripts/                 # agent wallet generation, integration checks

eval/                        # evaluation harness + datasets
contracts/src/OrchestraPolicy.sol

frontend/src/
├── app/simple/              # the chat
├── app/phone/               # phone setup + approval pages
├── app/page.js              # presentation app
├── components/              # notebook, policy panel, account panel, 3D scenes
├── hooks/                   # useLedger, useSafe, useSession, useBridge
├── context/                 # OrchestraContext (wallet, account, session)
└── lib/                     # bridge client, signing, passkey, phone helpers
```

---

## How it works (example)

**You type:** *"send 150 USDC to vitalik.eth"* (daily limit $100, Telegram and a phone passkey set up)

1. The frontend sends `POST /intent` with your session token.
2. The **planner** returns `{"type":"actions","steps":[{"action":"send","token":"USDC","amount":"150","to":"vitalik.eth"}]}`.
3. The **resolver** maps USDC to its Sepolia address, resolves vitalik.eth, checks your account holds 150 USDC, and values the plan at $150.
4. The **policy** sees $150 > $100 daily limit → `NEEDS_APPROVAL`.
5. The adapter builds the transfer; the server stores it as a pending approval and sends Telegram a description decoded from that payload, with a **Review & approve** link.
6. On your phone, the review page shows *Send 150 USDC to 0xd8dA…6045 from your account*; you approve with your fingerprint. The passkey's challenge is bound to the payload hash.
7. The agent wallet executes exactly that transfer through your account; the page, the Telegram message and the chat show the Etherscan link.

With *"send 20 USDC to vitalik.eth"* instead, the amount is within the limit, but the first send to a new address always asks: step 4 returns `NEEDS_APPROVAL` ("You haven't sent to this address before"). Once that send has gone through, vitalik.eth's address is remembered and a later *"send 20 USDC to vitalik.eth"* executes immediately.

---

## Team

Built by the Orchestra team at ETHGlobal Cannes 2026.
