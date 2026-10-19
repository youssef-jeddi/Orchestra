// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Registry of each user's account (Safe) and spending limit, keyed by the Safe's address.
/// Before, entries were keyed by msg.sender, which is always the one agent, so every new
/// account overwrote the previous one. Nothing here moves funds: the limit is a record the
/// server keeps in step with the Safe's own allowance.
contract OrchestraPolicy {

    struct UserPolicy {
        address safeAddress;
        address agentWallet;
        uint256 spendingLimitUSD;   // In USD cents (e.g. 10000 = $100)
        bool initialized;
        address owner;              // The user's wallet that owns the Safe (informational)
    }

    /// The only address that may register accounts; it also acts for them when they update.
    address public immutable agent;

    mapping(address => UserPolicy) public policies;  // safeAddress => policy

    event PolicyCreated(address indexed safeAddress, address indexed owner, address agentWallet, uint256 spendingLimit);
    event PolicyUpdated(address indexed safeAddress, uint256 newSpendingLimit);

    error NotAgent();
    error NotSafeOrAgent();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();

    constructor(address agent_) {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
    }

    /// Only the agent registers, so nobody can claim a Safe address they don't run (addresses are
    /// predictable). An account registers once: a second call reverts and never overwrites.
    function registerSafe(address safeAddress, address owner, uint256 spendingLimitUSD) external {
        if (msg.sender != agent) revert NotAgent();
        if (safeAddress == address(0)) revert ZeroAddress();
        if (policies[safeAddress].initialized) revert AlreadyRegistered();
        policies[safeAddress] = UserPolicy({
            safeAddress: safeAddress,
            agentWallet: msg.sender,
            spendingLimitUSD: spendingLimitUSD,
            initialized: true,
            owner: owner
        });
        emit PolicyCreated(safeAddress, owner, msg.sender, spendingLimitUSD);
    }

    /// Changes one account's limit: called by that Safe itself (a transaction its owner signs) or
    /// by the agent that registered it. Never by anyone else, and never another account's entry.
    function updateSpendingLimit(address safeAddress, uint256 newLimitUSD) external {
        UserPolicy storage p = policies[safeAddress];
        if (!p.initialized) revert NotRegistered();
        if (msg.sender != safeAddress && msg.sender != p.agentWallet) revert NotSafeOrAgent();
        p.spendingLimitUSD = newLimitUSD;
        emit PolicyUpdated(safeAddress, newLimitUSD);
    }

    function getPolicy(address safeAddress) external view returns (UserPolicy memory) {
        return policies[safeAddress];
    }

    function hasPolicy(address safeAddress) external view returns (bool) {
        return policies[safeAddress].initialized;
    }
}
