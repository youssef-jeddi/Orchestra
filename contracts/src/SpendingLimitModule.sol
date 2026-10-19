// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Fixed $1000/day on-chain ceiling for the Orchestra agent.
/// The agent is not a Safe owner: it may only move funds through this module.
/// Spend is measured as outbound USD value of ETH/WETH (Chainlink) and USDC (1:1).
/// Unknown tokens and a stale/missing ETH/USD feed refuse the call (fail closed).
/// The daily ceiling is immutable; only the Safe's owner can change Safe config.

interface ISafe {
    enum Operation {
        Call,
        DelegateCall
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, Operation operation)
        external
        returns (bool success);
}

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract SpendingLimitModule {
    /// $1000 in USD cents.
    uint256 public constant DAILY_LIMIT_CENTS = 100_000;
    /// Refuse a Chainlink answer older than this (mainnet-safe; Sepolia feeds update less often — override via constructor).
    uint256 public immutable feedStaleAfter;
    /// USDC decimals on the target chain (6 on Ethereum / Sepolia).
    uint8 public immutable usdcDecimals;

    address public immutable agent;
    AggregatorV3Interface public immutable ethUsdFeed;
    address public immutable weth;
    address public immutable usdc;

    mapping(address => bool) public allowedTarget;
    /// DelegateCall is only safe to MultiSend contracts we trust.
    mapping(address => bool) public allowedDelegate;

    struct DaySpend {
        uint64 day; // floor(timestamp / 1 days)
        uint192 spentCents;
    }

    mapping(address => DaySpend) public spendOf;

    uint256 private locked;

    error NotAgent();
    error ZeroAddress();
    error TargetNotAllowed();
    error DelegateNotAllowed();
    error StalePrice();
    error BadPrice();
    error DailyLimitExceeded(uint256 spentCents, uint256 wouldSpendCents, uint256 limitCents);
    error ExecFailed();
    error Reentrancy();

    event Executed(address indexed safe, address indexed to, uint256 value, uint256 spendCents, uint256 spentTodayCents);
    event TargetAllowed(address indexed target, bool allowed);
    event DelegateAllowed(address indexed target, bool allowed);

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (locked != 0) revert Reentrancy();
        locked = 1;
        _;
        locked = 0;
    }

    /// @param feedStaleAfter_ Max age of the ETH/USD answer in seconds (e.g. 1 hours on mainnet, 24 hours on Sepolia).
    constructor(
        address agent_,
        address ethUsdFeed_,
        address weth_,
        address usdc_,
        uint8 usdcDecimals_,
        uint256 feedStaleAfter_,
        address[] memory callTargets,
        address[] memory delegateTargets
    ) {
        if (agent_ == address(0) || ethUsdFeed_ == address(0) || weth_ == address(0) || usdc_ == address(0)) {
            revert ZeroAddress();
        }
        if (feedStaleAfter_ == 0) revert BadPrice();
        agent = agent_;
        ethUsdFeed = AggregatorV3Interface(ethUsdFeed_);
        weth = weth_;
        usdc = usdc_;
        usdcDecimals = usdcDecimals_;
        feedStaleAfter = feedStaleAfter_;
        for (uint256 i = 0; i < callTargets.length; i++) {
            if (callTargets[i] == address(0)) revert ZeroAddress();
            allowedTarget[callTargets[i]] = true;
            emit TargetAllowed(callTargets[i], true);
        }
        for (uint256 i = 0; i < delegateTargets.length; i++) {
            if (delegateTargets[i] == address(0)) revert ZeroAddress();
            allowedDelegate[delegateTargets[i]] = true;
            emit DelegateAllowed(delegateTargets[i], true);
        }
    }

    /// Agent-only: execute `to/value/data` on `safe` through the module, metering outbound USD.
    function exec(address safe, address to, uint256 value, bytes calldata data, ISafe.Operation operation)
        external
        onlyAgent
        nonReentrant
    {
        if (safe == address(0) || to == address(0)) revert ZeroAddress();
        _checkTarget(to, data, operation);

        (uint256 ethEqBefore, uint256 usdcBefore) = _balances(safe);

        bool ok = ISafe(safe).execTransactionFromModule(to, value, data, operation);
        if (!ok) revert ExecFailed();

        (uint256 ethEqAfter, uint256 usdcAfter) = _balances(safe);
        // Outbound only: increases (swap output, wrap) do not reduce the spend.
        uint256 ethOut = ethEqBefore > ethEqAfter ? ethEqBefore - ethEqAfter : 0;
        uint256 usdcOut = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : 0;

        // Any drop in a non-tracked token would not show here; callers must only hit allowlisted
        // routes that move ETH/WETH/USDC. Plain ERC20 transfers of other tokens are refused by
        // _checkTarget (token contract not allowlisted, and not a simple ETH send).

        uint256 spendCents = _ethCents(ethOut) + _usdcCents(usdcOut);
        uint256 spent = _accumulate(safe, spendCents);

        emit Executed(safe, to, value, spendCents, spent);
    }

    function spentToday(address safe) external view returns (uint256) {
        DaySpend memory s = spendOf[safe];
        if (s.day != _day(block.timestamp)) return 0;
        return s.spentCents;
    }

    function remainingToday(address safe) external view returns (uint256) {
        uint256 spent = this.spentToday(safe);
        return spent >= DAILY_LIMIT_CENTS ? 0 : DAILY_LIMIT_CENTS - spent;
    }

    // ── internals ───────────────────────────────────────────────────────────

    function _checkTarget(address to, bytes calldata data, ISafe.Operation operation) internal view {
        if (operation == ISafe.Operation.DelegateCall) {
            if (!allowedDelegate[to]) revert DelegateNotAllowed();
            return;
        }
        // Call: ETH send to anyone, or call to an allowlisted contract (router, Permit2, NPM, token…).
        // Token contracts (USDC/WETH) are allowlisted so approve/transfer work; other ERC-20s are not.
        if (to == weth || to == usdc || allowedTarget[to]) return;
        // Plain ETH transfer (empty data) to an arbitrary recipient is allowed; metering catches value.
        if (data.length == 0) return;
        // Non-empty data to a non-allowlisted address is refused (blocks arbitrary calls / unknown tokens).
        revert TargetNotAllowed();
    }

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
        if (newSpent > DAILY_LIMIT_CENTS) {
            revert DailyLimitExceeded(s.spentCents, spendCents, DAILY_LIMIT_CENTS);
        }
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
        uint8 dec = ethUsdFeed.decimals(); // typically 8
        // wei * price(1e8) / 1e18 → USD with `dec` decimals; then → cents (2 decimals).
        // cents = wei * price * 100 / (10^dec * 10^18)
        return (weiAmount * uint256(answer) * 100) / (10 ** uint256(dec) * 1e18);
    }

    function _usdcCents(uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        // USDC 1:1 → cents. amount has usdcDecimals; cents have 2.
        if (usdcDecimals >= 2) {
            return amount / (10 ** uint256(usdcDecimals - 2));
        }
        return amount * (10 ** uint256(2 - usdcDecimals));
    }
}
