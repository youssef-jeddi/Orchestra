// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The call rules of SpendingLimitModuleV2 (ORC-38), in their own contract. They are split
/// out only because of size: since the 2026 Sepolia gas repricing, code deposit costs about
/// 1,550 gas per byte, and a single contract with the module and these rules (~13.7 KB) would need
/// about 23M gas, above the 16.77M per-transaction cap (EIP-7825). Each half now deploys in its
/// own transaction. Stateless after construction: nothing here can be changed later.
///
/// Rules (unchanged from v1 except the router): per-target selector allowlist for USDC, WETH,
/// Permit2, the Universal Router and the V3 position manager; approvals only to known spenders;
/// LP recipients must be the Safe. Universal Router `execute` is decoded: only V3 exact-in/out,
/// WRAP_ETH, UNWRAP_WETH, SWEEP, TRANSFER and PAY_PORTION, with every recipient the Safe or the
/// router's MSG_SENDER / ADDRESS_THIS markers.

import {NpmDecode} from "./SpendingLimitModule.sol";

contract SpendingLimitCallPolicyV2 {
    address public immutable weth;
    address public immutable usdc;
    address public immutable universalRouter;
    address public immutable permit2;
    address public immutable positionManager;

    mapping(address => bool) public allowedSpender;
    mapping(address => bool) public blockedTarget;

    // ── selectors ───────────────────────────────────────────────────────────
    bytes4 private constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 private constant SEL_APPROVE = 0x095ea7b3;
    bytes4 private constant SEL_DEPOSIT = 0xd0e30db0;
    bytes4 private constant SEL_WITHDRAW = 0x2e1a7d4d;
    bytes4 private constant SEL_PERMIT2_APPROVE = 0x87517c45;
    bytes4 private constant SEL_UR_EXECUTE_DEADLINE = 0x3593564c;
    bytes4 private constant SEL_UR_EXECUTE = 0x24856bc3;
    bytes4 private constant SEL_NPM_MINT = 0x88316456;
    bytes4 private constant SEL_NPM_INCREASE = 0x219f5d17;
    bytes4 private constant SEL_NPM_DECREASE = 0x0c49ccbe;
    bytes4 private constant SEL_NPM_COLLECT = 0xfc6f7865;
    bytes4 private constant SEL_NPM_MULTICALL = 0xac9650d8;
    bytes4 private constant SEL_NPM_REFUND_ETH = 0x12210e8a;
    bytes4 private constant SEL_NPM_UNWRAP = 0x49404b7c;

    // ── Universal Router commands (low 6 bits; the top two bits are flags) ──
    uint8 private constant CMD_FLAGS_MASK = 0xc0; // 0x80 = allow revert, 0x40 = reserved
    uint8 private constant CMD_V3_SWAP_EXACT_IN = 0x00;
    uint8 private constant CMD_V3_SWAP_EXACT_OUT = 0x01;
    uint8 private constant CMD_SWEEP = 0x04;
    uint8 private constant CMD_TRANSFER = 0x05;
    uint8 private constant CMD_PAY_PORTION = 0x06;
    uint8 private constant CMD_WRAP_ETH = 0x0b;
    uint8 private constant CMD_UNWRAP_WETH = 0x0c;
    /// Universal Router recipient markers: "the caller" (the Safe) and "the router itself".
    address private constant UR_MSG_SENDER = address(1);
    address private constant UR_ADDRESS_THIS = address(2);

    error ZeroAddress();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error CommandNotAllowed(uint8 command);
    error BadSpender();
    error BadRecipient();
    error BadToken();
    error BlockedTarget();
    error NestedMulticall();

    /// @param spenders_ Extra approve targets (Permit2, Universal Router and NPM are always added).
    /// @param blocked_ Safe singleton / proxy factory addresses that must never be `to`.
    constructor(
        address weth_,
        address usdc_,
        address universalRouter_,
        address permit2_,
        address positionManager_,
        address[] memory spenders_,
        address[] memory blocked_
    ) {
        if (
            weth_ == address(0) || usdc_ == address(0) || universalRouter_ == address(0) || permit2_ == address(0)
                || positionManager_ == address(0)
        ) revert ZeroAddress();
        weth = weth_;
        usdc = usdc_;
        universalRouter = universalRouter_;
        permit2 = permit2_;
        positionManager = positionManager_;
        for (uint256 i = 0; i < spenders_.length; i++) {
            if (spenders_[i] == address(0)) revert ZeroAddress();
            allowedSpender[spenders_[i]] = true;
        }
        allowedSpender[permit2_] = true;
        allowedSpender[universalRouter_] = true;
        allowedSpender[positionManager_] = true;
        for (uint256 i = 0; i < blocked_.length; i++) {
            if (blocked_[i] == address(0)) revert ZeroAddress();
            blockedTarget[blocked_[i]] = true;
        }
    }

    /// Reverts (with the reason) unless `safe` may make this plain call. The module refuses itself
    /// and its setup helper as targets before asking.
    function checkCall(address safe, address to, bytes calldata data) external view {
        if (to == address(0)) revert ZeroAddress();
        if (to == safe || to == address(this) || blockedTarget[to]) revert BlockedTarget();

        if (data.length == 0) return; // plain ETH send (metered)
        if (data.length < 4) revert SelectorNotAllowed();
        bytes4 sel = bytes4(data[0:4]);

        if (to == usdc) return _checkErc20(sel, data, false);
        if (to == weth) return _checkErc20(sel, data, true);
        if (to == permit2) return _checkPermit2(sel, data);
        if (to == universalRouter) return _checkRouter(safe, sel, data);
        if (to == positionManager) return _checkNpm(safe, sel, data, false);
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
        if (sel != SEL_PERMIT2_APPROVE) revert SelectorNotAllowed();
        if (data.length != 4 + 128) revert SelectorNotAllowed();
        address token = address(uint160(uint256(bytes32(data[4:36]))));
        address spender = address(uint160(uint256(bytes32(data[36:68]))));
        if (token != weth && token != usdc) revert BadToken();
        if (spender != universalRouter) revert BadSpender();
    }

    /// Decodes `execute(commands, inputs[, deadline])` and allows only the swap shapes Orchestra
    /// builds, with every recipient pointing back at the Safe.
    function _checkRouter(address safe, bytes4 sel, bytes calldata data) internal pure {
        bytes memory commands;
        bytes[] memory inputs;
        if (sel == SEL_UR_EXECUTE_DEADLINE) {
            (commands, inputs,) = abi.decode(data[4:], (bytes, bytes[], uint256));
        } else if (sel == SEL_UR_EXECUTE) {
            (commands, inputs) = abi.decode(data[4:], (bytes, bytes[]));
        } else {
            revert SelectorNotAllowed();
        }
        if (commands.length == 0 || commands.length != inputs.length) revert SelectorNotAllowed();

        for (uint256 i = 0; i < commands.length; i++) {
            uint8 cmd = uint8(commands[i]);
            // No allow-revert or reserved flags: a sub-step must never fail silently.
            if (cmd & CMD_FLAGS_MASK != 0) revert CommandNotAllowed(cmd);
            uint256 recipientWord;
            if (cmd == CMD_V3_SWAP_EXACT_IN || cmd == CMD_V3_SWAP_EXACT_OUT || cmd == CMD_WRAP_ETH || cmd == CMD_UNWRAP_WETH) {
                recipientWord = 0; // (address recipient, ...)
            } else if (cmd == CMD_SWEEP || cmd == CMD_TRANSFER || cmd == CMD_PAY_PORTION) {
                recipientWord = 1; // (address token, address recipient, ...)
            } else {
                revert CommandNotAllowed(cmd); // V2, V4, PERMIT2_*, sub-plans, NFT and everything else
            }
            _checkRouterRecipient(safe, inputs[i], recipientWord);
        }
    }

    function _checkRouterRecipient(address safe, bytes memory input, uint256 word) internal pure {
        if (input.length < (word + 1) * 32) revert BadRecipient();
        uint256 raw;
        assembly {
            raw := mload(add(add(input, 32), mul(word, 32)))
        }
        if (raw >> 160 != 0) revert BadRecipient(); // dirty high bits: not a clean address
        address r = address(uint160(raw));
        if (r != safe && r != UR_MSG_SENDER && r != UR_ADDRESS_THIS) revert BadRecipient();
    }

    function _checkNpm(address safe, bytes4 sel, bytes calldata data, bool insideMulticall) internal view {
        if (sel == SEL_NPM_MINT) {
            if (abi.decode(data[4:], (NpmDecode.MintParams)).recipient != safe) revert BadRecipient();
            return;
        }
        if (sel == SEL_NPM_COLLECT) {
            if (abi.decode(data[4:], (NpmDecode.CollectParams)).recipient != safe) revert BadRecipient();
            return;
        }
        if (sel == SEL_NPM_UNWRAP) {
            (, address recipient) = abi.decode(data[4:], (uint256, address));
            if (recipient != safe) revert BadRecipient();
            return;
        }
        if (sel == SEL_NPM_INCREASE || sel == SEL_NPM_DECREASE || sel == SEL_NPM_REFUND_ETH) return;
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
            if (sel == SEL_NPM_MINT) {
                if (abi.decode(_skipSel(one), (NpmDecode.MintParams)).recipient != safe) revert BadRecipient();
            } else if (sel == SEL_NPM_COLLECT) {
                if (abi.decode(_skipSel(one), (NpmDecode.CollectParams)).recipient != safe) revert BadRecipient();
            } else if (sel == SEL_NPM_UNWRAP) {
                (, address recipient) = abi.decode(_skipSel(one), (uint256, address));
                if (recipient != safe) revert BadRecipient();
            } else if (sel == SEL_NPM_INCREASE || sel == SEL_NPM_DECREASE || sel == SEL_NPM_REFUND_ETH) {
                // ok
            } else if (sel == SEL_NPM_MULTICALL) {
                revert NestedMulticall();
            } else {
                revert SelectorNotAllowed();
            }
        }
    }

    function _skipSel(bytes memory data) internal pure returns (bytes memory payload) {
        payload = new bytes(data.length - 4);
        for (uint256 i = 4; i < data.length; i++) {
            payload[i - 4] = data[i];
        }
    }
}
