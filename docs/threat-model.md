# Orchestra threat model (ORC-37)

Status: October 2026, Sepolia testnet. Written with ORC-38 (per-account agent keys + SpendingLimitModuleV2).
Owner: Hassene, Youssef. Update this file in the same PR as any change to who can move funds.

## 1. What we protect

| Asset | Where it lives | Worst case if lost |
|---|---|---|
| User funds | Each user's Safe 1.4.1 (user is the only owner, threshold 1) | Drained |
| Agent authority over a Safe | v1: the shared `AGENT_PRIVATE_KEY`, enabled as module operator on every Safe. v2: one key per account (`agentkey:<wallet>`), encrypted at rest on the bridge | v1: every account up to $1000/day each. v2: that one account up to $1000/day |
| Relayer key (`AGENT_PRIVATE_KEY` in v2) | Bridge env | Its Sepolia ETH (gas money). Cannot sign batches for any Safe |
| `AGENT_KEY_ENCRYPTION_KEY` | Bridge env | With a copy of storage: every per-account key → same as the v1 shared key |
| Module admin | 2-of-2 Safe (Hassene + Youssef) | Unpause, propose agents for any Safe (with delay), change guardian. No direct power over funds |
| Module guardian | Separate address | Pause everyone, revoke/cancel any account's agent: denial of service only |
| Sessions, passkeys, Telegram links | Bridge storage | Someone acts in the app as the user (within the user's approval rules) |
| Secrets in env | `.env` on the VM, GitHub Actions secrets | See per-secret rows below |

Out of scope today: mainnet, real money, the `orchestra-paper/` research code, the 0G compute experiments.

## 2. Trust boundaries

```
 browser / phone ──(HTTPS, origin allowlist, session token)──▶ bridge (Azure VM)
                                                               │  LLM (plans only, never keys)
 Telegram ──(bot webhook / polling)────────────────────────────▶│  storage (file / 0G / memory)
                                                               │  Uniswap Trading API, Chainlink, RPC
                                                               ▼
                                           Sepolia: user Safe ◀── SpendingLimitModule(V2) ◀── relayer tx
```

The on-chain module is the only boundary that holds if the bridge is fully compromised. Everything
the bridge checks off-chain (risk engine, approvals, kill switch) is defence in depth on top of it.

## 3. Who can do what

Each row: what the party can do if it is malicious or compromised, what stops it today, and what is
still open.

### 3.1 The LLM (prompt injection through chat, token names, ENS, web content)
- Can: propose any plan text; pick recipients, tokens, amounts inside a plan.
- Stops it: plans are parsed into typed intents; the risk engine and approval tiers (passkey, Ledger above
  the hardware threshold when `LEDGER_APPROVAL=on`) gate risky ones; the module caps every account at
  $1000/day and only allows known call shapes.
- Open: an approved-but-misleading summary (the user approves "swap" and the plan sends). Mitigation is
  clear signing / plain summaries built from calldata, not from LLM text.

### 3.2 The bridge / VM (RCE, malicious dependency, leaked SSH, bad deploy)
- Can, v1: sign as the shared agent → every Safe, $1000/day each, through any allowed shape (including a
  Universal Router `execute` whose output goes to the attacker — v1 doesn't decode the router).
- Can, v2: read storage and `AGENT_KEY_ENCRYPTION_KEY` from the same box → every per-account key → same
  reach as v1, but the router can no longer send swap output elsewhere and the guardian can pause on-chain
  in one transaction.
- Stops it: module ceiling; v2 pause/revoke; nothing else (the bridge *is* the agent).
- Open: keys and their encryption key sit on the same VM. That is why ORC-112 moves the key to Azure Key
  Vault (decrypt/sign without exporting it). A TEE (enclave signer) was considered and parked: too much
  infrastructure for a testnet; revisit before mainnet.

### 3.3 Agent keys
- v1: one key, plaintext in env, also the gas payer. One leak = all accounts.
- v2: one key per account, AES-256-GCM at rest, AAD binds the ciphertext to `wallet + address` (a record
  copied to another account fails to decrypt). Keys never hold ETH and never send transactions; they only
  sign EIP-712 `Exec` / `ProposeAgent` with a per-Safe nonce and a 15-minute deadline. One leaked key = one
  account, $1000/day, until revoked.
- Production refuses to run v2 without `AGENT_KEY_ENCRYPTION_KEY`; local dev uses a public key and warns.

### 3.4 The relayer (v2 `AGENT_PRIVATE_KEY`)
- Can: submit, delay or drop signed batches; spend its own ETH.
- Cannot: change a batch (signature covers safe, every call, nonce, deadline, chainId, module), replay it
  (nonce), use it on another Safe/module/chain (domain + struct), or keep it for later (deadline).
- Anyone else can relay too — by design; the signature is the authorisation.

### 3.5 The browser (XSS, malicious extension, phishing site)
- Can: act with the user's session (ask the agent to do things), show a fake summary.
- Stops it: origin allowlist (exact origins in production, ORC-92), approvals on a second factor for risky
  actions, module ceiling.
- Open: owner-sign requests are signed in the browser wallet; see finding 4.1.

### 3.6 The phone (passkey approvals)
- Can: approve risky actions for its linked user.
- Stops it: WebAuthn bound to `PUBLIC_APP_URL`'s domain; one device per approval; ceiling still applies.

### 3.7 Telegram
- Can: a hijacked Telegram account approves what the linked user would approve; a leaked bot token lets
  someone impersonate the bot to users (phishing) and read approval messages.
- Stops it: Telegram approvals are only for linked wallets; over-cap actions still need the owner's own
  wallet signature; the module ceiling.

### 3.8 Storage (file on the VM, 0G, memory in tests)
- Can (write access): swap a user's Safe address record, session, passkey or (v2) agent key ciphertext.
- Stops it: v2 records the module each account was created with and the agent the module names on-chain is
  checked before signing (a swapped key just fails `BadSignature`); AAD binding on ciphertext.
- Open: storage integrity in general (no MAC over records other than agent keys).

### 3.9 Third parties
| Party | Abuse | Today |
|---|---|---|
| Uniswap Trading API | Returns calldata that routes output elsewhere or uses V4/Permit2 permits | v2: on-chain decoder refuses anything but V3 + wrap/unwrap/sweep/transfer/pay-portion to the Safe; bridge pre-checks the same rules and requests V3-only routes in module mode |
| Chainlink ETH/USD | Stale or wrong price under-meters spending | Module fails closed on stale/zero; a wrong-but-fresh price is trusted |
| RPC provider | Lies about state, drops txs | Signing reads (nonce, agent, paused) come from RPC; lying can only make our own checks refuse or batches fail; it can't forge a signature |
| Privy | Issues identity tokens | Compromised Privy = sign in as anyone (then see 3.5) |
| GitHub / CI | Malicious workflow deploys a bad bridge | Same as 3.2. The token used by agents has no `workflow` scope |

## 4. Findings

### 4.1 Server-built owner-sign transactions (new)
When a batch is over the daily ceiling, the bridge builds the Safe transaction for the owner to sign
(`src/integrations/safe/ownerSign.ts`, `holdOwnerSign` / `offerOwnerSign` → `safeCallFor`). For several
steps that is a **MultiSend DelegateCall** (`operation: 1`), built by the server and shown to the wallet as
typed data. A compromised bridge can therefore ask the owner to sign *any* Safe transaction — including
`addOwnerWithThreshold`, `enableModule(attacker)` or a DelegateCall to attacker code — behind an honest
looking summary. The owner's signature is the only check and is above every ceiling.
Recommended (not in this PR): refuse `operation: 1` except to the canonical MultiSendCallOnly, decode and
show each inner call in the frontend from the calldata (not from the server summary), and refuse Safe
self-calls / module changes in owner-sign offers.

### 4.2 Shared agent key (v1) — fixed by ORC-38
One key for every account, also paying gas. Fixed in v2 by per-account keys and a separate relayer.

### 4.3 Router recipients unchecked (v1) — fixed by ORC-38
v1 allowed any `execute`; swap output could go anywhere. v2 decodes commands and recipients.

### 4.4 Agent-as-owner fallback — fixed by ORC-38
Without `SPENDING_MODULE_ADDRESS` new Safes made the agent a co-owner (no ceiling at all). In production
the bridge now refuses to create accounts without a module, and a malformed module address refuses all
actions instead of silently falling back.

### 4.5 No on-chain stop — fixed by ORC-38
v2 adds a global pause (guardian or admin, instant; unpause admin only) and per-account revoke. This is
independent of ORC-39's off-chain kill switch (`feat/safety-switches`): either alone stops agent actions;
the on-chain one also holds when the bridge is the problem.

## 5. Target design

1. **Per-account agent keys** (ORC-38, this PR): stored encrypted on the bridge behind one
   `getAgentSigner(account)`; the only code that touches key material.
2. **SpendingLimitModuleV2** (ORC-38): per-Safe agent, signed relayed batches, rotation with delay
   (48h on mainnet), instant revoke and pause, decoded router, $1000/day per Safe. No cap across users.
3. **Key Vault** (ORC-112, Youssef): move the encryption key, then the signing, into Azure Key Vault so a
   copy of the VM disk and env is no longer enough. `getAgentSigner` is the seam.
4. **TEE signer**: parked. Reconsider before mainnet or real value.
5. Owner-sign hardening (finding 4.1).

## 6. Guards still missing

- Owner-sign offers are not restricted (4.1).
- No alerting on `GlobalPause`, `AgentRevoked`, `AgentProposed` events; a proposal for a Safe nobody
  expected is the signal of a compromised admin or agent. Someone should watch these during the delay.
- No per-account anomaly detection off-chain (many max-size batches in a row).
- Storage records other than agent keys aren't integrity-protected.
- The daily window resets at UTC midnight: up to $2000 can leave across the boundary.
- Fee recipients: the decoder refuses a `PAY_PORTION` / `TRANSFER` to anyone but the Safe or router markers.
  If the Trading API adds an interface fee to someone else, those swaps will be refused (safe failure).

## 7. Audit focus (before mainnet)

1. `SpendingLimitModuleV2.execSigned`: signature domain, nonce handling, check-then-run order, metering.
2. `SpendingLimitCallPolicyV2._checkRouter`: command coverage, recipient word positions, the flag mask.
3. `SafeSetupHelperV2` + CREATE2 address prediction on the bridge (the agent is part of the setup data).
4. Rotation: who can propose, the delay, accept while paused (refused), the admin proposing while paused
   (allowed, so a revoked account can be re-keyed).
5. `agentKeys.ts`: AAD, fail-closed config, concurrent creation.
6. Owner-sign path (4.1).
