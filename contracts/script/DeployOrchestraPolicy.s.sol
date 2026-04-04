// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/OrchestraPolicy.sol";

contract DeployOrchestraPolicy is Script {
    function run() external {
        vm.startBroadcast();
        OrchestraPolicy policy = new OrchestraPolicy();
        console.log("OrchestraPolicy deployed at:", address(policy));
        vm.stopBroadcast();
    }
}
