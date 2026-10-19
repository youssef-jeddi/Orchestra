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

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
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

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        if (revertOnRead) revert("feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MockSafe {
    address public module;

    function setModule(address module_) external {
        module = module_;
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, ISafe.Operation)
        external
        returns (bool)
    {
        require(msg.sender == module, "not module");
        bytes memory ret;
        bool ok;
        if (data.length == 0) (ok, ret) = to.call{value: value}("");
        else (ok, ret) = to.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return true;
    }

    // Minimal Safe config surface for attack tests (agent tries to call these via to==safe)
    function addOwnerWithThreshold(address, uint256) external pure {
        revert("should never run");
    }

    function enableModule(address) external pure {
        revert("should never run");
    }

    function disableModule(address, address) external pure {
        revert("should never run");
    }

    function setGuard(address) external pure {
        revert("should never run");
    }

    function setFallbackHandler(address) external pure {
        revert("should never run");
    }

    function changeThreshold(uint256) external pure {
        revert("should never run");
    }

    receive() external payable {}
}

contract MockPermit2 {
    event Approved(address token, address spender, uint160 amount, uint48 expiration);

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        emit Approved(token, spender, amount, expiration);
    }
}

contract MockUniversalRouter {
    event Executed(bytes commands, uint256 value);
    address public callbackAgent;

    function setCallback(address agent) external {
        callbackAgent = agent;
    }

    function execute(bytes calldata commands, bytes[] calldata, uint256) external payable {
        emit Executed(commands, msg.value);
        if (callbackAgent != address(0)) SmartAgent(payable(callbackAgent)).reenter();
    }

    function execute(bytes calldata commands, bytes[] calldata) external payable {
        emit Executed(commands, msg.value);
        if (callbackAgent != address(0)) SmartAgent(payable(callbackAgent)).reenter();
    }

    function pullUsdc(address token, address from, uint256 amount) external {
        MockERC20(token).transferFrom(from, address(this), amount);
    }
}

contract MockNpm {
    event Minted(address recipient);
    event Collected(address recipient);

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

    function mint(MintParams calldata params) external payable returns (uint256, uint128, uint256, uint256) {
        emit Minted(params.recipient);
        return (1, 0, 0, 0);
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256, uint256) {
        emit Collected(params.recipient);
        return (0, 0);
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256, uint256) {
        return (0, 0);
    }

    function refundETH() external payable {}

    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            results[i] = ret;
        }
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("nft move");
    }

    function approve(address, uint256) external pure {
        revert("nft approve");
    }

    function setApprovalForAll(address, bool) external pure {
        revert("nft operator");
    }
}

contract SmartAgent {
    SpendingLimitModule public module;
    address public safe;
    SpendingLimitModule.Call[] public reenterCalls;
    bool public doReenter;

    function setModule(SpendingLimitModule m) external {
        module = m;
    }

    function arm(address safe_, SpendingLimitModule.Call[] calldata calls) external {
        safe = safe_;
        delete reenterCalls;
        for (uint256 i = 0; i < calls.length; i++) {
            reenterCalls.push(calls[i]);
        }
        doReenter = true;
    }

    function reenter() external {
        if (!doReenter) return;
        doReenter = false;
        module.exec(safe, reenterCalls);
    }

    receive() external payable {}
}

