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
    MockRouter router;
    MockDrainer drainer;
    SpendingLimitModule module;

    address agent = address(0xA9E47);
    address attacker = address(0xBAD);
    address recipient = address(0xBEEF);

    // $2500 with 8 decimals (Chainlink style)
    int256 constant ETH_USD_8 = 2500e8;

    function setUp() public {
        vm.warp(1_700_000_000); // fixed time so stale-feed math cannot underflow
        feed = new MockAggregator(8);
        feed.set(ETH_USD_8, block.timestamp);
        weth = new MockERC20("WETH", "WETH", 18);
        usdc = new MockERC20("USDC", "USDC", 6);
        dai = new MockERC20("DAI", "DAI", 18);
        safe = new MockSafe();
        router = new MockRouter();
        drainer = new MockDrainer();

        address[] memory calls = new address[](2);
        calls[0] = address(router);
        calls[1] = address(drainer); // allowlisted so we can show metering still applies to known tokens
        address[] memory dels = new address[](1);
        dels[0] = address(0x1234); // MultiSend stand-in for allowlist

        module = new SpendingLimitModule(
            agent,
            address(feed),
            address(weth),
            address(usdc),
            6,
            1 hours,
            calls,
            dels
        );
        safe.setModule(address(module));

        // Fund the Safe
        vm.deal(address(safe), 10 ether);
        weth.mint(address(safe), 5 ether);
        usdc.mint(address(safe), 5_000e6);
        dai.mint(address(safe), 1_000 ether);
    }

    function _execEth(uint256 value) internal {
        vm.prank(agent);
        module.exec(address(safe), recipient, value, "", ISafe.Operation.Call);
    }

    function _approveUsdc(uint256 amount) internal {
        bytes memory data = abi.encodeWithSignature("approve(address,uint256)", address(router), amount);
        vm.prank(agent);
        module.exec(address(safe), address(usdc), 0, data, ISafe.Operation.Call);
    }

    function _pullUsdc(uint256 amount) internal {
        bytes memory data = abi.encodeWithSignature("pullUsdc(address,address,uint256)", address(usdc), address(safe), amount);
        vm.prank(agent);
        module.exec(address(safe), address(router), 0, data, ISafe.Operation.Call);
    }

    // ── happy paths ─────────────────────────────────────────────────────────

    function test_ethSendUnderCap() public {
        // 0.1 ETH * $2500 = $250 = 25000 cents
        _execEth(0.1 ether);
        assertEq(module.spentToday(address(safe)), 25_000);
        assertEq(recipient.balance, 0.1 ether);
        assertEq(module.remainingToday(address(safe)), 75_000);
    }

    function test_usdcViaAllowlistedRouter() public {
        _approveUsdc(type(uint256).max);
        // approve must not count as spend
        assertEq(module.spentToday(address(safe)), 0);
        _pullUsdc(100e6); // $100
        assertEq(module.spentToday(address(safe)), 10_000);
    }

    function test_wethTransferCountsAsEth() public {
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", recipient, 0.2 ether);
        // 0.2 * 2500 = $500
        vm.prank(agent);
        module.exec(address(safe), address(weth), 0, data, ISafe.Operation.Call);
        assertEq(module.spentToday(address(safe)), 50_000);
    }

    function test_dailyReset() public {
        _execEth(0.3 ether); // $750
        assertEq(module.spentToday(address(safe)), 75_000);
        vm.warp(block.timestamp + 1 days);
        feed.set(ETH_USD_8, block.timestamp); // fresh feed after warp
        assertEq(module.spentToday(address(safe)), 0);
        _execEth(0.3 ether); // allowed again
        assertEq(module.spentToday(address(safe)), 75_000);
    }

    function test_exactCapAllowed() public {
        // $1000 at $2500/ETH = 0.4 ETH
        _execEth(0.4 ether);
        assertEq(module.spentToday(address(safe)), 100_000);
        assertEq(module.remainingToday(address(safe)), 0);
    }

    // ── over cap / feed / target ────────────────────────────────────────────

    function test_overCapRevertsAndDoesNotMoveFunds() public {
        uint256 before = address(safe).balance;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpendingLimitModule.DailyLimitExceeded.selector, uint256(0), uint256(125_000), uint256(100_000)
            )
        );
        // 0.5 ETH * 2500 = $1250
        module.exec(address(safe), recipient, 0.5 ether, "", ISafe.Operation.Call);
        assertEq(address(safe).balance, before, "over-cap must not move funds");
        assertEq(module.spentToday(address(safe)), 0);
    }

    function test_secondTxThatWouldExceedReverts() public {
        _execEth(0.3 ether); // $750
        uint256 before = address(safe).balance;
        vm.prank(agent);
        vm.expectRevert();
        module.exec(address(safe), recipient, 0.2 ether, "", ISafe.Operation.Call); // +$500 → $1250
        assertEq(address(safe).balance, before);
        assertEq(module.spentToday(address(safe)), 75_000);
    }

    function test_staleFeedReverts() public {
        feed.set(ETH_USD_8, block.timestamp - 2 hours);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.StalePrice.selector);
        module.exec(address(safe), recipient, 0.01 ether, "", ISafe.Operation.Call);
    }

    function test_missingFeedReverts() public {
        feed.setRevert(true);
        vm.prank(agent);
        vm.expectRevert();
        module.exec(address(safe), recipient, 0.01 ether, "", ISafe.Operation.Call);
    }

    function test_badPriceReverts() public {
        feed.set(0, block.timestamp);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.BadPrice.selector);
        module.exec(address(safe), recipient, 0.01 ether, "", ISafe.Operation.Call);
    }

    function test_unknownTokenDirectCallRefused() public {
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", attacker, 1 ether);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.TargetNotAllowed.selector);
        module.exec(address(safe), address(dai), 0, data, ISafe.Operation.Call);
        assertEq(dai.balanceOf(address(safe)), 1_000 ether);
    }

    function test_nonEmptyCallToRandomAddressRefused() public {
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.TargetNotAllowed.selector);
        module.exec(address(safe), attacker, 0, hex"deadbeef", ISafe.Operation.Call);
    }

    function test_delegateToUnknownRefused() public {
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.DelegateNotAllowed.selector);
        module.exec(address(safe), address(router), 0, "", ISafe.Operation.DelegateCall);
    }

    // ── attacks ─────────────────────────────────────────────────────────────

    function test_attackerCannotExec() public {
        vm.prank(attacker);
        vm.expectRevert(SpendingLimitModule.NotAgent.selector);
        module.exec(address(safe), recipient, 0.01 ether, "", ISafe.Operation.Call);
    }

    function test_agentCannotCallSafeConfigViaModule() public {
        // setGuard(address) selector — Safe itself is not allowlisted
        bytes memory data = abi.encodeWithSignature("setGuard(address)", address(0));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.TargetNotAllowed.selector);
        module.exec(address(safe), address(safe), 0, data, ISafe.Operation.Call);
    }

    function test_agentCannotDisableModuleViaSelfCall() public {
        bytes memory data = abi.encodeWithSignature("disableModule(address,address)", address(0x1), address(module));
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.TargetNotAllowed.selector);
        module.exec(address(safe), address(safe), 0, data, ISafe.Operation.Call);
    }

    function test_agentCannotAddOwnerViaModule() public {
        bytes memory data = abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", attacker, 1);
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.TargetNotAllowed.selector);
        module.exec(address(safe), address(safe), 0, data, ISafe.Operation.Call);
    }

    function test_ceilingIsImmutableConstant() public view {
        assertEq(module.DAILY_LIMIT_CENTS(), 100_000);
        // No setter exists — a compromised agent cannot raise the on-chain cap.
    }

    function test_reentrancyFromNonAgentCallbackRefused() public {
        // A Safe callback into exec cannot forge the agent.
        safe.setReenter(recipient, "");
        vm.prank(agent);
        vm.expectRevert(SpendingLimitModule.NotAgent.selector);
        module.exec(address(safe), recipient, 0.01 ether, "", ISafe.Operation.Call);
    }

    function test_reentrancyLockEngaged() public {
        // Agent is a contract: during an allowlisted router call it reenters exec while locked.
        SmartAgent smart = new SmartAgent();
        address[] memory calls = new address[](1);
        calls[0] = address(router);
        address[] memory dels = new address[](0);
        SpendingLimitModule m2 = new SpendingLimitModule(
            address(smart), address(feed), address(weth), address(usdc), 6, 1 hours, calls, dels
        );
        MockSafe s2 = new MockSafe();
        s2.setModule(address(m2));
        vm.deal(address(s2), 1 ether);
        smart.setModule(m2);
        smart.arm(address(s2), recipient);

        bytes memory data = abi.encodeWithSignature("pullEthAndCallback(address)", address(smart));
        vm.prank(address(smart));
        vm.expectRevert(SpendingLimitModule.Reentrancy.selector);
        m2.exec(address(s2), address(router), 0, data, ISafe.Operation.Call);
    }

    function test_approveDoesNotConsumeAllowance() public {
        _approveUsdc(1_000e6);
        assertEq(module.spentToday(address(safe)), 0);
        assertEq(usdc.balanceOf(address(safe)), 5_000e6);
    }


    function test_multiSendEthSendMetered() public {
        MockMultiSend ms = new MockMultiSend();
        address[] memory calls = new address[](0);
        address[] memory dels = new address[](1);
        dels[0] = address(ms);
        SpendingLimitModule m2 = new SpendingLimitModule(
            agent, address(feed), address(weth), address(usdc), 6, 1 hours, calls, dels
        );
        MockSafe s2 = new MockSafe();
        s2.setModule(address(m2));
        vm.deal(address(s2), 2 ether);

        // One inner ETH send of 0.1 ether packed as Safe MultiSend (op=0, to, value, dataLen=0)
        bytes memory packed = abi.encodePacked(
            uint8(0),
            recipient,
            uint256(0.1 ether),
            uint256(0)
        );
        bytes memory data = abi.encodeWithSignature("multiSend(bytes)", packed);
        vm.prank(agent);
        m2.exec(address(s2), address(ms), 0.1 ether, data, ISafe.Operation.DelegateCall);
        // Metering uses Safe balance delta (outbound), not calldata decode.
        assertEq(m2.spentToday(address(s2)), 25_000);
        assertEq(recipient.balance, 0.1 ether);
    }

    function test_swapStyleOutboundOnly() public {
        // Simulate a swap: pull $200 USDC, credit 0.05 WETH (~$125) — spend must be $200, not net.
        _approveUsdc(type(uint256).max);
        // Do pull + mint weth to safe in one router-less sequence: pull then mint
        _pullUsdc(200e6);
        weth.mint(address(safe), 0.05 ether);
        assertEq(module.spentToday(address(safe)), 20_000, "inbound WETH must not reduce outbound USDC spend");
    }
}

