// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/OrchestraPolicy.sol";

contract OrchestraPolicyTest is Test {
    OrchestraPolicy policy;
    address agent = address(0xA9E47);
    address attacker = address(0xBAD);
    address safeA = address(0x5AFE0A);
    address safeB = address(0x5AFE0B);
    address ownerA = address(0x0A);
    address ownerB = address(0x0B);

    function setUp() public {
        policy = new OrchestraPolicy(agent);
    }

    function test_twoSafesKeepSeparateLimits() public {
        vm.startPrank(agent);
        policy.registerSafe(safeA, ownerA, 10_000);
        policy.registerSafe(safeB, ownerB, 50_000);
        vm.stopPrank();
        assertEq(policy.getPolicy(safeA).spendingLimitUSD, 10_000);
        assertEq(policy.getPolicy(safeB).spendingLimitUSD, 50_000);
        assertEq(policy.getPolicy(safeA).owner, ownerA);
        assertEq(policy.getPolicy(safeB).owner, ownerB);
        assertTrue(policy.hasPolicy(safeA));
        assertTrue(policy.hasPolicy(safeB));
        assertFalse(policy.hasPolicy(agent), "nothing is keyed by the agent any more");
    }

    function test_agentUpdateDoesNotTouchOtherSafe() public {
        vm.startPrank(agent);
        policy.registerSafe(safeA, ownerA, 10_000);
        policy.registerSafe(safeB, ownerB, 50_000);
        policy.updateSpendingLimit(safeA, 20_000);
        vm.stopPrank();
        assertEq(policy.getPolicy(safeA).spendingLimitUSD, 20_000);
        assertEq(policy.getPolicy(safeB).spendingLimitUSD, 50_000);
    }

    function test_safeCanUpdateItself() public {
        vm.prank(agent);
        policy.registerSafe(safeA, ownerA, 10_000);
        vm.prank(safeA);
        policy.updateSpendingLimit(safeA, 5_000);
        assertEq(policy.getPolicy(safeA).spendingLimitUSD, 5_000);
    }

    // ── attacks: all must revert and leave the entries as they were ──

    function test_attackerCannotRegister() public {
        vm.prank(attacker);
        vm.expectRevert(OrchestraPolicy.NotAgent.selector);
        policy.registerSafe(safeA, attacker, 1_000_000);
        assertFalse(policy.hasPolicy(safeA), "a Safe address can't be claimed ahead of its owner");
    }

    function test_attackerCannotOverwriteExistingEntry() public {
        vm.prank(agent);
        policy.registerSafe(safeA, ownerA, 10_000);
        vm.prank(attacker);
        vm.expectRevert(OrchestraPolicy.NotAgent.selector);
        policy.registerSafe(safeA, attacker, 1_000_000);
        assertEq(policy.getPolicy(safeA).spendingLimitUSD, 10_000);
        assertEq(policy.getPolicy(safeA).owner, ownerA);
    }

    function test_attackerCannotUpdateAnotherSafe() public {
        vm.prank(agent);
        policy.registerSafe(safeA, ownerA, 10_000);
        vm.prank(attacker);
        vm.expectRevert(OrchestraPolicy.NotSafeOrAgent.selector);
        policy.updateSpendingLimit(safeA, 1_000_000);
        assertEq(policy.getPolicy(safeA).spendingLimitUSD, 10_000);
    }

    function test_ownerWalletCannotUpdateDirectly() public {
        // The owner acts through its Safe; a plain call from the owner's EOA is not the Safe.
        vm.prank(agent);
        policy.registerSafe(safeA, ownerA, 10_000);
        vm.prank(ownerA);
        vm.expectRevert(OrchestraPolicy.NotSafeOrAgent.selector);
        policy.updateSpendingLimit(safeA, 1);
    }

    function test_safeACannotChangeSafeB() public {
        vm.startPrank(agent);
        policy.registerSafe(safeA, ownerA, 10_000);
        policy.registerSafe(safeB, ownerB, 50_000);
        vm.stopPrank();
        vm.prank(safeA);
        vm.expectRevert(OrchestraPolicy.NotSafeOrAgent.selector);
        policy.updateSpendingLimit(safeB, 1_000_000);
        assertEq(policy.getPolicy(safeB).spendingLimitUSD, 50_000);
    }

    function test_cannotUpdateUnregisteredSafe() public {
        vm.prank(agent);
        vm.expectRevert(OrchestraPolicy.NotRegistered.selector);
        policy.updateSpendingLimit(safeA, 1);
    }

    function test_reRegisterRevertsAndKeepsEntry() public {
        vm.startPrank(agent);
        policy.registerSafe(safeA, ownerA, 10_000);
        policy.updateSpendingLimit(safeA, 20_000);
        vm.expectRevert(OrchestraPolicy.AlreadyRegistered.selector);
        policy.registerSafe(safeA, ownerA, 10_000);
        vm.stopPrank();
        assertEq(policy.getPolicy(safeA).spendingLimitUSD, 20_000, "a retry can't reset a changed limit");
    }

    function test_constructorRejectsZeroAgent() public {
        vm.expectRevert(OrchestraPolicy.ZeroAddress.selector);
        new OrchestraPolicy(address(0));
    }
}
