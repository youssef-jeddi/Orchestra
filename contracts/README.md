## Orchestra contracts

### OrchestraPolicy
Per-account registry (Safe address → metadata). Does **not** enforce spending. See `DeployOrchestraPolicy` below.

### SpendingLimitModule (ORC-107)
Fixed **$1000/day** on-chain ceiling for the agent. The agent is **not** a Safe owner; it calls `exec(safe, calls[])` and each call is a Safe **Call** (no DelegateCall / MultiSend).

- **Metering:** outbound USD once per batch — ETH+WETH via Chainlink ETH/USD, USDC at $1.
- **Selector allowlist:** USDC/WETH `transfer` / `approve` (spender ∈ {Permit2, Universal Router, NPM}); WETH `deposit`/`withdraw`; Permit2 `approve` only for WETH/USDC → Universal Router; Universal Router `execute`; NPM `mint`/`collect`/`unwrapWETH9` with `recipient == safe`, plus `increaseLiquidity`/`decreaseLiquidity`/`refundETH`/`multicall` of those. Plain ETH sends (empty data) allowed.
- **Blocked `to`:** the Safe itself, this module, and configured Safe singleton/proxy-factory addresses.
- **Fail closed:** stale/missing feed, bad selector/spender/recipient/token, over-cap.
- **Day boundary:** counter resets at UTC midnight — up to $2000 can cross two calendar days (same as a plain per-day limit).
- **Ceiling:** immutable `DAILY_LIMIT_CENTS = 100_000`.

#### Deploy (Sepolia) — humans only
```shell
$ export AGENT_ADDRESS=<agent wallet address>
$ forge script script/DeploySpendingLimitModule.s.sol:DeploySpendingLimitModule \
    --rpc-url <sepolia_rpc_url> --broadcast
```
Optional env: `ETH_USD_FEED`, `WETH`, `USDC`, `USDC_DECIMALS`, `FEED_STALE_AFTER` (default 24h on Sepolia), `UNIVERSAL_ROUTER`, `PERMIT2`, `POSITION_MANAGER`.

Expected log lines include `SpendingLimitModule: 0x…` and the protocol addresses. Set `SPENDING_MODULE_ADDRESS` on the bridge after the integration PR.

#### Test
```shell
$ forge test --match-contract SpendingLimitModuleTest -vv
```

### SpendingLimitModuleV2 (ORC-38)
Same fixed **$1000/day** per Safe, gross metering and Call-only batches as v1, but **one agent key per Safe** instead of one shared key, so a leaked key reaches one account only. Three contracts:

- `SafeSetupHelperV2` — a new Safe delegatecalls it from `setup()` to enable the module and record its own agent in one step.
- `SpendingLimitCallPolicyV2` — the fixed call rules (split out only so each deploy fits under the gas cap, see below).
- `SpendingLimitModuleV2` — agents, signatures, metering, pause.

What changed from v1:

- **Per-Safe agent** (`agentOf[safe]`). Set instantly by the Safe itself (owner transaction or the setup helper). Rotation is **propose → accept after `agentChangeDelay`** (deploy parameter: ≥ 48h enforced on mainnet; 10 min on Sepolia by default). The admin can propose; the current agent can propose its successor with a signature. **Revoke and cancel are instant** (guardian, admin or the Safe).
- **Signed batches, relayed.** The agent never sends transactions: it signs an EIP-712 `Exec(safe, calls, nonce, deadline)` bound to chainId and the module, and anyone may submit it with `execSigned`. The per-Safe nonce makes each signature single-use; a failing inner call reverts everything, so the nonce isn't burned. Signatures must be 65 bytes, low-s, v 27/28. The bridge's relayer (`AGENT_PRIVATE_KEY`) pays gas; per-account keys never hold ETH.
- **Global pause.** `pause()` by the guardian or admin (instant) stops every signed batch and agent change; `unpause()` admin only. The pause is on-chain and independent of the bridge's off-chain kill switch (ORC-39).
- **Roles.** `admin` = the 2-of-2 Safe of Hassene + Youssef (two-step `transferAdmin`/`acceptAdmin`); `guardian` = a separate address that can only pause, revoke and cancel. Neither can move funds.
- **Universal Router decoded.** `execute` is allowed only with V3 exact-in/out (`0x00`/`0x01`), `WRAP_ETH` (`0x0b`), `UNWRAP_WETH` (`0x0c`), `SWEEP` (`0x04`), `TRANSFER` (`0x05`), `PAY_PORTION` (`0x06`), each recipient = the Safe or the router's `MSG_SENDER`/`ADDRESS_THIS` markers. V4, V2, `PERMIT2_*`, sub-plans, the allow-revert flag and everything else are refused. No recipient allowlist, no per-transaction cap and no total cap across users (by decision).
- **Blocked targets** also include the module and the setup helper.

#### Deploy (Sepolia) — humans only
Since the 2026 Sepolia gas repricing, deploying code costs about 1,550 gas per byte and forge's local simulation still uses the old price, so `forge script` underestimates gas 4–5× and every transaction runs out of gas. `script/deploy-v2.sh` uses `forge create` with explicit gas limits (measured with `eth_estimateGas` on Sepolia in Oct 2026: helper ~0.80M, rules ~8.43M, module ~12.23M; limits 1.2M / 10.5M / 15.5M, all under the 16,777,216 per-transaction cap). `via_ir` is on in `foundry.toml` because without it the module is ~20% larger and its deploy sits within 5% of the cap.

```shell
$ cd contracts
$ export RPC_URL=<sepolia_rpc_url>
$ export ADMIN_ADDRESS=<2-of-2 Safe of Hassene + Youssef>
$ export GUARDIAN_ADDRESS=<separate guardian address>
$ export AGENT_CHANGE_DELAY=600        # optional; seconds
$ ./script/deploy-v2.sh --account <cast wallet name>   # or --ledger / --private-key …
```
It asks you to type `deploy`, sends three transactions and reads back VERSION, admin, guardian, delay, helper, rules and router. The deployer pays ~21.5M gas in total and gets no role.

Then on the bridge: `SPENDING_MODULE_ADDRESS=<module>`, `AGENT_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)` (back it up), make sure `AGENT_PRIVATE_KEY`'s address holds Sepolia ETH (it now only relays and pays gas), restart.

#### Test
```shell
$ forge test --match-contract SpendingLimitModuleV2Test -vv
$ FORK_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test --match-contract SpendingLimitModuleV2ForkTest -vv   # real Safe 1.4.1, nothing broadcast
```

#### Emergency
```shell
$ cast send <module> "pause()" --rpc-url <rpc> --account <guardian>          # everyone, instant
$ cast send <module> "revokeAgent(address)" <safe> --rpc-url <rpc> --account <guardian>   # one account, instant
```
`unpause()` and `proposeAgent(safe, newAgent)` go through the admin Safe. Routine key rotation: `npx tsx src/scripts/rotate-agent-key.ts propose <wallet>`, then `accept <wallet>` after the delay (humans only; sends real transactions with the relayer).

---

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy OrchestraPolicy (Sepolia)

The registry keeps one entry per account (Safe address). Only the **agent** may register accounts, so the contract is deployed with the agent's address:

1. Deploy with the agent key (or pass the agent's address explicitly with `AGENT_ADDRESS`). This sends a real transaction, so only run it on purpose:
   ```shell
   $ AGENT_ADDRESS=<agent wallet address> forge script script/DeployOrchestraPolicy.s.sol:DeployOrchestraPolicy \
       --rpc-url <sepolia_rpc_url> --private-key <deployer_key> --broadcast
   ```
   Without `AGENT_ADDRESS` the address broadcasting the deployment becomes the agent, so use the agent key.
2. Set `ORCHESTRA_POLICY_ADDRESS` on the server to the printed address and restart the bridge.
3. Accounts set up earlier are registered on the new contract by the agent at their next sign-in (one agent-paid transaction each). They stay usable meanwhile.

An older deployment (entries keyed by the sender) can't be upgraded; it is simply no longer used.

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
