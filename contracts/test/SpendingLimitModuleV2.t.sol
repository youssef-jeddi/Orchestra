// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SpendingLimitModuleV2.sol";
import "../src/SpendingLimitCallPolicyV2.sol";
import {MockERC20, MockAggregator, MockPermit2, MockUniversalRouter, MockNpm} from "./mocks/MockEntities.sol";
import "./mocks/MockEntitiesV2.sol";

contract SpendingLimitModuleV2Test is Test {
    MockAggregator feed;
    MockERC20 weth;
    MockERC20 usdc;
    MockSafeV2 safe;
    MockSafeV2 safeB;
    MockPermit2 p2;
    MockUniversalRouter ur;
    MockNpm npm;
    SpendingLimitModuleV2 module;
    address helper;

    uint256 agentPk = 0xA11CE;
    uint256 agentBPk = 0xB0B;
    uint256 newAgentPk = 0xC0FFEE;
    uint256 attackerPk = 0xBAD;
    address agent;
    address agentB;
    address newAgent;
    address attacker;
    address admin = address(0xAD31);
    address guardian = address(0x6A2D);
    address relayer = address(0x2E1A);
    address stranger = address(0x5772);
    address recipient = address(0xBEEF);
    address safeFactory = address(0xFAC70);
    uint256 constant DELAY = 10 minutes;
    int256 constant ETH_USD_8 = 2500e8;

    function setUp() public {
        vm.warp(1_700_000_000);
        agent = vm.addr(agentPk);
        agentB = vm.addr(agentBPk);
        newAgent = vm.addr(newAgentPk);
        attacker = vm.addr(attackerPk);
        feed = new MockAggregator(8);
        feed.set(ETH_USD_8, block.timestamp);
        weth = new MockERC20("WETH", "WETH", 18);
        usdc = new MockERC20("USDC", "USDC", 6);
        p2 = new MockPermit2();
        ur = new MockUniversalRouter();
        npm = new MockNpm();
        helper = address(new SafeSetupHelperV2());
        module = _deploy(DELAY);

        safe = _newSafe(agent);
        safeB = _newSafe(agentB);
    }

    function _policy(address router, address[] memory blocked) internal returns (SpendingLimitCallPolicyV2) {
        return new SpendingLimitCallPolicyV2(address(weth), address(usdc), router, address(p2), address(npm), new address[](0), blocked);
    }

    function _config(uint256 delay) internal returns (SpendingLimitModuleV2.Config memory) {
        return _configWith(delay, _policy(address(ur), new address[](0)));
    }

    function _configWith(uint256 delay, SpendingLimitCallPolicyV2 policy) internal view returns (SpendingLimitModuleV2.Config memory) {
        return SpendingLimitModuleV2.Config({
            ethUsdFeed: address(feed),
            usdcDecimals: 6,
            feedStaleAfter: 1 hours,
            callPolicy: address(policy),
            setupHelper: helper,
            admin: admin,
            guardian: guardian,
            agentChangeDelay: delay
        });
    }

    function _deploy(uint256 delay) internal returns (SpendingLimitModuleV2) {
        address[] memory blocked = new address[](1);
        blocked[0] = safeFactory;
        return new SpendingLimitModuleV2(_configWith(delay, _policy(address(ur), blocked)));
    }

    /// A Safe set up the way the bridge does it: setup delegatecalls the helper.
    function _newSafe(address agent_) internal returns (MockSafeV2 s) {
        s = new MockSafeV2();
        s.setupWith(module.setupHelper(), abi.encodeCall(SafeSetupHelperV2.setupModule, (address(module), agent_)));
        vm.deal(address(s), 10 ether);
        weth.mint(address(s), 5 ether);
        usdc.mint(address(s), 5_000e6);
    }

    function _one(address to, uint256 value, bytes memory data) internal pure returns (SpendingLimitModuleV2.Call[] memory calls) {
        calls = new SpendingLimitModuleV2.Call[](1);
        calls[0] = SpendingLimitModuleV2.Call({to: to, value: value, data: data});
    }

    function _sigFor(SpendingLimitModuleV2 m, uint256 pk, address s, SpendingLimitModuleV2.Call[] memory calls, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pk, m.execDigest(s, calls, nonce, deadline));
        return abi.encodePacked(r, ss, v);
    }

    function _sig(uint256 pk, address s, SpendingLimitModuleV2.Call[] memory calls) internal view returns (bytes memory) {
        return _sigFor(module, pk, s, calls, module.nonces(s), block.timestamp + 600);
    }

    /// Relay a batch signed by the Safe's own agent.
    function _exec(SpendingLimitModuleV2.Call[] memory calls) internal {
        bytes memory sig = _sig(agentPk, address(safe), calls);
        vm.prank(relayer);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
    }

    function _expectExecRevert(SpendingLimitModuleV2.Call[] memory calls, bytes memory err) internal {
        bytes memory sig = _sig(agentPk, address(safe), calls);
        vm.prank(relayer);
        vm.expectRevert(err);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
    }

    function _router(bytes memory commands, bytes[] memory inputs) internal view returns (SpendingLimitModuleV2.Call[] memory) {
        return _one(address(ur), 0, abi.encodeWithSelector(bytes4(0x3593564c), commands, inputs, block.timestamp + 60));
    }

    function _v3In(address to) internal pure returns (bytes memory) {
        return abi.encode(to, uint256(1e6), uint256(0), bytes(""), true);
    }

    // ── setup and per-Safe agents ───────────────────────────────────────────

    function test_setupHelperEnablesModuleAndSetsAgent() public view {
        assertTrue(safe.isModuleEnabled(address(module)));
        assertEq(module.agentOf(address(safe)), agent);
        assertEq(module.agentOf(address(safeB)), agentB);
        assertEq(module.VERSION(), 2);
    }

    function test_setupHelperCalledDirectlyDoesNothing() public {
        SafeSetupHelperV2 helper = SafeSetupHelperV2(module.setupHelper());
        vm.expectRevert();
        helper.setupModule(address(module), attacker);
        assertEq(module.agentOf(address(helper)), address(0));
    }

    function test_relayerSubmitsSignedEthSend() public {
        _exec(_one(recipient, 0.1 ether, ""));
        assertEq(recipient.balance, 0.1 ether);
        assertEq(module.spentToday(address(safe)), 25_000);
        assertEq(module.nonces(address(safe)), 1);
        assertEq(relayer.balance, 0, "relayer only pays gas, gets nothing");
    }

    function test_attack_otherSafesAgentCannotSign() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(attacker, 1 ether, "");
        bytes memory sig = _sig(agentBPk, address(safe), calls); // safeB's key, safe A's batch
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
    }

    function test_attack_strangerKeyCannotSign() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(attacker, 1 ether, "");
        bytes memory sig = _sig(attackerPk, address(safe), calls);
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
    }

    function test_attack_noAgentRefused() public {
        MockSafeV2 bare = new MockSafeV2();
        SpendingLimitModuleV2.Call[] memory calls = _one(attacker, 1, "");
        bytes memory sig = _sig(agentPk, address(bare), calls);
        vm.expectRevert(SpendingLimitModuleV2.NoAgent.selector);
        module.execSigned(address(bare), calls, block.timestamp + 600, sig);
    }

    // ── signature replay and binding ────────────────────────────────────────

    function test_attack_replaySameSignatureRefused() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 0.01 ether, "");
        bytes memory sig = _sig(agentPk, address(safe), calls);
        uint256 dl = block.timestamp + 600;
        module.execSigned(address(safe), calls, dl, sig);
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, dl, sig);
        assertEq(recipient.balance, 0.01 ether);
    }

    function test_attack_expiredSignatureRefused() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 1, "");
        uint256 dl = block.timestamp + 60;
        bytes memory sig = _sigFor(module, agentPk, address(safe), calls, 0, dl);
        vm.warp(dl + 1);
        vm.expectRevert(SpendingLimitModuleV2.Expired.selector);
        module.execSigned(address(safe), calls, dl, sig);
    }

    function test_attack_signatureForOtherSafeRefused() public {
        // Same key on two Safes: a batch signed for one can't run on the other.
        vm.prank(address(safeB));
        module.setAgentBySafe(agent);
        SpendingLimitModuleV2.Call[] memory calls = _one(attacker, 0.1 ether, "");
        bytes memory sig = _sig(agentPk, address(safe), calls);
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safeB), calls, block.timestamp + 600, sig);
    }

    function test_attack_signatureForOtherModuleRefused() public {
        SpendingLimitModuleV2 other = _deploy(DELAY);
        SpendingLimitModuleV2.Call[] memory calls = _one(attacker, 0.1 ether, "");
        bytes memory sig = _sigFor(other, agentPk, address(safe), calls, 0, block.timestamp + 600);
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
    }

    function test_attack_signatureFromOtherChainRefused() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(attacker, 0.1 ether, "");
        bytes memory sig = _sig(agentPk, address(safe), calls);
        vm.chainId(10);
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
    }

    function test_attack_tamperedCallsRefused() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 0.01 ether, "");
        bytes memory sig = _sig(agentPk, address(safe), calls);
        calls[0].to = attacker;
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
        calls[0].to = recipient;
        calls[0].value = 0.3 ether;
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
    }

    function test_attack_tamperedDeadlineRefused() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 1, "");
        bytes memory sig = _sigFor(module, agentPk, address(safe), calls, 0, block.timestamp + 60);
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, block.timestamp + 6000, sig);
    }

    function test_attack_malleableHighSRefused() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 1, "");
        uint256 dl = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, module.execDigest(address(safe), calls, 0, dl));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, dl, twin);
    }

    function test_attack_badSignatureLengthRefused() public {
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 1, "");
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, block.timestamp + 600, hex"1234");
    }

    function test_failedBatchDoesNotBurnNonce() public {
        // Over the ceiling: the whole call reverts, so the same nonce still works for a smaller batch.
        _expectExecRevert(_one(recipient, 0.5 ether, ""), abi.encodeWithSelector(SpendingLimitModuleV2.DailyLimitExceeded.selector, 0, 125_000, 100_000));
        assertEq(module.nonces(address(safe)), 0);
        assertEq(recipient.balance, 0);
        _exec(_one(recipient, 0.1 ether, ""));
        assertEq(module.nonces(address(safe)), 1);
    }

    function test_digestMatchesEthersTypedData() public {
        // Pinned against ethers' TypedDataEncoder in src/integrations/safe/agentAuth.test.ts.
        address fixedModule = address(0xc3);
        vm.etch(fixedModule, address(module).code);
        vm.chainId(11155111);
        SpendingLimitModuleV2.Call[] memory calls = new SpendingLimitModuleV2.Call[](2);
        calls[0] = SpendingLimitModuleV2.Call(address(0xe5), 1, "");
        calls[1] = SpendingLimitModuleV2.Call(0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238, 0, hex"a9059cbb");
        bytes32 d = SpendingLimitModuleV2(fixedModule).execDigest(address(0xd4), calls, 7, 1_800_000_000);
        assertEq(d, 0x73b7265f510ed855c99cd65e0d4facd54a586995d44761d52990fc903cb5be47, "EIP-712 encoding drifted from ethers");
    }

    // ── rotation, revoke, pause ─────────────────────────────────────────────

    function test_setAgentBySafeIsInstant() public {
        safe.ownerCall(address(module), abi.encodeCall(SpendingLimitModuleV2.setAgentBySafe, (newAgent)));
        assertEq(module.agentOf(address(safe)), newAgent);
    }

    function test_attack_agentCannotReachModuleThroughSafe() public {
        _expectExecRevert(_one(address(module), 0, abi.encodeCall(SpendingLimitModuleV2.setAgentBySafe, (attacker))), abi.encodeWithSelector(SpendingLimitModuleV2.BlockedTarget.selector));
        _expectExecRevert(_one(module.setupHelper(), 0, abi.encodeCall(SafeSetupHelperV2.setupModule, (address(module), attacker))), abi.encodeWithSelector(SpendingLimitModuleV2.BlockedTarget.selector));
        assertEq(module.agentOf(address(safe)), agent);
    }

    function test_adminRotationWaitsForDelay() public {
        vm.prank(admin);
        module.proposeAgent(address(safe), newAgent);
        vm.expectRevert(abi.encodeWithSelector(SpendingLimitModuleV2.TooEarly.selector, block.timestamp + DELAY));
        module.acceptAgent(address(safe));
        vm.warp(block.timestamp + DELAY);
        feed.set(ETH_USD_8, block.timestamp);
        vm.prank(stranger);
        module.acceptAgent(address(safe));
        assertEq(module.agentOf(address(safe)), newAgent);

        // The old key is dead, the new one works.
        // One explicit deadline: via-IR may reuse a block.timestamp read from before vm.warp.
        uint256 dl = vm.getBlockTimestamp() + 600;
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 0.01 ether, "");
        bytes memory oldSig = _sigFor(module, agentPk, address(safe), calls, 0, dl);
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.execSigned(address(safe), calls, dl, oldSig);
        module.execSigned(address(safe), calls, dl, _sigFor(module, newAgentPk, address(safe), calls, 0, dl));
        assertEq(recipient.balance, 0.01 ether);
    }

    function test_agentProposesItsSuccessorSigned() public {
        uint256 dl = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, module.proposeDigest(address(safe), newAgent, 0, dl));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(relayer);
        module.proposeAgentSigned(address(safe), newAgent, dl, sig);
        (address pending, uint64 readyAt) = module.pendingAgentOf(address(safe));
        assertEq(pending, newAgent);
        assertEq(readyAt, block.timestamp + DELAY);
        // Replay of the same proposal signature is refused (nonce moved).
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.proposeAgentSigned(address(safe), newAgent, dl, sig);
    }

    function test_attack_strangerCannotPropose() public {
        vm.prank(stranger);
        vm.expectRevert(SpendingLimitModuleV2.NotAdmin.selector);
        module.proposeAgent(address(safe), attacker);
        uint256 dl = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk, module.proposeDigest(address(safe), attacker, 0, dl));
        vm.expectRevert(SpendingLimitModuleV2.BadSignature.selector);
        module.proposeAgentSigned(address(safe), attacker, dl, abi.encodePacked(r, s, v));
    }

    function test_revokeIsInstantAndClearsProposal() public {
        vm.prank(admin);
        module.proposeAgent(address(safe), newAgent);
        vm.prank(guardian);
        module.revokeAgent(address(safe));
        assertEq(module.agentOf(address(safe)), address(0));
        (address pending,) = module.pendingAgentOf(address(safe));
        assertEq(pending, address(0));
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 1, "");
        bytes memory sig = _sig(agentPk, address(safe), calls);
        vm.expectRevert(SpendingLimitModuleV2.NoAgent.selector);
        module.execSigned(address(safe), calls, block.timestamp + 600, sig);
    }

    function test_revokeByAdminAndBySafe() public {
        vm.prank(admin);
        module.revokeAgent(address(safe));
        assertEq(module.agentOf(address(safe)), address(0));
        safeB.ownerCall(address(module), abi.encodeCall(SpendingLimitModuleV2.revokeAgent, (address(safeB))));
        assertEq(module.agentOf(address(safeB)), address(0));
    }

    function test_attack_strangerCannotRevokeOrCancel() public {
        vm.startPrank(stranger);
        vm.expectRevert(SpendingLimitModuleV2.NotAuthorized.selector);
        module.revokeAgent(address(safe));
        vm.expectRevert(SpendingLimitModuleV2.NotAuthorized.selector);
        module.cancelAgentProposal(address(safe));
        vm.stopPrank();
        // An agent can't revoke another Safe either.
        vm.prank(agentB);
        vm.expectRevert(SpendingLimitModuleV2.NotAuthorized.selector);
        module.revokeAgent(address(safe));
    }

    function test_guardianCancelsProposal() public {
        vm.prank(admin);
        module.proposeAgent(address(safe), attacker);
        vm.prank(guardian);
        module.cancelAgentProposal(address(safe));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(SpendingLimitModuleV2.NoPendingAgent.selector);
        module.acceptAgent(address(safe));
        assertEq(module.agentOf(address(safe)), agent);
    }

    function test_pauseByGuardianBlocksEverySafe_unpauseAdminOnly() public {
        vm.prank(guardian);
        module.pause();
        _expectExecRevert(_one(recipient, 1, ""), abi.encodeWithSelector(SpendingLimitModuleV2.Paused.selector));
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 1, "");
        bytes memory sigB = _sig(agentBPk, address(safeB), calls);
        vm.expectRevert(SpendingLimitModuleV2.Paused.selector);
        module.execSigned(address(safeB), calls, block.timestamp + 600, sigB);

        vm.prank(guardian);
        vm.expectRevert(SpendingLimitModuleV2.NotAdmin.selector);
        module.unpause();
        vm.prank(admin);
        module.unpause();
        _exec(_one(recipient, 1, ""));
        assertEq(recipient.balance, 1);
    }

    function test_attack_strangerCannotPause() public {
        vm.prank(stranger);
        vm.expectRevert(SpendingLimitModuleV2.NotGuardianOrAdmin.selector);
        module.pause();
        vm.prank(admin);
        module.pause();
        assertTrue(module.paused());
    }

    function test_pauseFreezesAgentChangesButNotRecovery() public {
        vm.prank(admin);
        module.proposeAgent(address(safe), newAgent);
        vm.prank(guardian);
        module.pause();
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(SpendingLimitModuleV2.Paused.selector);
        module.acceptAgent(address(safe));
        uint256 dl = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, module.proposeDigest(address(safe), newAgent, 0, dl));
        vm.expectRevert(SpendingLimitModuleV2.Paused.selector);
        module.proposeAgentSigned(address(safe), newAgent, dl, abi.encodePacked(r, s, v));
        // Recovery still works while paused: revoke, admin re-proposes.
        vm.prank(guardian);
        module.revokeAgent(address(safe));
        vm.prank(admin);
        module.proposeAgent(address(safe), newAgent);
    }

    function test_rolesTwoStepAdminAndGuardian() public {
        vm.prank(stranger);
        vm.expectRevert(SpendingLimitModuleV2.NotAdmin.selector);
        module.setGuardian(stranger);
        vm.prank(admin);
        module.transferAdmin(stranger);
        assertEq(module.admin(), admin, "not until accepted");
        vm.prank(guardian);
        vm.expectRevert(SpendingLimitModuleV2.NotPendingAdmin.selector);
        module.acceptAdmin();
        vm.prank(stranger);
        module.acceptAdmin();
        assertEq(module.admin(), stranger);
        vm.prank(stranger);
        module.setGuardian(recipient);
        assertEq(module.guardian(), recipient);
    }

    function test_constructorDelayRules() public {
        SpendingLimitModuleV2.Config memory c0 = _config(0);
        vm.expectRevert(SpendingLimitModuleV2.BadDelay.selector);
        new SpendingLimitModuleV2(c0);
        vm.chainId(1);
        SpendingLimitModuleV2.Config memory c10 = _config(10 minutes);
        vm.expectRevert(SpendingLimitModuleV2.BadDelay.selector);
        new SpendingLimitModuleV2(c10);
        SpendingLimitModuleV2 m = new SpendingLimitModuleV2(_config(48 hours));
        assertEq(m.agentChangeDelay(), 48 hours);
        SpendingLimitModuleV2.Config memory c = _config(48 hours);
        c.guardian = address(0);
        vm.expectRevert(SpendingLimitModuleV2.ZeroAddress.selector);
        new SpendingLimitModuleV2(c);
        c = _config(48 hours);
        c.callPolicy = address(0);
        vm.expectRevert(SpendingLimitModuleV2.ZeroAddress.selector);
        new SpendingLimitModuleV2(c);
        c = _config(48 hours);
        c.setupHelper = address(0);
        vm.expectRevert(SpendingLimitModuleV2.ZeroAddress.selector);
        new SpendingLimitModuleV2(c);
    }

    /// Metering and the rules must agree on the tokens and router: the module takes them from the
    /// policy instead of its own parameters, so they can't be deployed mismatched.
    function test_moduleReadsTokensFromPolicy() public view {
        SpendingLimitCallPolicyV2 policy = module.callPolicy();
        assertEq(module.weth(), policy.weth());
        assertEq(module.usdc(), policy.usdc());
        assertEq(module.universalRouter(), address(ur));
        assertEq(policy.universalRouter(), address(ur));
        assertTrue(policy.allowedSpender(address(p2)));
        assertTrue(policy.blockedTarget(safeFactory));
    }

    // ── Universal Router decoding ───────────────────────────────────────────

    function test_routerV3SwapBackToSafeAllowed() public {
        // ETH in: WRAP_ETH(router) → V3 exact-in(MSG_SENDER); token in: V3 exact-out(safe) → SWEEP(safe); UNWRAP(MSG_SENDER).
        bytes[] memory inputs = new bytes[](5);
        inputs[0] = abi.encode(address(2), uint256(1e15));
        inputs[1] = _v3In(address(1));
        inputs[2] = abi.encode(address(safe), uint256(1e6), uint256(2e6), bytes(""), true);
        inputs[3] = abi.encode(address(usdc), address(safe), uint256(0));
        inputs[4] = abi.encode(address(1), uint256(0));
        _exec(_router(hex"0b0001040c", inputs));
    }

    function test_routerExecuteWithoutDeadlineAndPayPortion() public {
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = _v3In(address(2));
        inputs[1] = abi.encode(address(usdc), address(1), uint256(10_000));
        _exec(_one(address(ur), 0, abi.encodeWithSelector(bytes4(0x24856bc3), hex"0006", inputs)));
    }

    function test_attack_routerSwapToAttackerRefused() public {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _v3In(attacker);
        _expectExecRevert(_router(hex"00", inputs), abi.encodeWithSelector(SpendingLimitModuleV2.BadRecipient.selector));
        inputs[0] = abi.encode(attacker, uint256(1), uint256(2), bytes(""), true);
        _expectExecRevert(_router(hex"01", inputs), abi.encodeWithSelector(SpendingLimitModuleV2.BadRecipient.selector));
    }

    function test_attack_routerSweepTransferPayUnwrapToAttackerRefused() public {
        bytes[] memory inputs = new bytes[](1);
        bytes1[4] memory cmds = [bytes1(0x04), bytes1(0x05), bytes1(0x06), bytes1(0x0c)];
        for (uint256 i = 0; i < 4; i++) {
            inputs[0] = cmds[i] == bytes1(0x0c)
                ? abi.encode(attacker, uint256(0))
                : abi.encode(address(usdc), attacker, uint256(1));
            _expectExecRevert(_router(abi.encodePacked(cmds[i]), inputs), abi.encodeWithSelector(SpendingLimitModuleV2.BadRecipient.selector));
        }
    }

    function test_attack_routerForbiddenCommandsRefused() public {
        // PERMIT2_TRANSFER_FROM, PERMIT2_PERMIT_BATCH, V2 in/out, PERMIT2_PERMIT, PERMIT2_TRANSFER_FROM_BATCH,
        // BALANCE_CHECK, V4_SWAP, EXECUTE_SUB_PLAN.
        uint8[10] memory bad = [uint8(0x02), 0x03, 0x08, 0x09, 0x0a, 0x0d, 0x0e, 0x10, 0x21, 0x3f];
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(safe), address(safe), uint256(1));
        for (uint256 i = 0; i < bad.length; i++) {
            _expectExecRevert(_router(abi.encodePacked(bad[i]), inputs), abi.encodeWithSelector(SpendingLimitModuleV2.CommandNotAllowed.selector, bad[i]));
        }
    }

    function test_attack_routerAllowRevertFlagRefused() public {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _v3In(address(safe));
        _expectExecRevert(_router(hex"80", inputs), abi.encodeWithSelector(SpendingLimitModuleV2.CommandNotAllowed.selector, uint8(0x80)));
        _expectExecRevert(_router(hex"40", inputs), abi.encodeWithSelector(SpendingLimitModuleV2.CommandNotAllowed.selector, uint8(0x40)));
    }

    function test_attack_routerMalformedRefused() public {
        bytes[] memory two = new bytes[](2);
        two[0] = _v3In(address(safe));
        two[1] = _v3In(address(safe));
        _expectExecRevert(_router(hex"00", two), abi.encodeWithSelector(SpendingLimitModuleV2.SelectorNotAllowed.selector));
        _expectExecRevert(_router(hex"", new bytes[](0)), abi.encodeWithSelector(SpendingLimitModuleV2.SelectorNotAllowed.selector));
        bytes[] memory short = new bytes[](1);
        short[0] = hex"00";
        _expectExecRevert(_router(hex"00", short), abi.encodeWithSelector(SpendingLimitModuleV2.BadRecipient.selector));
        bytes[] memory dirty = new bytes[](1);
        dirty[0] = abi.encode(uint256(uint160(address(safe))) | (uint256(1) << 200), uint256(1), uint256(0), bytes(""), true);
        _expectExecRevert(_router(hex"00", dirty), abi.encodeWithSelector(SpendingLimitModuleV2.BadRecipient.selector));
        _expectExecRevert(_one(address(ur), 0, hex"deadbeef"), abi.encodeWithSelector(SpendingLimitModuleV2.SelectorNotAllowed.selector));
    }

    // ── carried over from v1 ────────────────────────────────────────────────

    function test_attack_callToSafeRefused() public {
        _expectExecRevert(_one(address(safe), 0, abi.encodeCall(MockSafeV2.addOwnerWithThreshold, (attacker, 1))), abi.encodeWithSelector(SpendingLimitModuleV2.BlockedTarget.selector));
        _expectExecRevert(_one(safeFactory, 0, hex"12345678"), abi.encodeWithSelector(SpendingLimitModuleV2.BlockedTarget.selector));
    }

    function test_attack_approveToAttackerRefused() public {
        _expectExecRevert(_one(address(usdc), 0, abi.encodeWithSelector(bytes4(0x095ea7b3), attacker, type(uint256).max)), abi.encodeWithSelector(SpendingLimitModuleV2.BadSpender.selector));
        _expectExecRevert(_one(address(p2), 0, abi.encodeWithSelector(bytes4(0x87517c45), address(usdc), attacker, uint160(1), uint48(1))), abi.encodeWithSelector(SpendingLimitModuleV2.BadSpender.selector));
    }

    function test_attack_unknownTargetWithDataRefused() public {
        _expectExecRevert(_one(attacker, 0, hex"a9059cbb"), abi.encodeWithSelector(SpendingLimitModuleV2.TargetNotAllowed.selector));
    }

    function test_usdcTransferMeteredAtOneDollar() public {
        _exec(_one(address(usdc), 0, abi.encodeWithSelector(bytes4(0xa9059cbb), recipient, uint256(250e6))));
        assertEq(module.spentToday(address(safe)), 25_000);
        assertEq(module.remainingToday(address(safe)), 75_000);
    }

    function test_capIsPerSafe() public {
        _exec(_one(recipient, 0.4 ether, ""));
        assertEq(module.remainingToday(address(safe)), 0);
        SpendingLimitModuleV2.Call[] memory calls = _one(recipient, 0.4 ether, "");
        module.execSigned(address(safeB), calls, block.timestamp + 600, _sig(agentBPk, address(safeB), calls));
        assertEq(module.spentToday(address(safeB)), 100_000);
    }

    function test_staleFeedReverts() public {
        vm.warp(block.timestamp + 2 hours);
        _expectExecRevert(_one(recipient, 0.01 ether, ""), abi.encodeWithSelector(SpendingLimitModuleV2.StalePrice.selector));
    }

    function test_attack_reentrancyThroughRouterRefused() public {
        ReentrantRouter rr = new ReentrantRouter();
        module = new SpendingLimitModuleV2(_configWith(DELAY, _policy(address(rr), new address[](0))));
        safe = _newSafe(agent);
        SpendingLimitModuleV2.Call[] memory inner = _one(recipient, 1, "");
        // The inner batch carries nonce 1 (after the outer one); it must still be refused.
        rr.arm(module, address(safe), block.timestamp + 600, _sigFor(module, agentPk, address(safe), inner, 1, block.timestamp + 600));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _v3In(address(safe));
        SpendingLimitModuleV2.Call[] memory outer = _one(address(rr), 0, abi.encodeWithSelector(bytes4(0x3593564c), hex"00", inputs, block.timestamp + 60));
        bytes memory sig = _sig(agentPk, address(safe), outer);
        vm.expectRevert();
        module.execSigned(address(safe), outer, block.timestamp + 600, sig);
        assertEq(recipient.balance, 0);
        assertEq(module.nonces(address(safe)), 0);
    }
}
