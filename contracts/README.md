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
