// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SpendingLimitModule.sol";

/// Deploys SpendingLimitModule for Orchestra (Call-only batches, selector allowlists).
/// Required: AGENT_ADDRESS
/// Optional Sepolia defaults: ETH_USD_FEED, WETH, USDC, USDC_DECIMALS, FEED_STALE_AFTER,
///   UNIVERSAL_ROUTER, PERMIT2, POSITION_MANAGER, and blocked Safe factory addresses.
/// Humans only — do not --broadcast from an agent session.
contract DeploySpendingLimitModule is Script {
    address constant SEPOLIA_ETH_USD = 0x694AA1769357215DE4FAC081bf1f309aDC325306;
    address constant SEPOLIA_WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant SEPOLIA_UNIVERSAL_ROUTER = 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD;
    address constant SEPOLIA_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SEPOLIA_NPM = 0x1238536071E1c677A632429e3655c799b22cDA52;
    // Safe 1.4.1 / 1.3.0 singletons & factories (never callable as `to`)
    address constant SAFE_SINGLETON_141 = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant SAFE_L2_SINGLETON_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE919727160;
    address constant SAFE_PROXY_FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_SINGLETON_130 = 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE70981e;
    address constant SAFE_PROXY_FACTORY_130 = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;

    function run() external {
        address agent = vm.envAddress("AGENT_ADDRESS");
        address feed = vm.envOr("ETH_USD_FEED", SEPOLIA_ETH_USD);
        address weth = vm.envOr("WETH", SEPOLIA_WETH);
        address usdc = vm.envOr("USDC", SEPOLIA_USDC);
        uint8 usdcDecimals = uint8(vm.envOr("USDC_DECIMALS", uint256(6)));
        uint256 staleAfter = vm.envOr("FEED_STALE_AFTER", uint256(24 hours));
        address ur = vm.envOr("UNIVERSAL_ROUTER", SEPOLIA_UNIVERSAL_ROUTER);
        address p2 = vm.envOr("PERMIT2", SEPOLIA_PERMIT2);
        address npm = vm.envOr("POSITION_MANAGER", SEPOLIA_NPM);

        address[] memory spenders = new address[](3);
        spenders[0] = p2;
        spenders[1] = ur;
        spenders[2] = npm;

        address[] memory blocked = new address[](5);
        blocked[0] = SAFE_SINGLETON_141;
        blocked[1] = SAFE_L2_SINGLETON_141;
        blocked[2] = SAFE_PROXY_FACTORY_141;
        blocked[3] = SAFE_SINGLETON_130;
        blocked[4] = SAFE_PROXY_FACTORY_130;

        vm.startBroadcast();
        SpendingLimitModule m = new SpendingLimitModule(
            agent, feed, weth, usdc, usdcDecimals, staleAfter, ur, p2, npm, spenders, blocked
        );
        console.log("SpendingLimitModule:", address(m));
        console.log("Agent:", agent);
        console.log("ETH/USD feed:", feed);
        console.log("UniversalRouter:", ur);
        console.log("Permit2:", p2);
        console.log("PositionManager:", npm);
        console.log("Daily limit cents:", m.DAILY_LIMIT_CENTS());
        vm.stopBroadcast();
    }
}
