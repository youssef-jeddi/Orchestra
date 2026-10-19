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
