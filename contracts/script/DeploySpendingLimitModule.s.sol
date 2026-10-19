// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SpendingLimitModule.sol";

/// Deploys SpendingLimitModule for Orchestra.
/// Required env:
///   AGENT_ADDRESS     — the server's agent wallet (only address that may exec)
/// Optional env (Sepolia defaults below):
///   ETH_USD_FEED, WETH, USDC, USDC_DECIMALS, FEED_STALE_AFTER
///   UNIVERSAL_ROUTER, PERMIT2, POSITION_MANAGER
///   MULTISEND, MULTISEND_CALL_ONLY
///
/// Do not run with --broadcast against a public network from an agent session;
/// Youssef / Hassene deploy deliberately.
contract DeploySpendingLimitModule is Script {
    // Sepolia defaults (Chainlink ETH/USD, Uniswap + Safe canonical modules)
    address constant SEPOLIA_ETH_USD = 0x694AA1769357215DE4FAC081bf1f309aDC325306;
    address constant SEPOLIA_WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant SEPOLIA_UNIVERSAL_ROUTER = 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD;
    address constant SEPOLIA_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SEPOLIA_NPM = 0x1238536071E1c677A632429e3655c799b22cDA52;
    // Safe 1.4.1
    address constant SEPOLIA_MULTISEND_141 = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;
    address constant SEPOLIA_MULTISEND_CALL_ONLY_141 = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    // Safe 1.3.0 (protocol-kit may still use these)
    address constant SEPOLIA_MULTISEND_130 = 0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761;
    address constant SEPOLIA_MULTISEND_CALL_ONLY_130 = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;

    function run() external {
        address agent = vm.envAddress("AGENT_ADDRESS");
        address feed = vm.envOr("ETH_USD_FEED", SEPOLIA_ETH_USD);
        address weth = vm.envOr("WETH", SEPOLIA_WETH);
        address usdc = vm.envOr("USDC", SEPOLIA_USDC);
        uint8 usdcDecimals = uint8(vm.envOr("USDC_DECIMALS", uint256(6)));
        // Sepolia feeds can lag; 24h fail-closed is still far tighter than "never check".
        uint256 staleAfter = vm.envOr("FEED_STALE_AFTER", uint256(24 hours));

        address[] memory calls = new address[](3);
        calls[0] = vm.envOr("UNIVERSAL_ROUTER", SEPOLIA_UNIVERSAL_ROUTER);
        calls[1] = vm.envOr("PERMIT2", SEPOLIA_PERMIT2);
        calls[2] = vm.envOr("POSITION_MANAGER", SEPOLIA_NPM);

        address[] memory dels = new address[](4);
        dels[0] = vm.envOr("MULTISEND", SEPOLIA_MULTISEND_141);
        dels[1] = vm.envOr("MULTISEND_CALL_ONLY", SEPOLIA_MULTISEND_CALL_ONLY_141);
        dels[2] = SEPOLIA_MULTISEND_130;
        dels[3] = SEPOLIA_MULTISEND_CALL_ONLY_130;

        vm.startBroadcast();
        SpendingLimitModule m = new SpendingLimitModule(
            agent, feed, weth, usdc, usdcDecimals, staleAfter, calls, dels
        );
        console.log("SpendingLimitModule:", address(m));
        console.log("Agent:", agent);
        console.log("ETH/USD feed:", feed);
        console.log("Daily limit cents:", m.DAILY_LIMIT_CENTS());
        vm.stopBroadcast();
    }
}
