// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {Arena} from "../src/Arena.sol";

/// @dev 测试专用：允许强行摆位置 / 改 HP / 放食物，便于逐条验证规则
contract ArenaHarness is Arena {
    constructor(uint256 e, uint256 c, uint256 m) Arena(e, c, m) {}

    function forcePos(uint256 id, uint8 x, uint8 y) external {
        creatures[id].x = x;
        creatures[id].y = y;
    }

    function forceHp(uint256 id, uint16 hp) external {
        creatures[id].hp = hp;
    }

    function forceFood(uint256 mask, uint8 count) external {
        foodMask = mask;
        foodCount = count;
    }

    function get(uint256 id) external view returns (Creature memory) {
        return creatures[id];
    }
}

contract ArenaTest is Test {
    struct HitLog {
        uint256 attacker;
        uint256 target;
        uint256 base;
        uint256 matchupBp;
        uint256 rollBp;
        bool crit;
        bool hidden;
        uint256 dmg;
        uint256 hpAfter;
    }

    ArenaHarness arena;

    uint256 constant FEE = 0.01 ether;
    uint256 constant CHEER = 0.001 ether;
    uint256 constant K = 40;
    bytes32[K + 1] chain; // chain[i] = H^i(s)，anchor = chain[K]

    bytes32 constant HIT_SIG =
        keccak256("Hit(uint32,uint32,uint256,uint256,uint256,uint256,uint256,bool,bool,uint256,uint256)");
    bytes32 constant REJECTED_SIG = keccak256("Rejected(uint32,uint32,uint256,uint8,uint8)");
    bytes32 constant TAUNTED_SIG = keccak256("Taunted(uint32,uint32,uint256,uint256,uint256)");
    bytes32 constant ROUND_SIG = keccak256("RoundResolved(uint32,uint32,bytes32,bytes32,bytes32,uint256)");

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        arena = new ArenaHarness(FEE, CHEER, 64);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.deal(carol, 1 ether);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _newGame(bytes32 secret) internal {
        chain[0] = secret;
        for (uint256 i = 1; i <= K; ++i) {
            chain[i] = keccak256(abi.encodePacked(chain[i - 1]));
        }
        arena.newGame(chain[K]);
    }

    /// @dev r = 0 是 start 的揭示值，r ≥ 1 是第 r 回合
    function _reveal(uint256 r) internal view returns (bytes32) {
        return chain[K - 1 - r];
    }

    function _join(address p) internal returns (uint256 id) {
        vm.prank(p);
        id = arena.join{value: FEE}(unicode"一只仓鼠");
    }

    function _spawn1(uint256 id, uint8 cls, uint8 trait) internal {
        uint256[] memory ids = new uint256[](1);
        uint8[] memory cs = new uint8[](1);
        uint8[] memory ts = new uint8[](1);
        ids[0] = id;
        cs[0] = cls;
        ts[0] = trait;
        arena.spawn(ids, cs, ts);
    }

    function _start() internal {
        arena.start(_reveal(0));
    }

    function _round(uint32 r, uint8[] memory t, uint8[] memory a) internal {
        arena.resolveRound(r, t, a, _reveal(r), keccak256(abi.encode("log", r)));
    }

    function _acts(uint256 n) internal pure returns (uint8[] memory t, uint8[] memory a) {
        t = new uint8[](n);
        a = new uint8[](n);
    }

    /// @dev alice 的 A 在 (5,5)，bob 的 B 在 (6,5)，roster 下标 A=0 B=1
    function _duel(uint8 ca, uint8 ta, uint8 cb, uint8 tb) internal returns (uint256 a, uint256 b) {
        _newGame(keccak256("duel"));
        a = _join(alice);
        b = _join(bob);
        _spawn1(a, ca, ta);
        _spawn1(b, cb, tb);
        _start();
        arena.forcePos(a, 5, 5);
        arena.forcePos(b, 6, 5);
    }

    function _hits() internal returns (HitLog[] memory out) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 m;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == HIT_SIG) ++m;
        }
        out = new HitLog[](m);
        m = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != HIT_SIG) continue;
            HitLog memory h;
            (h.attacker, h.target, h.base, h.matchupBp, h.rollBp, h.crit, h.hidden, h.dmg, h.hpAfter) = abi.decode(
                logs[i].data, (uint256, uint256, uint256, uint256, uint256, bool, bool, uint256, uint256)
            );
            out[m++] = h;
        }
    }

    function _count(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256 m) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) ++m;
        }
    }

    function _expectedDmg(HitLog memory h, bool turtle) internal pure returns (uint256 dmg) {
        dmg = (h.base * h.matchupBp * h.rollBp) / 1e8;
        if (h.crit) dmg = (dmg * 3) / 2;
        if (h.hidden) dmg = turtle ? dmg / 4 : dmg / 2;
        if (dmg == 0) dmg = 1;
    }

    function _assertHitConsistent(HitLog memory h, bool turtle) internal pure {
        assertGe(h.rollBp, 8000);
        assertLe(h.rollBp, 12000);
        assertEq(h.dmg, _expectedDmg(h, turtle), "dmg formula");
    }

    // ───────────────────────── 权限 / 入场 ─────────────────────────

    function test_JoinOutsideLobbyReverts() public {
        vm.prank(alice);
        vm.expectRevert(Arena.BadPhase.selector);
        arena.join{value: FEE}("x");
    }

    function test_JoinWrongFeeReverts() public {
        _newGame("g");
        vm.prank(alice);
        vm.expectRevert(Arena.BadFee.selector);
        arena.join{value: FEE - 1}("x");
        vm.prank(alice);
        vm.expectRevert(Arena.BadFee.selector);
        arena.join{value: 0}("x");
    }

    function test_JoinPromptLength() public {
        _newGame("g");
        vm.prank(alice);
        vm.expectRevert(Arena.BadPrompt.selector);
        arena.join{value: FEE}("");
        bytes memory long = new bytes(129);
        vm.prank(alice);
        vm.expectRevert(Arena.BadPrompt.selector);
        arena.join{value: FEE}(string(long));
    }

    function test_JoinEmitsPrompt() public {
        _newGame("g");
        vm.expectEmit(true, true, true, true);
        emit Arena.Joined(1, 1, alice, unicode"一只仓鼠");
        _join(alice);
        assertEq(arena.ownerOf(1), alice);
        assertEq(address(arena).balance, FEE);
    }

    function test_MaxPlayersExcludesHouse() public {
        arena = new ArenaHarness(FEE, CHEER, 16);
        _newGame("g");
        for (uint256 i; i < 4; ++i) {
            arena.spawnHouse(unicode"甲方", 0, 0);
        }
        for (uint256 i; i < 16; ++i) {
            address p = address(uint160(0x1000 + i));
            vm.deal(p, 1 ether);
            _join(p);
        }
        assertEq(arena.playerCount(1), 16);
        vm.expectRevert(Arena.Full.selector);
        _join(alice);
        // 庄家不占玩家名额
        arena.spawnHouse(unicode"房东", 1, 1);
        // 下一局重新计数
        _spawn1(arena.getJoined(1)[4], 0, 0);
        arena.start(_reveal(0));
        assertEq(arena.playerCount(2), 0);
    }

    function test_MaxCreatures() public {
        _newGame("g");
        for (uint256 i; i < 64; ++i) {
            address p = address(uint160(0x1000 + i));
            vm.deal(p, 1 ether);
            _join(p);
        }
        vm.expectRevert(Arena.Full.selector);
        _join(alice);
        vm.expectRevert(Arena.Full.selector);
        arena.spawnHouse(unicode"甲方", 0, 0);
    }

    function test_OnlyOperator() public {
        _newGame("g");
        uint256 id = _join(alice);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint8[] memory z = new uint8[](1);

        vm.startPrank(alice);
        vm.expectRevert(Arena.NotOperator.selector);
        arena.newGame(bytes32(0));
        vm.expectRevert(Arena.NotOperator.selector);
        arena.spawn(ids, z, z);
        vm.expectRevert(Arena.NotOperator.selector);
        arena.spawnHouse("x", 0, 0);
        vm.expectRevert(Arena.NotOperator.selector);
        arena.start(_reveal(0));
        vm.expectRevert(Arena.NotOperator.selector);
        arena.resolveRound(1, z, z, _reveal(1), 0);
        vm.expectRevert(Arena.NotOperator.selector);
        arena.finish();
        vm.stopPrank();
    }

    function test_SpawnRejectsBadEnums() public {
        _newGame("g");
        uint256 id = _join(alice);
        vm.expectRevert(Arena.BadEnum.selector);
        _spawn1(id, 3, 0);
        vm.expectRevert(Arena.BadEnum.selector);
        _spawn1(id, 0, 7);
        vm.expectRevert(Arena.BadEnum.selector);
        arena.spawnHouse("x", 0, 255);
    }

    function test_SpawnTwiceOrForeignReverts() public {
        _newGame("g");
        uint256 id = _join(alice);
        _spawn1(id, 0, 0);
        vm.expectRevert(Arena.BadCreature.selector);
        _spawn1(id, 1, 1);
        vm.expectRevert(Arena.BadCreature.selector);
        _spawn1(999, 1, 1);
    }

    function test_SpawnStatsFromConstants() public {
        _newGame("g");
        uint256 a = _join(alice);
        uint256 b = _join(bob);
        _spawn1(a, arena.GUARD(), arena.BLOODTHIRST());
        _spawn1(b, arena.AGILE(), arena.TURTLE());
        assertEq(arena.get(a).hp, 110); // 120 − 10
        assertEq(arena.get(a).maxHp, 110);
        assertEq(arena.get(b).hp, 80);
        (,, uint256 spd) = arena.effectiveStats(b);
        assertEq(spd, 6); // 7 − 1
    }

    // ───────────────────────── 随机数 / 开局 ─────────────────────────

    function test_StartWrongRevealReverts() public {
        _newGame("g");
        _spawn1(_join(alice), 0, 0);
        _spawn1(_join(bob), 1, 0);
        vm.expectRevert(Arena.BadReveal.selector);
        arena.start(_reveal(1)); // 跳过了一个
        vm.expectRevert(Arena.BadReveal.selector);
        arena.start(chain[K]); // anchor 本身
    }

    function test_StartNeedsTwo() public {
        _newGame("g");
        _spawn1(_join(alice), 0, 0);
        vm.expectRevert(Arena.NotEnoughPlayers.selector);
        _start();
    }

    function test_StartPlacesAllOnDistinctTiles() public {
        _newGame("g");
        uint256 n = 64;
        for (uint256 i; i < n; ++i) {
            address p = address(uint160(0x1000 + i));
            vm.deal(p, 1 ether);
            _spawn1(_join(p), uint8(i % 3), uint8(i % 7));
        }
        _start();
        (uint256[] memory ids, Arena.Creature[] memory cs,,,) = arena.getRoster(1);
        assertEq(ids.length, n);
        bool[144] memory seen;
        for (uint256 i; i < n; ++i) {
            assertTrue(cs[i].alive);
            assertLt(cs[i].x, 12);
            assertLt(cs[i].y, 12);
            uint256 t = uint256(cs[i].y) * 12 + cs[i].x;
            assertFalse(seen[t], "tile collision");
            seen[t] = true;
        }
        assertEq(uint8(arena.phase()), uint8(Arena.Phase.Running));
        assertGt(arena.foodCount(), 0);
    }

    function test_UnspawnedRefundedOnStart() public {
        _newGame("g");
        _spawn1(_join(alice), 0, 0);
        _spawn1(_join(bob), 1, 0);
        _join(carol); // 没被 spawn（比如 classify 太慢）
        uint256 before = carol.balance;
        _start();
        assertEq(carol.balance, before + FEE);
        assertEq(address(arena).balance, 2 * FEE);
        (uint256[] memory ids,,,,) = arena.getRoster(1);
        assertEq(ids.length, 2);
    }

    function test_ResolveRoundGuards() public {
        _duel(0, 0, 1, 0);
        (uint8[] memory t, uint8[] memory g) = _acts(2);

        vm.expectRevert(Arena.BadRound.selector);
        arena.resolveRound(2, t, g, _reveal(2), 0);

        vm.expectRevert(Arena.BadReveal.selector);
        arena.resolveRound(1, t, g, _reveal(2), 0);

        (uint8[] memory t3, uint8[] memory g3) = _acts(3);
        vm.expectRevert(Arena.BadLength.selector);
        arena.resolveRound(1, t3, g3, _reveal(1), 0);

        _round(1, t, g);
        // 揭示值不能重放
        vm.expectRevert(Arena.BadReveal.selector);
        arena.resolveRound(2, t, g, _reveal(1), 0);
        assertEq(arena.currentRound(), 1);
        assertEq(arena.lastReveal(), _reveal(1));
    }

    function test_SeedIsVerifiable() public {
        _duel(0, 0, 1, 0);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        vm.prevrandao(bytes32(uint256(0xabc)));
        vm.roll(block.number + 5);
        bytes32 expected =
            keccak256(abi.encode(_reveal(1), block.prevrandao, blockhash(block.number - 1), uint32(1), uint32(1)));
        vm.recordLogs();
        _round(1, t, g);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != ROUND_SIG) continue;
            (bytes32 reveal, bytes32 seed, bytes32 logHash,) = abi.decode(logs[i].data, (bytes32, bytes32, bytes32, uint256));
            assertEq(reveal, _reveal(1));
            assertEq(seed, expected);
            assertEq(logHash, keccak256(abi.encode("log", uint32(1))));
            found = true;
        }
        assertTrue(found);
    }

    // ───────────────────────── 伤害公式 ─────────────────────────

    function test_DamageCounter() public {
        // 猛攻(ATK8) → 敏捷(DEF3)：基础 29 × 1.5
        (uint256 a, uint256 b) = _duel(arena.ASSAULT(), arena.TURTLE(), arena.AGILE(), arena.TURTLE());
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        vm.recordLogs();
        _round(1, t, g);
        HitLog[] memory hs = _hits();
        assertEq(hs.length, 1);
        assertEq(hs[0].attacker, a);
        assertEq(hs[0].target, b);
        assertEq(hs[0].base, 29);
        assertEq(hs[0].matchupBp, 15000);
        assertFalse(hs[0].hidden);
        _assertHitConsistent(hs[0], false);
        assertEq(arena.get(b).hp, 80 - hs[0].dmg);
        assertEq(hs[0].hpAfter, arena.get(b).hp);
    }

    function test_DamageCountered() public {
        // 猛攻(ATK8) → 坚守(DEF6)：基础 26 × 0.7
        (, uint256 b) = _duel(arena.ASSAULT(), arena.TURTLE(), arena.GUARD(), arena.TURTLE());
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        vm.recordLogs();
        _round(1, t, g);
        HitLog[] memory hs = _hits();
        assertEq(hs[0].base, 26);
        assertEq(hs[0].matchupBp, 7000);
        _assertHitConsistent(hs[0], false);
        assertEq(arena.get(b).hp, 120 - hs[0].dmg);
    }

    function test_DamageNeutralAndDiagonal() public {
        // 同职业，斜向相邻也算相邻
        (, uint256 b) = _duel(arena.GUARD(), arena.TURTLE(), arena.GUARD(), arena.TURTLE());
        arena.forcePos(b, 6, 6);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        vm.recordLogs();
        _round(1, t, g);
        HitLog[] memory hs = _hits();
        assertEq(hs.length, 1);
        assertEq(hs[0].base, 10); // 16 − 6
        assertEq(hs[0].matchupBp, 10000);
        _assertHitConsistent(hs[0], false);
    }

    function test_HideHalves() public {
        (, uint256 b) = _duel(arena.ASSAULT(), arena.TURTLE(), arena.AGILE(), arena.SOCIAL());
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        t[1] = arena.ACT_HIDE(); // 敏捷先动也没关系：HIDE 整回合生效
        vm.recordLogs();
        _round(1, t, g);
        HitLog[] memory hs = _hits();
        assertTrue(hs[0].hidden);
        assertEq(hs[0].base, 30); // 32 − (3−1)
        _assertHitConsistent(hs[0], false);
        assertEq(arena.get(b).hp, 80 - hs[0].dmg);
    }

    function test_TurtleHideQuarter() public {
        (, uint256 b) = _duel(arena.ASSAULT(), arena.TURTLE(), arena.AGILE(), arena.TURTLE());
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        t[1] = arena.ACT_HIDE();
        vm.recordLogs();
        _round(1, t, g);
        HitLog[] memory hs = _hits();
        assertTrue(hs[0].hidden);
        _assertHitConsistent(hs[0], true);
        assertLe(hs[0].dmg, 19); // 29 × 1.5 × 1.2 × 1.5 ÷ 4
        assertEq(arena.get(b).hp, 80 - hs[0].dmg);
    }

    function test_BerserkBonusBelow40() public {
        (uint256 a,) = _duel(arena.ASSAULT(), arena.BERSERK(), arena.ASSAULT(), arena.TURTLE());
        arena.forceHp(a, 39);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        vm.recordLogs();
        _round(1, t, g);
        HitLog[] memory hs = _hits();
        assertEq(hs[0].base, 42); // (8+3)×4 − 2
    }

    function test_CritDistribution() public {
        // 多回合打木桩，检查暴击和骰子落在规则范围内
        (, uint256 b) = _duel(arena.GUARD(), arena.TURTLE(), arena.GUARD(), arena.TURTLE());
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        vm.recordLogs();
        for (uint32 r = 1; r <= 4; ++r) {
            arena.forceHp(b, 120);
            _round(r, t, g);
        }
        HitLog[] memory hs = _hits();
        assertEq(hs.length, 4);
        for (uint256 i; i < hs.length; ++i) {
            _assertHitConsistent(hs[i], false);
        }
    }

    // ───────────────────────── 合法性检查 ─────────────────────────

    function test_InvalidAttackIsStay() public {
        (uint256 a, uint256 b) = _duel(0, arena.TURTLE(), 2, arena.TURTLE());
        arena.forcePos(b, 9, 9);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1; // 不相邻
        t[1] = arena.ACT_ATTACK();
        g[1] = 1; // 打自己
        vm.recordLogs();
        _round(1, t, g);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, HIT_SIG), 0);
        assertEq(_count(logs, REJECTED_SIG), 2);
        assertEq(arena.get(a).hp, 90);
        assertEq(arena.get(b).hp, 80);

        // 越界目标、未知行动类型
        t[0] = arena.ACT_ATTACK();
        g[0] = 200;
        t[1] = 9;
        vm.recordLogs();
        _round(2, t, g);
        logs = vm.getRecordedLogs();
        assertEq(_count(logs, REJECTED_SIG), 2);
        assertEq(arena.get(a).x, 5);
        assertEq(arena.get(b).x, 9);
    }

    function test_MoveRules() public {
        (uint256 a, uint256 b) = _duel(arena.ASSAULT(), 0, arena.AGILE(), 0);
        arena.forcePos(a, 0, 0);
        arena.forcePos(b, 5, 5);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_MOVE();
        g[0] = 0; // 北：越界
        t[1] = arena.ACT_MOVE();
        g[1] = 1; // 东：敏捷走 2 格
        vm.recordLogs();
        _round(1, t, g);
        assertEq(_count(vm.getRecordedLogs(), REJECTED_SIG), 1);
        assertEq(arena.get(a).x, 0);
        assertEq(arena.get(a).y, 0);
        assertEq(arena.get(b).x, 7);
        assertEq(arena.get(b).y, 5);

        // 被占用的格子走不进去；敏捷第一步可走、第二步被挡时停在中间
        arena.forcePos(a, 6, 5);
        arena.forcePos(b, 4, 5);
        g[0] = 1; // a 东 → (7,5)
        g[1] = 1; // b 敏捷先动：第一步到 (5,5)，第二步被 a 挡住
        _round(2, t, g);
        assertEq(arena.get(b).x, 5);
        assertEq(arena.get(a).x, 7);
    }

    function test_SpeedOrder() public {
        // 敏捷 SPD7 先手，一刀带走只剩 1 HP 的猛攻；猛攻的攻击不再发生
        (uint256 a, uint256 b) = _duel(arena.ASSAULT(), arena.TURTLE(), arena.AGILE(), arena.TURTLE());
        arena.forceHp(a, 1);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        t[1] = arena.ACT_ATTACK();
        g[1] = 0;
        vm.recordLogs();
        _round(1, t, g);
        HitLog[] memory hs = _hits();
        assertEq(hs.length, 1);
        assertEq(hs[0].attacker, b);
        assertFalse(arena.get(a).alive);
        assertEq(arena.get(b).hp, 80);
        assertEq(arena.get(b).kills, 1);
        assertTrue(arena.over());
    }

    // ───────────────────────── 特性 ─────────────────────────

    function test_BoastTaunt() public {
        _newGame("taunt");
        uint256 a = _join(alice);
        uint256 b = _join(bob);
        uint256 c = _join(carol);
        _spawn1(a, arena.ASSAULT(), arena.TURTLE());
        _spawn1(b, arena.GUARD(), arena.TURTLE());
        _spawn1(c, arena.GUARD(), arena.BOAST());
        _start();
        arena.forcePos(a, 5, 5);
        arena.forcePos(b, 6, 5);
        arena.forcePos(c, 4, 4);
        (uint8[] memory t, uint8[] memory g) = _acts(3);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1; // 想打 b，但旁边有"自大"的 c
        vm.recordLogs();
        _round(1, t, g);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, TAUNTED_SIG), 1);
        uint256 hp;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != HIT_SIG) continue;
            (uint256 att, uint256 tgt,,,,,,, uint256 after_) = abi.decode(
                logs[i].data, (uint256, uint256, uint256, uint256, uint256, bool, bool, uint256, uint256)
            );
            assertEq(att, a);
            assertEq(tgt, c);
            hp = after_;
        }
        assertEq(arena.get(b).hp, 120);
        assertEq(arena.get(c).hp, hp);

        // 自大 ATK +2
        (uint256 atk,,) = arena.effectiveStats(c);
        assertEq(atk, 6);
    }

    function test_VenomPoisons() public {
        (, uint256 b) = _duel(arena.GUARD(), arena.VENOM(), arena.GUARD(), arena.TURTLE());
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        vm.recordLogs();
        _round(1, t, g);
        HitLog[] memory hs = _hits();
        assertEq(hs[0].base, 2); // (4−2)×4 − 6
        // 当回合末就跳一次毒
        assertEq(arena.get(b).poison, 2);
        assertEq(arena.get(b).hp, hs[0].hpAfter - 5);

        (t, g) = _acts(2);
        _round(2, t, g);
        _round(3, t, g);
        assertEq(arena.get(b).poison, 0);
        assertEq(arena.get(b).hp, hs[0].hpAfter - 15);
        _round(4, t, g);
        assertEq(arena.get(b).hp, hs[0].hpAfter - 15);
    }

    function test_BloodthirstHealsOnKill() public {
        (uint256 a, uint256 b) = _duel(arena.ASSAULT(), arena.BLOODTHIRST(), arena.AGILE(), arena.TURTLE());
        arena.forceHp(a, 20);
        arena.forceHp(b, 1);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        _round(1, t, g);
        assertFalse(arena.get(b).alive);
        assertEq(arena.get(a).hp, 50);
    }

    function test_EatFood() public {
        (uint256 a, uint256 b) = _duel(arena.ASSAULT(), arena.HOARDER(), arena.AGILE(), arena.TURTLE());
        arena.forcePos(b, 9, 9);
        arena.forceFood((1 << (5 * 12 + 5)) | (1 << (9 * 12 + 9)), 2);
        arena.forceHp(a, 40);
        arena.forceHp(b, 70);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_EAT();
        t[1] = arena.ACT_EAT();
        _round(1, t, g);
        assertEq(arena.get(a).hp, 75); // 囤粮 +35
        assertEq(arena.get(b).hp, 80); // +20 但封顶 80
        assertEq(arena.foodMask() & (1 << (5 * 12 + 5)), 0);
        assertEq(arena.foodMask() & (1 << (9 * 12 + 9)), 0);
    }

    function test_EatWithoutFoodRejected() public {
        (uint256 a,) = _duel(arena.ASSAULT(), arena.HOARDER(), arena.AGILE(), arena.TURTLE());
        arena.forceFood(0, 0);
        arena.forceHp(a, 40);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_EAT();
        vm.recordLogs();
        _round(1, t, g);
        assertEq(_count(vm.getRecordedLogs(), REJECTED_SIG), 1);
        assertEq(arena.get(a).hp, 40);
    }

    // ───────────────────────── 打气 / 姿态 ─────────────────────────

    function test_CheerHealsWithCap() public {
        (uint256 a, uint256 b) = _duel(arena.ASSAULT(), arena.TURTLE(), arena.AGILE(), arena.SOCIAL());
        arena.forceHp(a, 10);
        arena.forceHp(b, 10);
        vm.startPrank(carol);
        for (uint256 i; i < 5; ++i) {
            arena.cheer{value: CHEER}(a); // 5 次，封顶 3 次 = +15
        }
        arena.cheer{value: CHEER}(b); // 社牛 ×2 = +10
        vm.stopPrank();
        assertEq(arena.cheers(a), 5);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        _round(1, t, g);
        assertEq(arena.get(a).hp, 25);
        assertEq(arena.get(b).hp, 20);
        // 多出来的打气不会留到下一回合
        _round(2, t, g);
        assertEq(arena.get(a).hp, 25);
        assertEq(address(arena).balance, 2 * FEE + 6 * CHEER);
    }

    function test_CheerGuards() public {
        (uint256 a, uint256 b) = _duel(0, 0, 1, 0);
        vm.prank(carol);
        vm.expectRevert(Arena.BadFee.selector);
        arena.cheer{value: 0}(a);
        vm.prank(carol);
        vm.expectRevert(Arena.BadCreature.selector);
        arena.cheer{value: CHEER}(999);
        arena.forceHp(b, 1);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        _round(1, t, g);
        assertFalse(arena.get(b).alive);
        vm.prank(carol);
        vm.expectRevert(Arena.BadCreature.selector);
        arena.cheer{value: CHEER}(b);
    }

    function test_SetStanceOnlyOwner() public {
        (uint256 a,) = _duel(0, 0, 1, 0);
        vm.prank(bob);
        vm.expectRevert(Arena.NotOwner.selector);
        arena.setStance(a, 1);
        vm.prank(alice);
        vm.expectRevert(Arena.BadEnum.selector);
        arena.setStance(a, 3);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit Arena.StanceSet(1, a, 2);
        arena.setStance(a, 2);
        assertEq(arena.stanceOf(a), 2);
    }

    // ───────────────────────── 结束 / 奖池 ─────────────────────────

    function test_PayoutToWinner() public {
        (uint256 a, uint256 b) = _duel(arena.ASSAULT(), 0, arena.AGILE(), 0);
        vm.prank(carol);
        arena.cheer{value: CHEER}(b);

        vm.expectRevert(Arena.NotOver.selector);
        arena.finish();

        arena.forceHp(b, 1);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        _round(1, t, g);
        assertTrue(arena.over());

        vm.expectRevert(Arena.BadPhase.selector);
        _round(2, t, g);

        uint256 before = alice.balance;
        vm.expectEmit(true, false, false, true);
        emit Arena.Finished(1, a, alice, 2 * FEE + CHEER);
        arena.finish();
        assertEq(alice.balance, before + 2 * FEE + CHEER);
        assertEq(address(arena).balance, 0);
        assertEq(uint8(arena.phase()), uint8(Arena.Phase.Ended));

        vm.expectRevert(Arena.BadPhase.selector);
        arena.finish();
    }

    function test_HouseWinnerCarriesOver() public {
        _newGame("house");
        uint256 h = arena.spawnHouse(unicode"甲方", arena.ASSAULT(), arena.TURTLE());
        uint256 b = _join(bob);
        _spawn1(b, arena.AGILE(), arena.TURTLE());
        _start();
        arena.forcePos(h, 5, 5);
        arena.forcePos(b, 6, 5);
        arena.forceHp(b, 1);
        assertEq(arena.ownerOf(h), address(0));
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        t[0] = arena.ACT_ATTACK();
        g[0] = 1;
        _round(1, t, g);
        uint256 bobBefore = bob.balance;
        arena.finish();
        assertEq(address(arena).balance, FEE); // 顺延
        assertEq(bob.balance, bobBefore);

        // 下一局冠军拿走顺延的奖池
        (uint256 a,) = _duel(arena.ASSAULT(), 0, arena.AGILE(), 0);
        assertEq(arena.gameId(), 2);
        uint256 b2 = a + 1;
        arena.forceHp(b2, 1);
        _round(1, t, g);
        uint256 before = alice.balance;
        arena.finish();
        assertEq(alice.balance, before + 3 * FEE);
    }

    function test_MaxRoundsHighestHpWins() public {
        (uint256 a, uint256 b) = _duel(arena.ASSAULT(), 0, arena.AGILE(), 0);
        arena.forcePos(a, 5, 5);
        arena.forcePos(b, 6, 6); // 安全区最后缩到 [5,6]²
        arena.forceHp(a, 50);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        for (uint32 r = 1; r <= 20; ++r) {
            assertFalse(arena.over());
            _round(r, t, g);
        }
        assertTrue(arena.over());
        vm.expectRevert(Arena.BadPhase.selector);
        arena.resolveRound(21, t, g, _reveal(21), 0);
        uint256 before = bob.balance;
        arena.finish();
        assertEq(bob.balance, before + 2 * FEE);
    }

    function test_ZoneDamage() public {
        (uint256 a, uint256 b) = _duel(arena.GUARD(), 0, arena.GUARD(), 0);
        arena.forcePos(a, 0, 0);
        arena.forcePos(b, 5, 5);
        (uint8[] memory t, uint8[] memory g) = _acts(2);
        for (uint32 r = 1; r <= 4; ++r) {
            _round(r, t, g);
        }
        assertEq(arena.get(a).hp, 120);
        _round(5, t, g);
        assertEq(arena.get(a).hp, 105);
        assertEq(arena.get(b).hp, 120);
        assertEq(arena.zoneRing(5), 1);
        assertEq(arena.zoneRing(8), 2);
        assertEq(arena.zoneRing(20), 5);
    }

    function test_AllDeadLastToFallWins() public {
        // c 第 1 回合被 a 击杀；a、b 第 5 回合同时被毒圈带走 → 同回合比击杀，a 获胜
        _newGame("alldead");
        uint256 a = _join(alice);
        uint256 b = _join(bob);
        uint256 c = _join(carol);
        _spawn1(a, arena.GUARD(), 0);
        _spawn1(b, arena.GUARD(), 0);
        _spawn1(c, arena.GUARD(), 0);
        _start();
        arena.forcePos(a, 0, 0);
        arena.forcePos(c, 1, 0);
        arena.forcePos(b, 11, 11);
        arena.forceHp(c, 1);
        (uint8[] memory t, uint8[] memory g) = _acts(3);
        t[0] = arena.ACT_ATTACK();
        g[0] = 2;
        _round(1, t, g);
        assertEq(arena.get(c).diedRound, 1);
        (t, g) = _acts(3);
        for (uint32 r = 2; r <= 4; ++r) {
            _round(r, t, g);
        }
        arena.forceHp(a, 1);
        arena.forceHp(b, 1);
        _round(5, t, g);
        assertTrue(arena.over());
        assertEq(arena.get(a).diedRound, 5);
        uint256 before = alice.balance;
        vm.expectEmit(true, false, false, true);
        emit Arena.Finished(1, a, alice, 3 * FEE);
        arena.finish();
        assertEq(alice.balance, before + 3 * FEE);
    }

    // ───────────────────────── 整局 / Gas ─────────────────────────

    /// @dev 简单脚本 AI：相邻有敌人就打，否则走向最近的敌人
    function _scriptedActions(uint256 g) internal view returns (uint8[] memory t, uint8[] memory a) {
        (, Arena.Creature[] memory cs,,,) = arena.getRoster(uint32(g));
        uint256 n = cs.length;
        (t, a) = _acts(n);
        for (uint256 i; i < n; ++i) {
            if (!cs[i].alive) continue;
            uint256 best = type(uint256).max;
            uint256 bestD = type(uint256).max;
            for (uint256 j; j < n; ++j) {
                if (j == i || !cs[j].alive) continue;
                uint256 dx = cs[i].x > cs[j].x ? cs[i].x - cs[j].x : cs[j].x - cs[i].x;
                uint256 dy = cs[i].y > cs[j].y ? cs[i].y - cs[j].y : cs[j].y - cs[i].y;
                uint256 d = dx > dy ? dx : dy;
                if (d < bestD) {
                    bestD = d;
                    best = j;
                }
            }
            if (best == type(uint256).max) continue;
            if (bestD == 1) {
                t[i] = 2;
                a[i] = uint8(best);
            } else {
                t[i] = 1;
                uint256 dx = cs[i].x > cs[best].x ? cs[i].x - cs[best].x : cs[best].x - cs[i].x;
                uint256 dy = cs[i].y > cs[best].y ? cs[i].y - cs[best].y : cs[best].y - cs[i].y;
                if (dx >= dy) a[i] = cs[best].x > cs[i].x ? 1 : 3;
                else a[i] = cs[best].y > cs[i].y ? 2 : 0;
            }
        }
    }

    function _fillLobby(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            address p = address(uint160(0x1000 + i));
            vm.deal(p, 1 ether);
            _spawn1(_join(p), uint8(i % 3), uint8((i * 5) % 7));
        }
    }

    function test_FullGameScripted() public {
        _newGame("full");
        _fillLobby(12);
        _start();
        uint32 r;
        while (!arena.over()) {
            ++r;
            (uint8[] memory t, uint8[] memory g) = _scriptedActions(1);
            _round(r, t, g);
        }
        assertLe(r, 20);
        uint256 pot = address(arena).balance;
        assertEq(pot, 12 * FEE);
        vm.recordLogs();
        arena.finish();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 winnerId, address winner, uint256 prize) =
            abi.decode(logs[logs.length - 1].data, (uint256, address, uint256));
        console2.log("rounds", r, "winner", winnerId);
        if (winnerId != 0) {
            assertEq(prize, pot);
            assertEq(winner, arena.ownerOf(winnerId));
            assertEq(address(arena).balance, 0);
        }
    }

    function test_Gas64Creatures() public {
        _newGame("gas");
        _fillLobby(64);
        uint256 g0 = gasleft();
        _start();
        console2.log("start gas (64)", g0 - gasleft());

        uint256 maxGas;
        for (uint32 r = 1; r <= 6 && !arena.over(); ++r) {
            (uint8[] memory t, uint8[] memory a) = _scriptedActions(1);
            uint256 g1 = gasleft();
            _round(r, t, a);
            uint256 used = g1 - gasleft();
            if (used > maxGas) maxGas = used;
        }
        console2.log("max resolveRound gas (64)", maxGas);
        assertLt(maxGas, 15_000_000);
    }
}
