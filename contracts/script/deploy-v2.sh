#!/usr/bin/env bash
# ─── Contracts — deploy SpendingLimitModuleV2 (ORC-38) ───
# HUMANS ONLY (Hassene or Youssef). Never run this from an agent session.
#
# Deploys three contracts, one transaction each, in this order:
#   1. SafeSetupHelperV2          new Safes delegatecall it in setup() to enable the module + set their agent
#   2. SpendingLimitCallPolicyV2  the fixed call rules (allowlist, Universal Router decoding)
#   3. SpendingLimitModuleV2      per-Safe agents, signed batches, $1000/day, global pause
#
# Why not `forge script`: Sepolia's 2026 gas repricing makes code deposit cost ~1,550 gas/byte,
# and forge's local simulation still uses the old price, so its gas estimates come out 4-5x too
# low and every transaction runs out of gas. We pass explicit gas limits instead, measured with
# eth_estimateGas on Sepolia (Oct 2026): helper ~0.80M, rules ~8.43M, module ~12.23M. Each limit
# below stays under the 16,777,216 per-transaction cap (EIP-7825); unused gas is not charged.
#
# Usage (from contracts/):
#   export RPC_URL=<sepolia rpc>
#   export ADMIN_ADDRESS=<2-of-2 Safe of Hassene + Youssef>
#   export GUARDIAN_ADDRESS=<separate address: pause / revoke / cancel only>
#   export AGENT_CHANGE_DELAY=600          # optional, seconds; mainnet requires >= 172800
#   ./script/deploy-v2.sh --account <your cast wallet>     # or --ledger, etc. (signer flags)
#
# Optional overrides (Sepolia defaults, same as v1): ETH_USD_FEED WETH USDC USDC_DECIMALS
# FEED_STALE_AFTER UNIVERSAL_ROUTER PERMIT2 POSITION_MANAGER.
set -euo pipefail

: "${RPC_URL:?set RPC_URL}"
: "${ADMIN_ADDRESS:?set ADMIN_ADDRESS (the 2-of-2 admin Safe)}"
: "${GUARDIAN_ADDRESS:?set GUARDIAN_ADDRESS}"
if [ "$(printf %s "$ADMIN_ADDRESS" | tr A-F a-f)" = "$(printf %s "$GUARDIAN_ADDRESS" | tr A-F a-f)" ]; then
  echo "ADMIN_ADDRESS and GUARDIAN_ADDRESS must differ" >&2; exit 1
fi
if [ "$#" -eq 0 ]; then echo "pass signer flags, e.g. --account deployer or --ledger" >&2; exit 1; fi

ETH_USD_FEED="${ETH_USD_FEED:-0x694AA1769357215DE4FAC081bf1f309aDC325306}"
WETH="${WETH:-0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14}"
USDC="${USDC:-0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238}"
USDC_DECIMALS="${USDC_DECIMALS:-6}"
FEED_STALE_AFTER="${FEED_STALE_AFTER:-86400}"
UNIVERSAL_ROUTER="${UNIVERSAL_ROUTER:-0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD}"
PERMIT2="${PERMIT2:-0x000000000022D473030F116dDEE9F6B43aC78BA3}"
POSITION_MANAGER="${POSITION_MANAGER:-0x1238536071E1c677A632429e3655c799b22cDA52}"
AGENT_CHANGE_DELAY="${AGENT_CHANGE_DELAY:-600}"
# Safe 1.4.1 singleton, L2 singleton, proxy factory; Safe 1.3.0 singleton, proxy factory.
BLOCKED="[0x41675C099F32341bf84BFc5382aF534df5C7461a,0x29fcB43b46531BcA003ddC8FCB67FFE91900C762,0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67,0x69f4D1788e39c87893C980c06EdF4b7f686e2938,0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2]"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
echo "Chain $CHAIN_ID  admin $ADMIN_ADDRESS  guardian $GUARDIAN_ADDRESS  delay ${AGENT_CHANGE_DELAY}s"
read -r -p "Deploy SpendingLimitModuleV2 to chain $CHAIN_ID? Type 'deploy' to continue: " ok
[ "$ok" = "deploy" ] || { echo "Cancelled."; exit 1; }

forge build >/dev/null 2>&1

# Prints the deployed address of one `forge create`.
create() {
  forge create --rpc-url "$RPC_URL" --broadcast --json "$@" | tr -d ' \n' \
    | sed -n 's/.*"deployedTo":"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p'
}

HELPER="$(create --gas-limit 1200000 "$@" src/SpendingLimitModuleV2.sol:SafeSetupHelperV2)"
[ -n "$HELPER" ] || { echo "helper deploy failed" >&2; exit 1; }
echo "SafeSetupHelperV2:         $HELPER"

POLICY="$(create --gas-limit 10500000 "$@" src/SpendingLimitCallPolicyV2.sol:SpendingLimitCallPolicyV2 \
  --constructor-args "$WETH" "$USDC" "$UNIVERSAL_ROUTER" "$PERMIT2" "$POSITION_MANAGER" "[]" "$BLOCKED")"
[ -n "$POLICY" ] || { echo "call policy deploy failed" >&2; exit 1; }
echo "SpendingLimitCallPolicyV2: $POLICY"

MODULE="$(create --gas-limit 15500000 "$@" src/SpendingLimitModuleV2.sol:SpendingLimitModuleV2 \
  --constructor-args "($ETH_USD_FEED,$USDC_DECIMALS,$FEED_STALE_AFTER,$POLICY,$HELPER,$ADMIN_ADDRESS,$GUARDIAN_ADDRESS,$AGENT_CHANGE_DELAY)")"
[ -n "$MODULE" ] || { echo "module deploy failed" >&2; exit 1; }
echo "SpendingLimitModuleV2:     $MODULE"

# Read back what the chain now says, so a wrong parameter is caught before the bridge uses it.
echo "VERSION        $(cast call "$MODULE" 'VERSION()(uint256)' --rpc-url "$RPC_URL")"
echo "admin          $(cast call "$MODULE" 'admin()(address)' --rpc-url "$RPC_URL")"
echo "guardian       $(cast call "$MODULE" 'guardian()(address)' --rpc-url "$RPC_URL")"
echo "delay (s)      $(cast call "$MODULE" 'agentChangeDelay()(uint256)' --rpc-url "$RPC_URL")"
echo "setupHelper    $(cast call "$MODULE" 'setupHelper()(address)' --rpc-url "$RPC_URL")"
echo "callPolicy     $(cast call "$MODULE" 'callPolicy()(address)' --rpc-url "$RPC_URL")"
echo "router         $(cast call "$MODULE" 'universalRouter()(address)' --rpc-url "$RPC_URL")"
echo
echo "Next: set SPENDING_MODULE_ADDRESS=$MODULE and AGENT_KEY_ENCRYPTION_KEY on the bridge, then restart it."
