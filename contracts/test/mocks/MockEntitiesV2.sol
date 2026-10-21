// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../src/SpendingLimitModuleV2.sol";

/// A Safe stand-in with a real module list: `enableModule` only from itself (Safe's `authorized`),
/// `execTransactionFromModule` only for enabled modules, and `setupWith` to mimic `setup()`'s
/// delegatecall to the `to`/`data` pair.
contract MockSafeV2 {
    mapping(address => bool) public isModuleEnabled;

    function setupWith(address to, bytes calldata data) external {
        (bool ok, bytes memory ret) = to.delegatecall(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function enableModule(address module) external {
        require(msg.sender == address(this), "GS031");
        isModuleEnabled[module] = true;
    }

    /// Lets a test act as the owner: the Safe calls `target` itself (like an owner-signed transaction).
    function ownerCall(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, ISafe.Operation op)
        external
        returns (bool)
    {
        require(isModuleEnabled[msg.sender], "GS104");
        require(op == ISafe.Operation.Call, "no delegatecall");
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return true;
    }

    function addOwnerWithThreshold(address, uint256) external pure {
        revert("should never run");
    }

    receive() external payable {}
}

/// Universal Router stand-in that can call back into the module mid-batch (re-entrancy test).
contract ReentrantRouter {
    SpendingLimitModuleV2 public module;
    address public safe;
    bytes public sig;
    uint256 public deadline;
    bool public armed;

    function arm(SpendingLimitModuleV2 m, address safe_, uint256 deadline_, bytes calldata sig_) external {
        module = m;
        safe = safe_;
        deadline = deadline_;
        sig = sig_;
        armed = true;
    }

    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        if (!armed) return;
        armed = false;
        SpendingLimitModuleV2.Call[] memory calls = new SpendingLimitModuleV2.Call[](1);
        calls[0] = SpendingLimitModuleV2.Call(address(0xBEEF), 1, "");
        module.execSigned(safe, calls, deadline, sig);
    }

    function execute(bytes calldata, bytes[] calldata) external payable {}
}
