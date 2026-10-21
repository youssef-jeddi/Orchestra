// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SpendingLimitModuleV2.sol";
import "../src/SpendingLimitCallPolicyV2.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address);
}

interface ISafeReal {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function isModuleEnabled(address module) external view returns (bool);
    function getOwners() external view returns (address[] memory);
}

/// Against the real Safe 1.4.1 contracts on a Sepolia fork (local only, nothing is broadcast):
/// a Safe created the way the bridge creates it has the module on and its own agent, and a
/// relayed signed batch moves funds. Skipped unless FORK_RPC_URL is set.
contract SpendingLimitModuleV2ForkTest is Test {
    address constant FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant FALLBACK = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    function test_fork_realSafeSetupAndSignedSend() public {
        string memory url = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) return; // offline run: nothing to check
        vm.createSelectFork(url);

        SpendingLimitCallPolicyV2 policy = new SpendingLimitCallPolicyV2(
            0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14,
            0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,
            0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD,
            0x000000000022D473030F116dDEE9F6B43aC78BA3,
            0x1238536071E1c677A632429e3655c799b22cDA52,
            new address[](0),
            new address[](0)
        );
        SpendingLimitModuleV2 module = new SpendingLimitModuleV2(
            SpendingLimitModuleV2.Config({
                ethUsdFeed: 0x694AA1769357215DE4FAC081bf1f309aDC325306,
                usdcDecimals: 6,
                feedStaleAfter: 24 hours,
                callPolicy: address(policy),
                setupHelper: address(new SafeSetupHelperV2()),
                admin: address(0xAD31),
                guardian: address(0x6A2D),
                agentChangeDelay: 10 minutes
            })
        );
        uint256 agentPk = 0xA11CE;
        address agent = vm.addr(agentPk);
        address owner = address(0x0123);
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory init = abi.encodeCall(
            ISafeReal.setup,
            (owners, 1, module.setupHelper(), abi.encodeCall(SafeSetupHelperV2.setupModule, (address(module), agent)), FALLBACK, address(0), 0, payable(address(0)))
        );
        address safe = ISafeProxyFactory(FACTORY).createProxyWithNonce(SAFE_L2, init, 0);

        assertTrue(ISafeReal(safe).isModuleEnabled(address(module)));
        assertEq(module.agentOf(safe), agent);
        assertEq(ISafeReal(safe).getOwners().length, 1);
        assertEq(ISafeReal(safe).getOwners()[0], owner);

        vm.deal(safe, 1 ether);
        SpendingLimitModuleV2.Call[] memory calls = new SpendingLimitModuleV2.Call[](1);
        calls[0] = SpendingLimitModuleV2.Call(address(0xBEEF), 0.001 ether, "");
        uint256 dl = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, module.execDigest(safe, calls, 0, dl));
        address to = makeAddr("fresh-recipient");
        calls[0].to = to;
        (v, r, s) = vm.sign(agentPk, module.execDigest(safe, calls, 0, dl));
        vm.prank(address(0x2E1A)); // relayer: pays gas, holds no power
        module.execSigned(safe, calls, dl, abi.encodePacked(r, s, v));
        assertEq(to.balance, 0.001 ether);
        assertGt(module.spentToday(safe), 0);
    }
}
