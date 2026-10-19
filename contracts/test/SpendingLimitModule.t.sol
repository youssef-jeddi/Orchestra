// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SpendingLimitModule.sol";
import "./mocks/MockEntities.sol";

contract SpendingLimitModuleTest is Test {
    MockAggregator feed;
    MockERC20 weth;
    MockERC20 usdc;
    MockERC20 dai;
    MockSafe safe;
    MockPermit2 p2;
    MockUniversalRouter ur;
    MockNpm npm;
    SpendingLimitModule module;

    address agent = address(0xA9E47);
    address attacker = address(0xBAD);
    address recipient = address(0xBEEF);
    address safeFactory = address(0xFAC70);

    int256 constant ETH_USD_8 = 2500e8;

    function setUp() public {
        vm.warp(1_700_000_000);
        feed = new MockAggregator(8);
        feed.set(ETH_USD_8, block.timestamp);
        weth = new MockERC20("WETH", "WETH", 18);
        usdc = new MockERC20("USDC", "USDC", 6);
        dai = new MockERC20("DAI", "DAI", 18);
        safe = new MockSafe();
        p2 = new MockPermit2();
        ur = new MockUniversalRouter();
        npm = new MockNpm();

        address[] memory spenders = new address[](0);
        address[] memory blocked = new address[](1);
        blocked[0] = safeFactory;

        module = new SpendingLimitModule(
            agent,
            address(feed),
            address(weth),
            address(usdc),
            6,
            1 hours,
            address(ur),
            address(p2),
            address(npm),
            spenders,
            blocked
        );
        safe.setModule(address(module));
        vm.deal(address(safe), 10 ether);
        weth.mint(address(safe), 5 ether);
        usdc.mint(address(safe), 5_000e6);
        dai.mint(address(safe), 1_000 ether);
    }

    function _exec(SpendingLimitModule.Call[] memory calls) internal {
        vm.prank(agent);
        module.exec(address(safe), calls);
    }

    function _one(address to, uint256 value, bytes memory data) internal pure returns (SpendingLimitModule.Call[] memory calls) {
        calls = new SpendingLimitModule.Call[](1);
        calls[0] = SpendingLimitModule.Call({to: to, value: value, data: data});
    }

    // ── happy paths ─────────────────────────────────────────────────────────

    function test_ethSendUnderCap() public {
        _exec(_one(recipient, 0.1 ether, ""));
        assertEq(module.spentToday(address(safe)), 25_000);
        assertEq(recipient.balance, 0.1 ether);
    }

    function test_exactCapAllowed() public {
        _exec(_one(recipient, 0.4 ether, ""));
        assertEq(module.spentToday(address(safe)), 100_000);
    }

    function test_dailyReset() public {
        _exec(_one(recipient, 0.3 ether, ""));
        vm.warp(block.timestamp + 1 days);
        feed.set(ETH_USD_8, block.timestamp);
        assertEq(module.spentToday(address(safe)), 0);
        _exec(_one(recipient, 0.3 ether, ""));
        assertEq(module.spentToday(address(safe)), 75_000);
    }

    function test_swapShapedBatchMetered() public {
        // approve USDC→Permit2, Permit2.approve→UR, UR.execute — spend = USDC pulled if any.
        // Here UR doesn't pull; approvals alone must not consume the ceiling.
        bytes memory a1 = abi.encodeWithSelector(bytes4(0x095ea7b3), address(p2), type(uint256).max);
        bytes memory a2 = abi.encodeWithSelector(bytes4(0x87517c45), address(usdc), address(ur), uint160(type(uint160).max), uint48(type(uint48).max));
        bytes[] memory inputs = new bytes[](0);
        bytes memory a3 = abi.encodeWithSelector(bytes4(0x3593564c), bytes(""), inputs, block.timestamp + 60);

        SpendingLimitModule.Call[] memory calls = new SpendingLimitModule.Call[](3);
        calls[0] = SpendingLimitModule.Call(address(usdc), 0, a1);
        calls[1] = SpendingLimitModule.Call(address(p2), 0, a2);
        calls[2] = SpendingLimitModule.Call(address(ur), 0, a3);
        _exec(calls);
        assertEq(module.spentToday(address(safe)), 0, "approvals are not spend");
        assertEq(usdc.allowance(address(safe), address(p2)), type(uint256).max);
    }

    function test_swapPullsUsdcAndMeters() public {
        bytes memory approveData = abi.encodeWithSelector(bytes4(0x095ea7b3), address(ur), type(uint256).max);
        // Use UR.pullUsdc — but that selector isn't allowlisted on UR. So pull via USDC.transfer to simulate outbound.
        bytes memory transferData = abi.encodeWithSelector(bytes4(0xa9059cbb), address(ur), uint256(200e6));
        SpendingLimitModule.Call[] memory calls = new SpendingLimitModule.Call[](2);
        calls[0] = SpendingLimitModule.Call(address(usdc), 0, approveData);
        calls[1] = SpendingLimitModule.Call(address(usdc), 0, transferData);
        _exec(calls);
        assertEq(module.spentToday(address(safe)), 20_000);
    }

    function test_lpMintWithRecipientSafe() public {
        MockNpm.MintParams memory params = MockNpm.MintParams({
            token0: address(usdc),
            token1: address(weth),
            fee: 3000,
            tickLower: -887220,
            tickUpper: 887220,
            amount0Desired: 100e6,
            amount1Desired: 0.04 ether,
            amount0Min: 0,
            amount1Min: 0,
            recipient: address(safe),
            deadline: block.timestamp + 60
        });
        bytes memory mintData = abi.encodeWithSelector(MockNpm.mint.selector, params);
        bytes memory approveUsdc = abi.encodeWithSelector(bytes4(0x095ea7b3), address(npm), uint256(100e6));
        bytes memory approveWeth = abi.encodeWithSelector(bytes4(0x095ea7b3), address(npm), uint256(0.04 ether));
        // Fund pull: transfer into npm to simulate deposit (metered)
        bytes memory tUsdc = abi.encodeWithSelector(bytes4(0xa9059cbb), address(npm), uint256(100e6));
        bytes memory tWeth = abi.encodeWithSelector(bytes4(0xa9059cbb), address(npm), uint256(0.04 ether));

        SpendingLimitModule.Call[] memory calls = new SpendingLimitModule.Call[](5);
        calls[0] = SpendingLimitModule.Call(address(usdc), 0, approveUsdc);
        calls[1] = SpendingLimitModule.Call(address(weth), 0, approveWeth);
        calls[2] = SpendingLimitModule.Call(address(usdc), 0, tUsdc);
        calls[3] = SpendingLimitModule.Call(address(weth), 0, tWeth);
        calls[4] = SpendingLimitModule.Call(address(npm), 0, mintData);
        _exec(calls);
        // $100 USDC + 0.04 ETH * $2500 = $100 + $100 = $200
        assertEq(module.spentToday(address(safe)), 20_000);
    }

    function test_wethDepositWithdraw() public {
        bytes memory dep = abi.encodeWithSelector(bytes4(0xd0e30db0));
        _exec(_one(address(weth), 0.05 ether, dep));
        // ETH→WETH: ethEq unchanged → spend 0
        assertEq(module.spentToday(address(safe)), 0);
    }

    // ── over cap / feed ─────────────────────────────────────────────────────

    function test_overCapRevertsAndDoesNotMoveFunds() public {
        uint256 before = address(safe).balance;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(SpendingLimitModule.DailyLimitExceeded.selector, uint256(0), uint256(125_000), uint256(100_000))
        );
        module.exec(address(safe), _one(recipient, 0.5 ether, ""));
        assertEq(address(safe).balance, before);
        assertEq(module.spentToday(address(safe)), 0);
    }

    function test_staleFeedReverts() public {
        feed.set(ETH_USD_8, block.timestamp - 2 hours);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.StalePrice.selector);
        module.exec(address(safe), _one(recipient, 0.01 ether, ""));
    }

    function test_badPriceReverts() public {
        feed.set(0, block.timestamp);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BadPrice.selector);
        module.exec(address(safe), _one(recipient, 0.01 ether, ""));
    }

    // ── attacks: Safe self-calls / config ────────────────────────────────────

    function test_attack_callToSafeAddOwner() public {
        bytes memory data = abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", attacker, 1);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BlockedTarget.selector);
        module.exec(address(safe), _one(address(safe), 0, data));
    }

    function test_attack_callToSafeEnableModule() public {
        bytes memory data = abi.encodeWithSignature("enableModule(address)", attacker);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BlockedTarget.selector);
        module.exec(address(safe), _one(address(safe), 0, data));
    }

    function test_attack_callToSafeSetGuard() public {
        bytes memory data = abi.encodeWithSignature("setGuard(address)", attacker);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BlockedTarget.selector);
        module.exec(address(safe), _one(address(safe), 0, data));
    }

    function test_attack_callToSafeDisableModule() public {
        bytes memory data = abi.encodeWithSignature("disableModule(address,address)", address(0x1), address(module));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BlockedTarget.selector);
        module.exec(address(safe), _one(address(safe), 0, data));
    }

    function test_attack_callToModule() public {
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BlockedTarget.selector);
        module.exec(address(safe), _one(address(module), 0, hex"12345678"));
    }

    function test_attack_callToBlockedFactory() public {
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BlockedTarget.selector);
        module.exec(address(safe), _one(safeFactory, 0, hex"12345678"));
    }

    // ── attacks: approvals ──────────────────────────────────────────────────

    function test_attack_approveUsdcToAttacker() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x095ea7b3), attacker, type(uint256).max);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BadSpender.selector);
        module.exec(address(safe), _one(address(usdc), 0, data));
    }

    function test_attack_approveWethToAttacker() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x095ea7b3), attacker, type(uint256).max);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BadSpender.selector);
        module.exec(address(safe), _one(address(weth), 0, data));
    }

    function test_attack_increaseAllowanceRefused() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x39509351), address(p2), uint256(1));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.SelectorNotAllowed.selector);
        module.exec(address(safe), _one(address(usdc), 0, data));
    }

    function test_attack_permit2ApproveToAttacker() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x87517c45), address(usdc), attacker, uint160(1), uint48(1));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BadSpender.selector);
        module.exec(address(safe), _one(address(p2), 0, data));
    }

    function test_attack_permit2ApproveUntrackedToken() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x87517c45), address(dai), address(ur), uint160(1), uint48(1));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BadToken.selector);
        module.exec(address(safe), _one(address(p2), 0, data));
    }

    // ── attacks: untracked token / NFT ──────────────────────────────────────

    function test_attack_untrackedTokenTransfer() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0xa9059cbb), attacker, uint256(1 ether));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.TargetNotAllowed.selector);
        module.exec(address(safe), _one(address(dai), 0, data));
    }

    function test_attack_nftSafeTransferFrom() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x42842e0e), address(safe), attacker, uint256(1));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.SelectorNotAllowed.selector);
        module.exec(address(safe), _one(address(npm), 0, data));
    }

    function test_attack_nftApprove() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x095ea7b3), attacker, uint256(1));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.SelectorNotAllowed.selector);
        module.exec(address(safe), _one(address(npm), 0, data));
    }

    function test_attack_nftSetApprovalForAll() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0xa22cb465), attacker, true);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.SelectorNotAllowed.selector);
        module.exec(address(safe), _one(address(npm), 0, data));
    }

    function test_attack_mintRecipientAttacker() public {
        MockNpm.MintParams memory params = MockNpm.MintParams({
            token0: address(usdc),
            token1: address(weth),
            fee: 3000,
            tickLower: 0,
            tickUpper: 1,
            amount0Desired: 0,
            amount1Desired: 0,
            amount0Min: 0,
            amount1Min: 0,
            recipient: attacker,
            deadline: block.timestamp + 60
        });
        bytes memory data = abi.encodeWithSelector(MockNpm.mint.selector, params);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BadRecipient.selector);
        module.exec(address(safe), _one(address(npm), 0, data));
    }

    function test_attack_collectRecipientAttacker() public {
        MockNpm.CollectParams memory params =
            MockNpm.CollectParams({tokenId: 1, recipient: attacker, amount0Max: type(uint128).max, amount1Max: type(uint128).max});
        bytes memory data = abi.encodeWithSelector(MockNpm.collect.selector, params);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BadRecipient.selector);
        module.exec(address(safe), _one(address(npm), 0, data));
    }

    // ── attacks: caller / empty / random ────────────────────────────────────

    function test_attack_nonAgentRejected() public {
        vm.prank(attacker);
        vm.expectRevert(SpendingLimitModule.NotAgent.selector);
        module.exec(address(safe), _one(recipient, 0.01 ether, ""));
    }

    function test_attack_nonEmptyCallToRandomAddress() public {
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.TargetNotAllowed.selector);
        module.exec(address(safe), _one(attacker, 0, hex"deadbeef"));
    }

    function test_attack_emptyBatch() public {
        SpendingLimitModule.Call[] memory calls = new SpendingLimitModule.Call[](0);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.EmptyBatch.selector);
        module.exec(address(safe), calls);
    }

    function test_ceilingIsImmutableConstant() public view {
        assertEq(module.DAILY_LIMIT_CENTS(), 100_000);
    }

    function test_reentrancyLockEngaged() public {
        SmartAgent smart = new SmartAgent();
        address[] memory spenders = new address[](0);
        address[] memory blocked = new address[](0);
        SpendingLimitModule m2 = new SpendingLimitModule(
            address(smart),
            address(feed),
            address(weth),
            address(usdc),
            6,
            1 hours,
            address(ur),
            address(p2),
            address(npm),
            spenders,
            blocked
        );
        MockSafe s2 = new MockSafe();
        s2.setModule(address(m2));
        vm.deal(address(s2), 1 ether);
        smart.setModule(m2);
        ur.setCallback(address(smart));

        bytes[] memory inputs = new bytes[](0);
        bytes memory data = abi.encodeWithSelector(bytes4(0x3593564c), bytes(""), inputs, block.timestamp + 60);
        SpendingLimitModule.Call[] memory calls = new SpendingLimitModule.Call[](1);
        calls[0] = SpendingLimitModule.Call(address(ur), 0, data);
        smart.arm(address(s2), calls);

        vm.prank(address(smart));
        vm.expectRevert(SpendingLimitModule.Reentrancy.selector);
        m2.exec(address(s2), calls);
    }

    function test_multicallMintAndRefundWithSafeRecipient() public {
        MockNpm.MintParams memory params = MockNpm.MintParams({
            token0: address(usdc),
            token1: address(weth),
            fee: 3000,
            tickLower: 0,
            tickUpper: 1,
            amount0Desired: 0,
            amount1Desired: 0,
            amount0Min: 0,
            amount1Min: 0,
            recipient: address(safe),
            deadline: block.timestamp + 60
        });
        bytes[] memory inner = new bytes[](2);
        inner[0] = abi.encodeWithSelector(MockNpm.mint.selector, params);
        inner[1] = abi.encodeWithSelector(bytes4(0x12210e8a)); // refundETH()
        bytes memory data = abi.encodeWithSelector(bytes4(0xac9650d8), inner);
        _exec(_one(address(npm), 0, data));
    }
}
