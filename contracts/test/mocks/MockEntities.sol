// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../src/SpendingLimitModule.sol";

contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockAggregator is AggregatorV3Interface {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public immutable override decimals;
    bool public revertOnRead;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setRevert(bool v) external {
        revertOnRead = v;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        if (revertOnRead) revert("feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// Minimal Safe stand-in: holds ETH/tokens and runs module calls. Not a real Safe.
contract MockSafe {
    address public module;
    bool public reenterOnExec;
    address public reenterTo;
    bytes public reenterData;

    function setModule(address module_) external {
        module = module_;
    }

    function setReenter(address to, bytes calldata data) external {
        reenterOnExec = true;
        reenterTo = to;
        reenterData = data;
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, ISafe.Operation)
        external
        returns (bool)
    {
        require(msg.sender == module, "not module");
        if (reenterOnExec) {
            reenterOnExec = false;
            SpendingLimitModule(module).exec(address(this), reenterTo, 0, reenterData, ISafe.Operation.Call);
        }
        bytes memory ret;
        bool ok;
        if (data.length == 0) {
            (ok, ret) = to.call{value: value}("");
        } else {
            (ok, ret) = to.call{value: value}(data);
        }
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return true;
    }

    receive() external payable {}
}

/// Pulls USDC from the Safe via transferFrom after an approve — used as an allowlisted "router".
contract MockRouter {
    function pullUsdc(address token, address from, uint256 amount) external {
        MockERC20(token).transferFrom(from, address(this), amount);
    }

    function pullEth() external payable {}

    /// Calls back into the agent so it can reenter the module (reentrancy test).
    function pullEthAndCallback(address agent) external payable {
        SmartAgent(payable(agent)).reenter();
    }
}

/// Contract-wallet agent used to prove the reentrancy lock.
contract SmartAgent {
    SpendingLimitModule public module;
    address public safe;
    address public to;
    bool public doReenter;

    function setModule(SpendingLimitModule m) external {
        module = m;
    }

    function arm(address safe_, address to_) external {
        safe = safe_;
        to = to_;
        doReenter = true;
    }

    function kick(uint256 value) external {
        module.exec(safe, to, value, "", ISafe.Operation.Call);
    }

    function reenter() external {
        if (!doReenter) return;
        doReenter = false;
        module.exec(safe, to, 0.001 ether, "", ISafe.Operation.Call);
    }

    receive() external payable {}
}

/// Target that transfers an unknown ERC20 out of the Safe (via prior approve).
contract MockDrainer {
    function pull(address token, address from, uint256 amount) external {
        MockERC20(token).transferFrom(from, address(this), amount);
    }
}

/// Packs Safe-style MultiSend and executes each inner call (Call only).
contract MockMultiSend {
    function multiSend(bytes memory transactions) external payable {
        uint256 i;
        while (i < transactions.length) {
            address to;
            uint256 value;
            uint256 len;
            assembly {
                // skip op (1 byte) for this mock — always Call
                to := shr(96, mload(add(add(transactions, 0x20), add(i, 1))))
                value := mload(add(add(transactions, 0x20), add(i, 0x15)))
                len := mload(add(add(transactions, 0x20), add(i, 0x35)))
            }
            bytes memory data = new bytes(len);
            for (uint256 j; j < len; j++) {
                data[j] = transactions[i + 0x55 + j];
            }
            (bool ok, bytes memory ret) = to.call{value: value}(data);
            if (!ok) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
            i += 0x55 + len;
        }
    }
}
