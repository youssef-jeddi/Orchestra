// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract OrchestraPolicy {

    struct UserPolicy {
        address safeAddress;
        address agentWallet;
        uint256 spendingLimitUSD;   // Per-transaction limit in USD cents (e.g. 10000 = $100)
        bool initialized;
    }

    mapping(address => UserPolicy) public policies;  // ledgerAddress => policy

    event PolicyCreated(address indexed user, address safeAddress, uint256 spendingLimit);
    event PolicyUpdated(address indexed user, uint256 newSpendingLimit);
    event SafeRegistered(address indexed user, address safeAddress);

    function registerSafe(address safeAddress, address agentWallet, uint256 spendingLimitUSD) external {
        policies[msg.sender] = UserPolicy({
            safeAddress: safeAddress,
            agentWallet: agentWallet,
            spendingLimitUSD: spendingLimitUSD,
            initialized: true
        });
        emit PolicyCreated(msg.sender, safeAddress, spendingLimitUSD);
    }

    function updateSpendingLimit(uint256 newLimitUSD) external {
        require(policies[msg.sender].initialized, "Policy not initialized");
        policies[msg.sender].spendingLimitUSD = newLimitUSD;
        emit PolicyUpdated(msg.sender, newLimitUSD);
    }

    function getPolicy(address user) external view returns (UserPolicy memory) {
        return policies[user];
    }

    function hasPolicy(address user) external view returns (bool) {
        return policies[user].initialized;
    }
}
