// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Arena} from "../src/Arena.sol";

/// forge script script/Deploy.s.sol --rpc-url monad --broadcast --private-key $OPERATOR_PK
/// 部署者即 operator（引擎用同一把私钥）。入场费 / 打气费可用 ENTRY_FEE / CHEER_FEE 覆盖（单位 wei），
/// 每局真人上限用 MAX_PLAYERS 覆盖（默认 16，庄家不占名额）
contract Deploy is Script {
    function run() external returns (Arena arena) {
        uint256 entryFee = vm.envOr("ENTRY_FEE", uint256(0.01 ether));
        uint256 cheerFee = vm.envOr("CHEER_FEE", uint256(0.001 ether));
        uint256 maxPlayers = vm.envOr("MAX_PLAYERS", uint256(16));
        vm.startBroadcast();
        arena = new Arena(entryFee, cheerFee, maxPlayers);
        vm.stopBroadcast();
        console2.log("Arena", address(arena));
        console2.log("operator", arena.operator());
    }
}
