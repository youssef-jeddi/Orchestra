// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice SpendingLimitModule v2 (ORC-38): the same fixed $1000/day per-Safe ceiling as v1, with
/// one agent key per Safe instead of one shared key, so a leaked key reaches one account only.
///
/// - Per-Safe agent. Set by the Safe itself (its owner, instantly; the new-Safe setup does this
///   through SafeSetupHelperV2), rotated by propose → accept after `agentChangeDelay`, revoked
///   instantly by the guardian, the admin or the Safe.
/// - Signed batches. The agent never sends transactions: it signs an EIP-712 `Exec` (Safe, calls,
///   per-Safe nonce, deadline; bound to chainId and this module) and anyone may relay it, so the
///   per-Safe key never needs ETH. The nonce makes every signature single-use.
/// - Global pause (guardian or admin, instant) stops every signed batch and agent change; only the
///   admin unpauses. The admin is meant to be a 2-of-2 Safe; there is no admin power over funds.
/// - Unchanged from v1: Call-only batches, per-target selector allowlist, gross metering of
///   outbound ETH+WETH (Chainlink) and USDC ($1), fail closed on a stale feed.
/// - New: Universal Router `execute` is decoded. Only V3 exact-in/out, WRAP_ETH, UNWRAP_WETH,
///   SWEEP, TRANSFER and PAY_PORTION are allowed, and every recipient must be the Safe or the
///   router's MSG_SENDER / ADDRESS_THIS markers — so swap output can't be routed to someone else.
/// - The call rules live in SpendingLimitCallPolicyV2 (fixed at deploy) only so that each contract
///   fits under the per-transaction gas cap; see that file. Their errors are re-declared here so
///   the module's ABI decodes every revert a batch can produce.

import {ISafe, AggregatorV3Interface, IERC20} from "./SpendingLimitModule.sol";
import {SpendingLimitCallPolicyV2} from "./SpendingLimitCallPolicyV2.sol";

interface IModuleManager {
    function enableModule(address module) external;
}

interface ISpendingLimitModuleV2 {
    function setAgentBySafe(address agent) external;
}

/// @notice Delegatecalled by a new Safe from `setup()` (the `to`/`data` pair): enables the module
/// and records the account's agent in one step. Stateless: under delegatecall `address(this)` is the
/// Safe, so both calls come from the Safe itself (Safe's `authorized` check and the module's
/// `msg.sender == safe` rule). Called directly it does nothing useful (it isn't a Safe).
contract SafeSetupHelperV2 {
    function setupModule(address module, address agent) external {
        IModuleManager(address(this)).enableModule(module);
        ISpendingLimitModuleV2(module).setAgentBySafe(agent);
    }
}

contract SpendingLimitModuleV2 {
    uint256 public constant VERSION = 2;
    uint256 public constant DAILY_LIMIT_CENTS = 100_000;
    /// Mainnet floor for the rotation delay; testnets may use a short one (e.g. 10 minutes).
    uint256 public constant MAINNET_MIN_DELAY = 48 hours;

    uint256 public immutable feedStaleAfter;
    uint8 public immutable usdcDecimals;
    uint256 public immutable agentChangeDelay;

    AggregatorV3Interface public immutable ethUsdFeed;
    address public immutable weth;
    address public immutable usdc;
    address public immutable universalRouter;
    /// Fixed call rules (see SpendingLimitCallPolicyV2); weth/usdc/router above are read from it.
    SpendingLimitCallPolicyV2 public immutable callPolicy;
    /// The stateless helper new Safes delegatecall during setup (deployed separately, to keep this
    /// contract's deploy transaction well under the gas cap).
    address public immutable setupHelper;

    address public admin;
    address public pendingAdmin;
    address public guardian;
    bool public paused;

    /// The one key allowed to sign batches for each Safe (zero = none / revoked).
    mapping(address => address) public agentOf;
    /// Per-Safe EIP-712 nonce, shared by Exec and ProposeAgent signatures.
    mapping(address => uint256) public nonces;

    struct PendingAgent {
        address agent;
        uint64 readyAt;
    }

    mapping(address => PendingAgent) public pendingAgentOf;

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    struct DaySpend {
        uint64 day;
        uint192 spentCents;
    }

    mapping(address => DaySpend) public spendOf;
    uint256 private locked;

    // ── EIP-712 ─────────────────────────────────────────────────────────────
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Orchestra SpendingLimitModule");
    bytes32 private constant VERSION_HASH = keccak256("2");
    bytes32 public constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");
    bytes32 public constant EXEC_TYPEHASH = keccak256(
        "Exec(address safe,Call[] calls,uint256 nonce,uint256 deadline)Call(address to,uint256 value,bytes data)"
    );
    bytes32 public constant PROPOSE_TYPEHASH =
        keccak256("ProposeAgent(address safe,address newAgent,uint256 nonce,uint256 deadline)");
    /// secp256k1n / 2: higher `s` values are the malleable twin of a valid signature.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;


    error NotAdmin();
    error NotPendingAdmin();
    error NotGuardianOrAdmin();
    error NotAuthorized();
    error ZeroAddress();
    error BadDelay();
    error Paused();
    error Expired();
    error NoAgent();
    error BadSignature();
    error NoPendingAgent();
    error TooEarly(uint256 readyAt);
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error CommandNotAllowed(uint8 command);
    error BadSpender();
    error BadRecipient();
    error BadToken();
    error BlockedTarget();
    error StalePrice();
    error BadPrice();
    error DailyLimitExceeded(uint256 spentCents, uint256 wouldSpendCents, uint256 limitCents);
    error ExecFailed();
    error Reentrancy();
    error EmptyBatch();
    error NestedMulticall();

    event Executed(address indexed safe, uint256 nonce, uint256 calls, uint256 spendCents, uint256 spentTodayCents);
    event AgentSet(address indexed safe, address indexed agent, address indexed by);
    event AgentProposed(address indexed safe, address indexed agent, uint256 readyAt, address indexed by);
    event AgentProposalCancelled(address indexed safe, address indexed by);
    event AgentRevoked(address indexed safe, address indexed by);
    event GlobalPause(address indexed by);
    event GlobalUnpause(address indexed by);
    event AdminTransferStarted(address indexed current, address indexed pending);
    event AdminChanged(address indexed previous, address indexed current);
    event GuardianChanged(address indexed previous, address indexed current);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyGuardianOrAdmin() {
        if (msg.sender != guardian && msg.sender != admin) revert NotGuardianOrAdmin();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (locked != 0) revert Reentrancy();
        locked = 1;
        _;
        locked = 0;
    }

    struct Config {
        address ethUsdFeed;
        uint8 usdcDecimals;
        uint256 feedStaleAfter;
        address callPolicy;
        address setupHelper;
        address admin;
        address guardian;
        uint256 agentChangeDelay;
    }

    constructor(Config memory c) {
        if (
            c.ethUsdFeed == address(0) || c.callPolicy == address(0) || c.setupHelper == address(0)
                || c.admin == address(0) || c.guardian == address(0)
        ) revert ZeroAddress();
        if (c.feedStaleAfter == 0) revert BadPrice();
        // A key change must give the guardian time to react; on mainnet at least 48 hours.
        if (c.agentChangeDelay == 0 || (block.chainid == 1 && c.agentChangeDelay < MAINNET_MIN_DELAY)) {
            revert BadDelay();
        }

        ethUsdFeed = AggregatorV3Interface(c.ethUsdFeed);
        callPolicy = SpendingLimitCallPolicyV2(c.callPolicy);
        // Metering must watch the same tokens the rules know about, so take them from the policy.
        weth = callPolicy.weth();
        usdc = callPolicy.usdc();
        universalRouter = callPolicy.universalRouter();
        usdcDecimals = c.usdcDecimals;
        feedStaleAfter = c.feedStaleAfter;
        agentChangeDelay = c.agentChangeDelay;
        admin = c.admin;
        guardian = c.guardian;
        setupHelper = c.setupHelper;
        emit AdminChanged(address(0), c.admin);
        emit GuardianChanged(address(0), c.guardian);
    }

    // ── signed batches ──────────────────────────────────────────────────────

    /// Run `calls` for `safe` as Safe Calls, authorised by the Safe's agent signature. Anyone may
    /// relay. Every call is checked before any runs; outbound USD is metered once afterwards.
    function execSigned(address safe, Call[] calldata calls, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
        nonReentrant
    {
        if (calls.length == 0) revert EmptyBatch();
        uint256 nonce = _useSignature(safe, _execStructHash(safe, calls, nonces[safe], deadline), deadline, signature);
        for (uint256 i = 0; i < calls.length; i++) {
            address to = calls[i].to;
            // The rules contract can't know these two; everything else is its call (reverts bubble).
            if (to == address(this) || to == setupHelper) revert BlockedTarget();
            callPolicy.checkCall(safe, to, calls[i].data);
        }
        (uint256 spendCents, uint256 spent) = _runMetered(safe, calls);
        emit Executed(safe, nonce, calls.length, spendCents, spent);
    }

    /// Runs the already-checked calls and charges the gross outflow to today's ceiling.
    function _runMetered(address safe, Call[] calldata calls) internal returns (uint256 spendCents, uint256 spent) {
        (uint256 ethEqBefore, uint256 usdcBefore) = _balances(safe);
        for (uint256 i = 0; i < calls.length; i++) {
            bool ok = ISafe(safe).execTransactionFromModule(calls[i].to, calls[i].value, calls[i].data, ISafe.Operation.Call);
            if (!ok) revert ExecFailed();
        }
        (uint256 ethEqAfter, uint256 usdcAfter) = _balances(safe);
        uint256 ethOut = ethEqBefore > ethEqAfter ? ethEqBefore - ethEqAfter : 0;
        uint256 usdcOut = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : 0;
        spendCents = _ethCents(ethOut) + _usdcCents(usdcOut);
        spent = _accumulate(safe, spendCents);
    }

    /// EIP-712 digest of an Exec, for off-chain signers and tests.
    function execDigest(address safe, Call[] calldata calls, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTyped(_execStructHash(safe, calls, nonce, deadline));
    }

    /// EIP-712 digest of a ProposeAgent, for off-chain signers and tests.
    function proposeDigest(address safe, address newAgent, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTyped(keccak256(abi.encode(PROPOSE_TYPEHASH, safe, newAgent, nonce, deadline)));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    // ── agent management ────────────────────────────────────────────────────

    /// The Safe itself (a transaction its owner signed, or the setup helper) sets its agent at once.
    /// Zero clears it. The owner already controls everything, so no delay is needed here.
    function setAgentBySafe(address agent) external {
        delete pendingAgentOf[msg.sender];
        agentOf[msg.sender] = agent;
        emit AgentSet(msg.sender, agent, msg.sender);
    }

    /// The admin proposes a new agent for `safe` (e.g. re-keying after a revoke). Takes effect only
    /// after `agentChangeDelay`, so the guardian or the owner can cancel it. Allowed while paused.
    function proposeAgent(address safe, address newAgent) external onlyAdmin {
        _propose(safe, newAgent);
    }

    /// The current agent proposes its own successor (routine key rotation), signed and relayed.
    function proposeAgentSigned(address safe, address newAgent, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        bytes32 structHash = keccak256(abi.encode(PROPOSE_TYPEHASH, safe, newAgent, nonces[safe], deadline));
        _useSignature(safe, structHash, deadline, signature);
        _propose(safe, newAgent);
    }

    /// Anyone finalises a proposal once its delay has passed (not while paused).
    function acceptAgent(address safe) external whenNotPaused {
        PendingAgent memory p = pendingAgentOf[safe];
        if (p.agent == address(0)) revert NoPendingAgent();
        if (block.timestamp < p.readyAt) revert TooEarly(p.readyAt);
        delete pendingAgentOf[safe];
        agentOf[safe] = p.agent;
        emit AgentSet(safe, p.agent, msg.sender);
    }

    /// Guardian, admin or the Safe drops a pending proposal.
    function cancelAgentProposal(address safe) external {
        _onlyGuardianAdminOrSafe(safe);
        delete pendingAgentOf[safe];
        emit AgentProposalCancelled(safe, msg.sender);
    }

    /// Guardian, admin or the Safe removes the agent (and any pending proposal) immediately.
    function revokeAgent(address safe) external {
        _onlyGuardianAdminOrSafe(safe);
        delete pendingAgentOf[safe];
        agentOf[safe] = address(0);
        emit AgentRevoked(safe, msg.sender);
    }

    // ── pause and roles ─────────────────────────────────────────────────────

    function pause() external onlyGuardianOrAdmin {
        paused = true;
        emit GlobalPause(msg.sender);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit GlobalUnpause(msg.sender);
    }

    function setGuardian(address newGuardian) external onlyAdmin {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0)) revert NotPendingAdmin();
        emit AdminChanged(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // ── views ───────────────────────────────────────────────────────────────

    function spentToday(address safe) public view returns (uint256) {
        DaySpend memory s = spendOf[safe];
        if (s.day != _day(block.timestamp)) return 0;
        return s.spentCents;
    }

    function remainingToday(address safe) external view returns (uint256) {
        uint256 spent = spentToday(safe);
        return spent >= DAILY_LIMIT_CENTS ? 0 : DAILY_LIMIT_CENTS - spent;
    }

    // ── internals: signatures and roles ─────────────────────────────────────

    function _onlyGuardianAdminOrSafe(address safe) internal view {
        if (msg.sender != guardian && msg.sender != admin && msg.sender != safe) revert NotAuthorized();
    }

    function _propose(address safe, address newAgent) internal {
        if (safe == address(0) || newAgent == address(0)) revert ZeroAddress();
        uint64 readyAt = uint64(block.timestamp + agentChangeDelay);
        pendingAgentOf[safe] = PendingAgent({agent: newAgent, readyAt: readyAt});
        emit AgentProposed(safe, newAgent, readyAt, msg.sender);
    }

    /// Checks deadline and that the Safe's current agent signed `structHash`, then burns the nonce.
    function _useSignature(address safe, bytes32 structHash, uint256 deadline, bytes calldata signature)
        internal
        returns (uint256 nonce)
    {
        if (safe == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert Expired();
        address agent = agentOf[safe];
        if (agent == address(0)) revert NoAgent();
        if (_recover(_hashTyped(structHash), signature) != agent) revert BadSignature();
        nonce = nonces[safe];
        nonces[safe] = nonce + 1;
    }

    function _execStructHash(address safe, Call[] calldata calls, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            hashes[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }
        return keccak256(abi.encode(EXEC_TYPEHASH, safe, keccak256(abi.encodePacked(hashes)), nonce, deadline));
    }

    function _hashTyped(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// 65-byte r‖s‖v only; high-s and v other than 27/28 are refused so a signature has one form.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    // ── internals: call checks ──────────────────────────────────────────────

    // ── internals: metering ─────────────────────────────────────────────────

    function _balances(address safe) internal view returns (uint256 ethEq, uint256 usdcBal) {
        ethEq = safe.balance + IERC20(weth).balanceOf(safe);
        usdcBal = IERC20(usdc).balanceOf(safe);
    }

    function _accumulate(address safe, uint256 spendCents) internal returns (uint256 spent) {
        uint64 day = _day(block.timestamp);
        DaySpend storage s = spendOf[safe];
        if (s.day != day) {
            s.day = day;
            s.spentCents = 0;
        }
        uint256 newSpent = uint256(s.spentCents) + spendCents;
        if (newSpent > DAILY_LIMIT_CENTS) revert DailyLimitExceeded(s.spentCents, spendCents, DAILY_LIMIT_CENTS);
        s.spentCents = uint192(newSpent);
        return newSpent;
    }

    function _day(uint256 ts) internal pure returns (uint64) {
        return uint64(ts / 1 days);
    }

    function _ethCents(uint256 weiAmount) internal view returns (uint256) {
        if (weiAmount == 0) return 0;
        (, int256 answer,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        if (answer <= 0) revert BadPrice();
        if (updatedAt == 0 || block.timestamp < updatedAt || block.timestamp - updatedAt > feedStaleAfter) {
            revert StalePrice();
        }
        uint8 dec = ethUsdFeed.decimals();
        return (weiAmount * uint256(answer) * 100) / (10 ** uint256(dec) * 1e18);
    }

    function _usdcCents(uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        if (usdcDecimals >= 2) return amount / (10 ** uint256(usdcDecimals - 2));
        return amount * (10 ** uint256(2 - usdcDecimals));
    }
}
