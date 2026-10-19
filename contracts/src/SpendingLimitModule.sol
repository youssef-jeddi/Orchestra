// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Fixed $1000/day on-chain ceiling for the Orchestra agent.
/// The agent is not a Safe owner: it may only move funds through this module.
/// Batches are Call-only (no DelegateCall / MultiSend). Every call is checked
/// against a per-target selector allowlist before any of them run. Spend is
/// outbound ETH+WETH (Chainlink) and USDC ($1). Approvals are restricted so a
/// compromised agent cannot grant an attacker a pull on tracked or untracked tokens.
///
/// Day boundary: the counter resets at UTC midnight, so two consecutive days can
/// allow up to $2000 across the boundary — the same as a plain "per day" limit.

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

/// Mirrors Uniswap v3 NonfungiblePositionManager mint/collect/unwrap arg shapes (decode only).
library NpmDecode {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
}

contract SpendingLimitModule {
    uint256 public constant DAILY_LIMIT_CENTS = 100_000;
    uint256 public immutable feedStaleAfter;
    uint8 public immutable usdcDecimals;

    address public immutable agent;
    AggregatorV3Interface public immutable ethUsdFeed;
    address public immutable weth;
    address public immutable usdc;
    address public immutable universalRouter;
    address public immutable permit2;
    address public immutable positionManager;

    /// Spenders that may receive ERC-20 / Permit2 approvals (Permit2, Universal Router, NPM).
    mapping(address => bool) public allowedSpender;
    /// Never callable as `to` (Safe singletons, proxy factories, …). The Safe and this module are always blocked.
    mapping(address => bool) public blockedTarget;

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

    // ERC-20 / WETH
    bytes4 private constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 private constant SEL_APPROVE = 0x095ea7b3;
    bytes4 private constant SEL_DEPOSIT = 0xd0e30db0;
    bytes4 private constant SEL_WITHDRAW = 0x2e1a7d4d;
    // Permit2
    bytes4 private constant SEL_PERMIT2_APPROVE = 0x87517c45;
    // Universal Router
    bytes4 private constant SEL_UR_EXECUTE_DEADLINE = 0x3593564c;
    bytes4 private constant SEL_UR_EXECUTE = 0x24856bc3;
    // NPM
    bytes4 private constant SEL_NPM_MINT = 0x88316456;
    bytes4 private constant SEL_NPM_INCREASE = 0x219f5d17;
    bytes4 private constant SEL_NPM_DECREASE = 0x0c49ccbe;
    bytes4 private constant SEL_NPM_COLLECT = 0xfc6f7865;
    bytes4 private constant SEL_NPM_MULTICALL = 0xac9650d8;
    bytes4 private constant SEL_NPM_REFUND_ETH = 0x12210e8a;
    bytes4 private constant SEL_NPM_UNWRAP = 0x49404b7c;

    error NotAgent();
    error ZeroAddress();
    error TargetNotAllowed();
    error SelectorNotAllowed();
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

    event Executed(address indexed safe, uint256 calls, uint256 spendCents, uint256 spentTodayCents);

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

    /// @param spenders_ Permit2, Universal Router, Position Manager (and any other allowed approve targets).
    /// @param blocked_ Safe singleton / proxy factory addresses that must never be `to`.
    constructor(
        address agent_,
        address ethUsdFeed_,
        address weth_,
        address usdc_,
        uint8 usdcDecimals_,
        uint256 feedStaleAfter_,
        address universalRouter_,
        address permit2_,
        address positionManager_,
        address[] memory spenders_,
        address[] memory blocked_
    ) {
        if (
            agent_ == address(0) || ethUsdFeed_ == address(0) || weth_ == address(0) || usdc_ == address(0)
                || universalRouter_ == address(0) || permit2_ == address(0) || positionManager_ == address(0)
        ) revert ZeroAddress();
        if (feedStaleAfter_ == 0) revert BadPrice();

        agent = agent_;
        ethUsdFeed = AggregatorV3Interface(ethUsdFeed_);
        weth = weth_;
        usdc = usdc_;
        usdcDecimals = usdcDecimals_;
        feedStaleAfter = feedStaleAfter_;
        universalRouter = universalRouter_;
        permit2 = permit2_;
        positionManager = positionManager_;

        for (uint256 i = 0; i < spenders_.length; i++) {
            if (spenders_[i] == address(0)) revert ZeroAddress();
            allowedSpender[spenders_[i]] = true;
        }
        // The three protocol addresses must always be spenders even if the array omitted them.
        allowedSpender[permit2_] = true;
        allowedSpender[universalRouter_] = true;
        allowedSpender[positionManager_] = true;

        for (uint256 i = 0; i < blocked_.length; i++) {
            if (blocked_[i] == address(0)) revert ZeroAddress();
            blockedTarget[blocked_[i]] = true;
        }
    }

    /// Agent-only: run `calls` as Safe Calls (no DelegateCall), check each, then meter outbound USD once.
    function exec(address safe, Call[] calldata calls) external onlyAgent nonReentrant {
        if (safe == address(0)) revert ZeroAddress();
        uint256 n = calls.length;
        if (n == 0) revert EmptyBatch();

        for (uint256 i = 0; i < n; i++) {
            _checkCall(safe, calls[i].to, calls[i].data);
        }

        (uint256 ethEqBefore, uint256 usdcBefore) = _balances(safe);

        for (uint256 i = 0; i < n; i++) {
            bool ok = ISafe(safe).execTransactionFromModule(
                calls[i].to, calls[i].value, calls[i].data, ISafe.Operation.Call
            );
            if (!ok) revert ExecFailed();
        }

        (uint256 ethEqAfter, uint256 usdcAfter) = _balances(safe);
        uint256 ethOut = ethEqBefore > ethEqAfter ? ethEqBefore - ethEqAfter : 0;
        uint256 usdcOut = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : 0;
        uint256 spendCents = _ethCents(ethOut) + _usdcCents(usdcOut);
        uint256 spent = _accumulate(safe, spendCents);

        emit Executed(safe, n, spendCents, spent);
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

    // ── call checks ─────────────────────────────────────────────────────────

    function _checkCall(address safe, address to, bytes calldata data) internal view {
        if (to == address(0)) revert ZeroAddress();
        if (to == safe || to == address(this) || blockedTarget[to]) revert BlockedTarget();

        // Plain ETH send to an arbitrary EOA / contract (empty calldata).
        if (data.length == 0) return;

        if (data.length < 4) revert SelectorNotAllowed();
        bytes4 sel = bytes4(data[0:4]);

        if (to == usdc) {
            _checkErc20(sel, data, false);
            return;
        }
        if (to == weth) {
            _checkErc20(sel, data, true);
            return;
        }
        if (to == permit2) {
            _checkPermit2(sel, data);
            return;
        }
        if (to == universalRouter) {
            if (sel != SEL_UR_EXECUTE_DEADLINE && sel != SEL_UR_EXECUTE) revert SelectorNotAllowed();
            return;
        }
        if (to == positionManager) {
            _checkNpm(safe, sel, data, false);
            return;
        }
        revert TargetNotAllowed();
    }

    function _checkErc20(bytes4 sel, bytes calldata data, bool isWeth) internal view {
        if (sel == SEL_TRANSFER) {
            if (data.length != 4 + 64) revert SelectorNotAllowed();
            return;
        }
        if (sel == SEL_APPROVE) {
            if (data.length != 4 + 64) revert SelectorNotAllowed();
            address spender = address(uint160(uint256(bytes32(data[4:36]))));
            if (!allowedSpender[spender]) revert BadSpender();
            return;
        }
        if (isWeth) {
            if (sel == SEL_DEPOSIT) {
                if (data.length != 4) revert SelectorNotAllowed();
                return;
            }
            if (sel == SEL_WITHDRAW) {
                if (data.length != 4 + 32) revert SelectorNotAllowed();
                return;
            }
        }
        revert SelectorNotAllowed();
    }

    function _checkPermit2(bytes4 sel, bytes calldata data) internal view {
        // approve(address token, address spender, uint160 amount, uint48 expiration)
        if (sel != SEL_PERMIT2_APPROVE) revert SelectorNotAllowed();
        if (data.length != 4 + 128) revert SelectorNotAllowed();
        address token = address(uint160(uint256(bytes32(data[4:36]))));
        address spender = address(uint160(uint256(bytes32(data[36:68]))));
        if (token != weth && token != usdc) revert BadToken();
        if (spender != universalRouter) revert BadSpender();
    }

    function _checkNpm(address safe, bytes4 sel, bytes calldata data, bool insideMulticall) internal view {
        if (sel == SEL_NPM_MINT) {
            address recipient = _mintRecipient(data);
            if (recipient != safe) revert BadRecipient();
            return;
        }
        if (sel == SEL_NPM_COLLECT) {
            address recipient = _collectRecipient(data);
            if (recipient != safe) revert BadRecipient();
            return;
        }
        if (sel == SEL_NPM_UNWRAP) {
            address recipient = _unwrapRecipient(data);
            if (recipient != safe) revert BadRecipient();
            return;
        }
        if (sel == SEL_NPM_INCREASE || sel == SEL_NPM_DECREASE || sel == SEL_NPM_REFUND_ETH) {
            return;
        }
        if (sel == SEL_NPM_MULTICALL) {
            if (insideMulticall) revert NestedMulticall();
            _checkNpmMulticall(safe, data);
            return;
        }
        revert SelectorNotAllowed();
    }

    function _checkNpmMulticall(address safe, bytes calldata data) internal pure {
        bytes[] memory inner = abi.decode(data[4:], (bytes[]));
        for (uint256 i = 0; i < inner.length; i++) {
            bytes memory one = inner[i];
            if (one.length < 4) revert SelectorNotAllowed();
            bytes4 sel;
            assembly {
                sel := mload(add(one, 32))
            }
            // Recreate calldata-style check using a memory copy via assembly is awkward;
            // decode recipients from memory bytes instead.
            if (sel == SEL_NPM_MINT) {
                if (_mintRecipientMem(one) != safe) revert BadRecipient();
            } else if (sel == SEL_NPM_COLLECT) {
                if (_collectRecipientMem(one) != safe) revert BadRecipient();
            } else if (sel == SEL_NPM_UNWRAP) {
                if (_unwrapRecipientMem(one) != safe) revert BadRecipient();
            } else if (sel == SEL_NPM_INCREASE || sel == SEL_NPM_DECREASE || sel == SEL_NPM_REFUND_ETH) {
                // ok
            } else if (sel == SEL_NPM_MULTICALL) {
                revert NestedMulticall();
            } else {
                revert SelectorNotAllowed();
            }
        }
    }

    function _mintRecipient(bytes calldata data) internal pure returns (address) {
        return abi.decode(data[4:], (NpmDecode.MintParams)).recipient;
    }

    function _collectRecipient(bytes calldata data) internal pure returns (address) {
        return abi.decode(data[4:], (NpmDecode.CollectParams)).recipient;
    }

    function _unwrapRecipient(bytes calldata data) internal pure returns (address) {
        (, address recipient) = abi.decode(data[4:], (uint256, address));
        return recipient;
    }

    function _mintRecipientMem(bytes memory data) internal pure returns (address) {
        return abi.decode(_skipSel(data), (NpmDecode.MintParams)).recipient;
    }

    function _collectRecipientMem(bytes memory data) internal pure returns (address) {
        return abi.decode(_skipSel(data), (NpmDecode.CollectParams)).recipient;
    }

    function _unwrapRecipientMem(bytes memory data) internal pure returns (address) {
        (, address recipient) = abi.decode(_skipSel(data), (uint256, address));
        return recipient;
    }

    function _skipSel(bytes memory data) internal pure returns (bytes memory payload) {
        require(data.length >= 4, "sel");
        payload = new bytes(data.length - 4);
        for (uint256 i = 4; i < data.length; i++) {
            payload[i - 4] = data[i];
        }
    }

    // ── metering ────────────────────────────────────────────────────────────

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
        uint8 dec = ethUsdFeed.decimals();
        return (weiAmount * uint256(answer) * 100) / (10 ** uint256(dec) * 1e18);
    }

    function _usdcCents(uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        if (usdcDecimals >= 2) return amount / (10 ** uint256(usdcDecimals - 2));
        return amount * (10 ** uint256(2 - usdcDecimals));
    }
}
