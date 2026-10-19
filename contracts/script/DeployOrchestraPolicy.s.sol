// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/OrchestraPolicy.sol";

/// Deploys the registry. The agent is the address allowed to register accounts: set AGENT_ADDRESS
/// to the server's agent wallet; if unset, the address broadcasting the deployment is used (so
/// deploy with the agent key). See contracts/README.md.
contract DeployOrchestraPolicy is Script {
    function run() external {
        vm.startBroadcast();
        // Inside a script msg.sender is not the broadcaster; readCallers() is.
        (, address broadcaster,) = vm.readCallers();
        address agent = vm.envOr("AGENT_ADDRESS", broadcaster);
        OrchestraPolicy policy = new OrchestraPolicy(agent);
        console.log("OrchestraPolicy deployed at:", address(policy));
        console.log("Agent:", agent);
        vm.stopBroadcast();
    }
}
