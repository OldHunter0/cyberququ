// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title 赛博斗蛐蛐 · Prompt Arena
/// @notice 战斗规则、可验证随机数、奖池全部在链上执行。
///         运营方只能提交"行动"（选招），所有数值都是合约常量；不合法的行动视为原地不动。
/// @dev 并行友好：玩家交易只写自己那只生物的独立槽位（cheers[id] / stanceOf[id]），
///      奖池就是合约余额，不维护共享的 pot 变量。
contract Arena {
    // ───────────────────────── 枚举 ─────────────────────────
    // 职业（克制环：猛攻 > 敏捷 > 坚守 > 猛攻）
    uint8 public constant ASSAULT = 0; // 🔥 猛攻
    uint8 public constant GUARD = 1; // 🛡 坚守
    uint8 public constant AGILE = 2; // 💨 敏捷
    uint8 public constant NUM_CLASSES = 3;

    // 特性
    uint8 public constant HOARDER = 0; // 囤粮：EAT +35（常规 20），ATK -1
    uint8 public constant BERSERK = 1; // 狂暴：HP < 40 时 ATK +3，DEF -1
    uint8 public constant TURTLE = 2; // 龟缩：HIDE 减伤 75%（常规 50%），SPD -1
    uint8 public constant BLOODTHIRST = 3; // 嗜血：击杀回 30，初始 HP -10
    uint8 public constant VENOM = 4; // 毒刺：命中后中毒 3 回合 ×5，ATK -2
    uint8 public constant SOCIAL = 5; // 社牛：打气 ×2，DEF -1
    uint8 public constant BOAST = 6; // 自大（吹牛税）：ATK +2，嘲讽
    uint8 public constant NUM_TRAITS = 7;

    // 行动
    uint8 public constant ACT_STAY = 0;
    uint8 public constant ACT_MOVE = 1; // arg = 方向 0北(y-1) 1东(x+1) 2南(y+1) 3西(x-1)
    uint8 public constant ACT_ATTACK = 2; // arg = 目标在 roster 中的下标
    uint8 public constant ACT_EAT = 3;
    uint8 public constant ACT_HIDE = 4;

    // 姿态（只给 LLM 看，合约不据此改规则）：0 进攻 1 苟住 2 觅食
    uint8 public constant NUM_STANCES = 3;

    // 死因
    uint8 public constant CAUSE_ATTACK = 1;
    uint8 public constant CAUSE_POISON = 2;
    uint8 public constant CAUSE_ZONE = 3;

    // ───────────────────────── 规则常量 ─────────────────────────
    uint8 public constant MAP_SIZE = 12;
    uint256 public constant TILES = 144;
    uint256 public constant MAX_CREATURES = 64; // 每局生物总数硬上限（含庄家），限制每回合 gas
    uint32 public constant MAX_ROUNDS = 20;
    uint32 public constant ZONE_START = 5;
    uint32 public constant ZONE_EVERY = 3;
    uint256 public constant ZONE_MAX_RING = 5;
    uint256 public constant ZONE_DMG = 15;
    uint256 public constant POISON_DMG = 5;
    uint8 public constant POISON_ROUNDS = 3;
    uint256 public constant FOOD_PER_ROUND = 3;
    uint256 public constant MAX_FOOD = 8;
    uint256 public constant EAT_HP = 20;
    uint256 public constant HOARDER_EAT_HP = 35;
    uint256 public constant BLOODTHIRST_HP = 30;
    uint256 public constant CHEER_HP = 5;
    uint256 public constant MAX_CHEERS_PER_ROUND = 3;
    uint256 public constant BERSERK_THRESHOLD = 40;
    uint256 public constant CRIT_PCT = 10;
    uint256 public constant MAX_PROMPT_BYTES = 128;

    uint256 constant BP = 10_000;
    uint256 constant COUNTER_BP = 15_000;
    uint256 constant COUNTERED_BP = 7_000;

    // ───────────────────────── 状态 ─────────────────────────
    enum Phase {
        Idle,
        Lobby,
        Running,
        Ended
    }

    /// @dev 正好一个存储槽（24 字节）
    struct Creature {
        uint32 gameId;
        uint16 hp;
        uint16 maxHp;
        uint8 x;
        uint8 y;
        uint8 cls;
        uint8 trait;
        uint8 kills;
        uint8 poison;
        bool spawned;
        bool alive;
        uint32 lastCheers;
        uint32 diedRound; // 全灭时"最后倒下的"获胜
    }

    address public immutable operator;
    uint256 public immutable entryFee;
    uint256 public immutable cheerFee;
    uint256 public immutable maxPlayers; // 每局真人玩家上限（不含庄家）

    Phase public phase;
    uint32 public gameId;
    uint32 public currentRound;
    bool public over;
    uint8 public foodCount;
    bytes32 public lastReveal;
    uint256 public foodMask; // bit (y*12+x) = 该格有食物
    uint256 public nextId = 1;

    mapping(uint256 => Creature) public creatures;
    mapping(uint256 => address) public ownerOf; // address(0) = 庄家生物
    mapping(uint256 => uint256) public cheers; // 只累加
    mapping(uint256 => uint8) public stanceOf;
    mapping(uint32 => uint256[]) internal joinedOf;
    mapping(uint32 => uint256[]) internal rosterOf; // start 时确定，resolveRound 的 actions 按此下标
    mapping(uint32 => uint256) public playerCount;

    // ───────────────────────── 事件 ─────────────────────────
    event GameCreated(uint32 indexed gameId, bytes32 anchor);
    event Joined(uint32 indexed gameId, uint256 indexed id, address indexed owner, string prompt);
    event Spawned(uint32 indexed gameId, uint256 indexed id, uint8 cls, uint8 trait, uint16 hp);
    event Started(uint32 indexed gameId, bytes32 reveal, bytes32 seed, uint256 count);
    event Refunded(uint32 indexed gameId, uint256 indexed id, address to, bool ok);
    event Cheered(uint32 indexed gameId, uint256 indexed id, address indexed from, uint256 total);
    event StanceSet(uint32 indexed gameId, uint256 indexed id, uint8 stance);
    event Rejected(uint32 indexed gameId, uint32 indexed round, uint256 indexed id, uint8 actionType, uint8 arg);
    event Taunted(uint32 indexed gameId, uint32 indexed round, uint256 indexed attacker, uint256 intended, uint256 taunter);
    event Hit(
        uint32 indexed gameId,
        uint32 indexed round,
        uint256 attacker,
        uint256 target,
        uint256 base,
        uint256 matchupBp,
        uint256 rollBp,
        bool crit,
        bool hidden,
        uint256 dmg,
        uint256 hpAfter
    );
    event Ate(uint32 indexed gameId, uint32 indexed round, uint256 indexed id, uint256 heal);
    event Damaged(uint32 indexed gameId, uint32 indexed round, uint256 indexed id, uint256 poisonDmg, uint256 zoneDmg);
    event CheerHealed(uint32 indexed gameId, uint32 indexed round, uint256 indexed id, uint256 heal);
    event Died(uint32 indexed gameId, uint32 indexed round, uint256 indexed id, uint256 killer, uint8 cause);
    event RoundResolved(
        uint32 indexed gameId, uint32 indexed round, bytes32 reveal, bytes32 seed, bytes32 llmLogHash, uint256 alive
    );
    event Finished(uint32 indexed gameId, uint256 winnerId, address winner, uint256 prize);

    // ───────────────────────── 错误 ─────────────────────────
    error NotOperator();
    error NotOwner();
    error BadPhase();
    error BadFee();
    error BadPrompt();
    error Full();
    error BadEnum();
    error BadCreature();
    error BadReveal();
    error BadRound();
    error BadLength();
    error NotEnoughPlayers();
    error NotOver();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @dev 一回合结算用的内存上下文
    struct Ctx {
        uint32 g;
        uint32 round;
        bytes32 seed;
        uint256 nonce;
        uint256 food;
        uint256 foodCount;
    }

    constructor(uint256 entryFee_, uint256 cheerFee_, uint256 maxPlayers_) {
        operator = msg.sender;
        entryFee = entryFee_;
        cheerFee = cheerFee_;
        maxPlayers = maxPlayers_;
    }

    // ═════════════════════════ 运营方 ═════════════════════════

    /// @param anchor = H^K(s)，哈希链末端；之后每次揭示 x 必须满足 keccak256(x) == lastReveal
    function newGame(bytes32 anchor) external onlyOperator {
        if (phase != Phase.Idle && phase != Phase.Ended) revert BadPhase();
        uint32 g = gameId + 1;
        gameId = g;
        phase = Phase.Lobby;
        currentRound = 0;
        over = false;
        foodMask = 0;
        foodCount = 0;
        lastReveal = anchor;
        emit GameCreated(g, anchor);
    }

    /// @notice 运营方把 LLM 的分类结果上链：只接受枚举值，数值由合约决定
    function spawn(uint256[] calldata ids, uint8[] calldata classes, uint8[] calldata traits) external onlyOperator {
        if (phase != Phase.Lobby) revert BadPhase();
        if (ids.length != classes.length || ids.length != traits.length) revert BadLength();
        uint32 g = gameId;
        for (uint256 i; i < ids.length; ++i) {
            Creature storage c = creatures[ids[i]];
            if (c.gameId != g || c.spawned) revert BadCreature();
            _initCreature(c, ids[i], classes[i], traits[i]);
        }
    }

    /// @notice 庄家生物（主人为 address(0)，赢了奖池顺延）
    function spawnHouse(string calldata name, uint8 cls, uint8 trait) external onlyOperator returns (uint256 id) {
        if (phase != Phase.Lobby) revert BadPhase();
        id = _newCreature(address(0), name);
        _initCreature(creatures[id], id, cls, trait);
    }

    /// @notice 揭示第 0 个值，决定出生点；未被 spawn 的玩家退回入场费
    function start(bytes32 x0) external onlyOperator {
        if (phase != Phase.Lobby) revert BadPhase();
        _consumeReveal(x0);
        uint32 g = gameId;

        uint256[] storage joined = joinedOf[g];
        uint256[] storage roster = rosterOf[g];
        uint256 m = joined.length;
        for (uint256 i; i < m; ++i) {
            if (creatures[joined[i]].spawned) roster.push(joined[i]);
        }
        uint256 n = roster.length;
        if (n < 2) revert NotEnoughPlayers();

        Ctx memory ctx = Ctx(g, 0, _seed(x0, 0), 0, 0, 0);
        uint8[144] memory occ;
        for (uint256 i; i < n; ++i) {
            Creature storage c = creatures[roster[i]];
            uint256 t = _randomEmptyTile(ctx, occ);
            occ[t] = uint8(i + 1);
            c.x = uint8(t % MAP_SIZE);
            c.y = uint8(t / MAP_SIZE);
            c.alive = true;
        }
        _spawnFood(ctx);
        foodMask = ctx.food;
        foodCount = uint8(ctx.foodCount);
        phase = Phase.Running;
        emit Started(g, x0, ctx.seed, n);

        // 退款放最后（状态已切到 Running），限 gas 防止恶意接收方卡住开局
        for (uint256 i; i < m; ++i) {
            uint256 id = joined[i];
            if (creatures[id].spawned) continue;
            address to = ownerOf[id];
            (bool ok,) = payable(to).call{value: entryFee, gas: 10_000}("");
            emit Refunded(g, id, to, ok);
        }
    }

    /// @notice 链上结算一回合
    /// @param actionTypes / args 按 roster 下标排列；死亡生物的行动被忽略
    function resolveRound(
        uint32 round,
        uint8[] calldata actionTypes,
        uint8[] calldata args,
        bytes32 reveal,
        bytes32 llmLogHash
    ) external onlyOperator {
        if (phase != Phase.Running || over) revert BadPhase();
        if (round != currentRound + 1) revert BadRound();
        _consumeReveal(reveal);
        currentRound = round;

        uint32 g = gameId;
        uint256[] memory ids = rosterOf[g];
        uint256 n = ids.length;
        if (actionTypes.length != n || args.length != n) revert BadLength();

        Ctx memory ctx = Ctx(g, round, _seed(reveal, round), 0, foodMask, foodCount);
        Creature[] memory cs = new Creature[](n);
        bool[] memory hiding = new bool[](n);
        uint8[144] memory occ;
        for (uint256 i; i < n; ++i) {
            Creature memory c = creatures[ids[i]];
            cs[i] = c;
            if (c.alive) {
                occ[_tile(c.x, c.y)] = uint8(i + 1);
                hiding[i] = actionTypes[i] == ACT_HIDE;
            }
        }

        uint256[] memory order = _order(ctx, cs);
        for (uint256 k; k < order.length; ++k) {
            uint256 i = order[k];
            if (!cs[i].alive) continue;
            _act(ctx, ids, cs, hiding, occ, i, actionTypes[i], args[i]);
        }

        uint256 alive = _endOfRound(ctx, ids, cs);
        _spawnFood(ctx);

        for (uint256 i; i < n; ++i) {
            creatures[ids[i]] = cs[i];
        }
        foodMask = ctx.food;
        foodCount = uint8(ctx.foodCount);
        if (alive <= 1 || round >= MAX_ROUNDS) over = true;
        emit RoundResolved(g, round, reveal, ctx.seed, llmLogHash, alive);
    }

    /// @notice 判定胜者并发奖：只剩 1 只，或 HP 最高（同 HP 比击杀，再比 roster 顺序）；
    ///         全灭时最后倒下的获胜（同回合比击杀，再比 roster 顺序）
    ///         冠军是庄家生物 / 转账失败时，奖池顺延到下一局
    function finish() external onlyOperator {
        if (phase != Phase.Running) revert BadPhase();
        if (!over) revert NotOver();
        phase = Phase.Ended;
        uint32 g = gameId;

        uint256[] storage roster = rosterOf[g];
        uint256 winnerId;
        uint256 bestHp;
        uint256 bestKills;
        for (uint256 i; i < roster.length; ++i) {
            Creature storage c = creatures[roster[i]];
            if (!c.alive) continue;
            if (winnerId == 0 || c.hp > bestHp || (c.hp == bestHp && c.kills > bestKills)) {
                winnerId = roster[i];
                bestHp = c.hp;
                bestKills = c.kills;
            }
        }
        if (winnerId == 0) {
            uint256 lastRound;
            for (uint256 i; i < roster.length; ++i) {
                Creature storage c = creatures[roster[i]];
                if (c.diedRound > lastRound || (c.diedRound == lastRound && lastRound > 0 && c.kills > bestKills)) {
                    winnerId = roster[i];
                    lastRound = c.diedRound;
                    bestKills = c.kills;
                }
            }
        }

        address winner = winnerId == 0 ? address(0) : ownerOf[winnerId];
        uint256 prize;
        if (winner != address(0)) {
            prize = address(this).balance;
            (bool ok,) = payable(winner).call{value: prize}("");
            if (!ok) prize = 0;
        }
        emit Finished(g, winnerId, winner, prize);
    }

    // ═════════════════════════ 玩家 ═════════════════════════

    function join(string calldata prompt) external payable returns (uint256 id) {
        if (phase != Phase.Lobby) revert BadPhase();
        if (msg.value != entryFee) revert BadFee();
        uint256 len = bytes(prompt).length;
        if (len == 0 || len > MAX_PROMPT_BYTES) revert BadPrompt();
        uint32 g = gameId;
        if (playerCount[g] >= maxPlayers) revert Full();
        playerCount[g]++;
        id = _newCreature(msg.sender, prompt);
    }

    /// @notice 打气：只写 cheers[id]，与其他玩家的交易互不冲突
    function cheer(uint256 id) external payable {
        if (phase != Phase.Lobby && phase != Phase.Running) revert BadPhase();
        if (msg.value != cheerFee) revert BadFee();
        Creature storage c = creatures[id];
        if (c.gameId != gameId || !c.spawned) revert BadCreature();
        if (phase == Phase.Running && !c.alive) revert BadCreature();
        uint256 total = cheers[id] + 1;
        cheers[id] = total;
        emit Cheered(c.gameId, id, msg.sender, total);
    }

    function setStance(uint256 id, uint8 stance) external {
        if (phase != Phase.Lobby && phase != Phase.Running) revert BadPhase();
        if (ownerOf[id] != msg.sender) revert NotOwner();
        if (stance >= NUM_STANCES) revert BadEnum();
        uint32 g = creatures[id].gameId;
        if (g != gameId) revert BadCreature();
        stanceOf[id] = stance;
        emit StanceSet(g, id, stance);
    }

    // ═════════════════════════ 视图 ═════════════════════════

    function getJoined(uint32 g) external view returns (uint256[] memory) {
        return joinedOf[g];
    }

    function getRoster(uint32 g)
        external
        view
        returns (
            uint256[] memory ids,
            Creature[] memory cs,
            address[] memory owners,
            uint256[] memory cheerCounts,
            uint8[] memory stances
        )
    {
        ids = rosterOf[g];
        uint256 n = ids.length;
        cs = new Creature[](n);
        owners = new address[](n);
        cheerCounts = new uint256[](n);
        stances = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            uint256 id = ids[i];
            cs[i] = creatures[id];
            owners[i] = ownerOf[id];
            cheerCounts[i] = cheers[id];
            stances[i] = stanceOf[id];
        }
    }

    /// @return hp 初始 HP, atk 基础攻击, def 防御, spd 速度
    function classStats(uint8 cls) public pure returns (uint256 hp, uint256 atk, uint256 def, uint256 spd) {
        if (cls == ASSAULT) return (90, 8, 2, 3);
        if (cls == GUARD) return (120, 4, 6, 2);
        if (cls == AGILE) return (80, 5, 3, 7);
        revert BadEnum();
    }

    /// @notice 当前回合有效属性（含特性与狂暴）
    function effectiveStats(uint256 id) external view returns (uint256 atk, uint256 def, uint256 spd) {
        Creature memory c = creatures[id];
        return (_atk(c), _def(c), _spd(c));
    }

    /// @notice 毒圈：第 round 回合结束时，安全区为 [ring, 11-ring]²
    function zoneRing(uint32 round) public pure returns (uint256) {
        if (round < ZONE_START) return 0;
        uint256 ring = (round - ZONE_START) / ZONE_EVERY + 1;
        return ring > ZONE_MAX_RING ? ZONE_MAX_RING : ring;
    }

    /// @notice 克制系数（基点）：克制 15000，被克 7000，否则 10000
    function matchupBp(uint8 atkCls, uint8 defCls) public pure returns (uint256) {
        if (defCls == (atkCls + 2) % 3) return COUNTER_BP;
        if (atkCls == (defCls + 2) % 3) return COUNTERED_BP;
        return BP;
    }

    // ═════════════════════════ 内部：入场 ═════════════════════════

    function _newCreature(address owner, string calldata prompt) internal returns (uint256 id) {
        uint32 g = gameId;
        uint256[] storage joined = joinedOf[g];
        if (joined.length >= MAX_CREATURES) revert Full();
        id = nextId++;
        creatures[id].gameId = g;
        ownerOf[id] = owner;
        joined.push(id);
        emit Joined(g, id, owner, prompt);
    }

    function _initCreature(Creature storage c, uint256 id, uint8 cls, uint8 trait) internal {
        if (cls >= NUM_CLASSES || trait >= NUM_TRAITS) revert BadEnum();
        (uint256 hp,,,) = classStats(cls);
        if (trait == BLOODTHIRST) hp -= 10;
        c.cls = cls;
        c.trait = trait;
        c.hp = uint16(hp);
        c.maxHp = uint16(hp);
        c.spawned = true;
        emit Spawned(c.gameId, id, cls, trait, uint16(hp));
    }

    // ═════════════════════════ 内部：随机数 ═════════════════════════

    function _consumeReveal(bytes32 x) internal {
        if (keccak256(abi.encodePacked(x)) != lastReveal) revert BadReveal();
        lastReveal = x;
    }

    /// @dev seed_r = keccak256(x_r, prevrandao, blockhash(n-1), gameId, r)
    ///      同时混入 prevrandao 与上一个区块哈希：两者中任意一个在 Monad 上不可用都不影响安全性假设
    function _seed(bytes32 reveal, uint32 round) internal view returns (bytes32) {
        return keccak256(abi.encode(reveal, block.prevrandao, blockhash(block.number - 1), gameId, round));
    }

    /// @dev 第 i 次随机 = keccak256(seed, i)
    function _rand(Ctx memory ctx) internal pure returns (uint256 r) {
        r = uint256(keccak256(abi.encode(ctx.seed, ctx.nonce)));
        ctx.nonce++;
    }

    function _randomEmptyTile(Ctx memory ctx, uint8[144] memory occ) internal pure returns (uint256 t) {
        for (uint256 k; k < 32; ++k) {
            t = _rand(ctx) % TILES;
            if (occ[t] == 0) return t;
        }
        for (t = 0; t < TILES; ++t) {
            if (occ[t] == 0) return t;
        }
        revert Full(); // 不可能：MAX_CREATURES < TILES
    }

    function _spawnFood(Ctx memory ctx) internal pure {
        for (uint256 k; k < FOOD_PER_ROUND && ctx.foodCount < MAX_FOOD; ++k) {
            uint256 bit = 1 << (_rand(ctx) % TILES);
            if (ctx.food & bit == 0) {
                ctx.food |= bit;
                ctx.foodCount++;
            }
        }
    }

    // ═════════════════════════ 内部：结算 ═════════════════════════

    /// @dev 存活生物按 SPD 降序；同速用随机数决定先后
    function _order(Ctx memory ctx, Creature[] memory cs) internal pure returns (uint256[] memory order) {
        uint256 n = cs.length;
        uint256[] memory keys = new uint256[](n);
        uint256 m;
        for (uint256 i; i < n; ++i) {
            if (!cs[i].alive) continue;
            uint256 tiebreak = _rand(ctx) >> 136; // 120 bit
            keys[m++] = (_spd(cs[i]) << 128) | (tiebreak << 8) | i;
        }
        // 插入排序（n ≤ 64）
        for (uint256 a = 1; a < m; ++a) {
            uint256 key = keys[a];
            uint256 b = a;
            while (b > 0 && keys[b - 1] < key) {
                keys[b] = keys[b - 1];
                --b;
            }
            keys[b] = key;
        }
        order = new uint256[](m);
        for (uint256 k; k < m; ++k) {
            order[k] = keys[k] & 0xff;
        }
    }

    function _act(
        Ctx memory ctx,
        uint256[] memory ids,
        Creature[] memory cs,
        bool[] memory hiding,
        uint8[144] memory occ,
        uint256 i,
        uint8 t,
        uint8 arg
    ) internal {
        Creature memory c = cs[i];
        if (t == ACT_STAY || t == ACT_HIDE) return;

        if (t == ACT_MOVE) {
            if (arg > 3 || !_move(c, occ, i, arg)) emit Rejected(ctx.g, ctx.round, ids[i], t, arg);
        } else if (t == ACT_ATTACK) {
            uint256 j = arg;
            if (j >= cs.length || j == i || !cs[j].alive || !_adjacent(c, cs[j])) {
                emit Rejected(ctx.g, ctx.round, ids[i], t, arg);
                return;
            }
            uint256 taunter = _taunter(cs, occ, i, j);
            if (taunter != j) {
                emit Taunted(ctx.g, ctx.round, ids[i], ids[j], ids[taunter]);
                j = taunter;
            }
            _hit(ctx, ids, cs, hiding, occ, i, j);
        } else if (t == ACT_EAT) {
            uint256 bit = 1 << _tile(c.x, c.y);
            if (ctx.food & bit == 0) {
                emit Rejected(ctx.g, ctx.round, ids[i], t, arg);
                return;
            }
            ctx.food &= ~bit;
            ctx.foodCount--;
            uint256 heal = _heal(c, c.trait == HOARDER ? HOARDER_EAT_HP : EAT_HP);
            emit Ate(ctx.g, ctx.round, ids[i], heal);
        } else {
            emit Rejected(ctx.g, ctx.round, ids[i], t, arg);
        }
    }

    /// @dev 敏捷走 2 格，其他 1 格；遇到边界或占用就停下。一步都没走成视为不合法
    function _move(Creature memory c, uint8[144] memory occ, uint256 i, uint8 dir) internal pure returns (bool moved) {
        uint256 steps = c.cls == AGILE ? 2 : 1;
        for (uint256 s; s < steps; ++s) {
            int256 nx = int256(uint256(c.x));
            int256 ny = int256(uint256(c.y));
            if (dir == 0) ny -= 1;
            else if (dir == 1) nx += 1;
            else if (dir == 2) ny += 1;
            else nx -= 1;
            if (nx < 0 || ny < 0 || nx >= int256(uint256(MAP_SIZE)) || ny >= int256(uint256(MAP_SIZE))) break;
            uint256 nt = _tile(uint8(uint256(nx)), uint8(uint256(ny)));
            if (occ[nt] != 0) break;
            occ[_tile(c.x, c.y)] = 0;
            occ[nt] = uint8(i + 1);
            c.x = uint8(uint256(nx));
            c.y = uint8(uint256(ny));
            moved = true;
        }
    }

    /// @dev 嘲讽：攻击者周围 8 格内有"自大"敌人时，攻击被强制转向它
    function _taunter(Creature[] memory cs, uint8[144] memory occ, uint256 i, uint256 j)
        internal
        pure
        returns (uint256)
    {
        if (cs[j].trait == BOAST) return j;
        Creature memory a = cs[i];
        for (int256 dy = -1; dy <= 1; ++dy) {
            for (int256 dx = -1; dx <= 1; ++dx) {
                int256 x = int256(uint256(a.x)) + dx;
                int256 y = int256(uint256(a.y)) + dy;
                if (x < 0 || y < 0 || x >= int256(uint256(MAP_SIZE)) || y >= int256(uint256(MAP_SIZE))) continue;
                uint256 o = occ[_tile(uint8(uint256(x)), uint8(uint256(y)))];
                if (o == 0 || o - 1 == i) continue;
                if (cs[o - 1].trait == BOAST) return o - 1;
            }
        }
        return j;
    }

    /// @dev dmg = (ATK×4 − DEF) × 克制 × 骰子(0.8–1.2) × 暴击(1.5)，HIDE 减半（龟缩 ×0.25），最小 1
    function _hit(
        Ctx memory ctx,
        uint256[] memory ids,
        Creature[] memory cs,
        bool[] memory hiding,
        uint8[144] memory occ,
        uint256 i,
        uint256 j
    ) internal {
        Creature memory a = cs[i];
        Creature memory d = cs[j];

        uint256 atk4 = _atk(a) * 4;
        uint256 def = _def(d);
        uint256 base = atk4 > def ? atk4 - def : 1;
        uint256 mBp = matchupBp(a.cls, d.cls);
        uint256 r = _rand(ctx);
        uint256 rollBp = 8_000 + (r % 4_001);
        bool crit = (r >> 128) % 100 < CRIT_PCT;
        uint256 dmg = (base * mBp * rollBp) / (BP * BP);
        if (crit) dmg = (dmg * 3) / 2;
        bool hidden = hiding[j];
        if (hidden) dmg = d.trait == TURTLE ? dmg / 4 : dmg / 2;
        if (dmg == 0) dmg = 1;

        if (dmg >= d.hp) {
            d.hp = 0;
            d.alive = false;
            d.poison = 0;
            d.diedRound = ctx.round;
            occ[_tile(d.x, d.y)] = 0;
            if (a.kills < type(uint8).max) a.kills++;
            emit Hit(ctx.g, ctx.round, ids[i], ids[j], base, mBp, rollBp, crit, hidden, dmg, 0);
            emit Died(ctx.g, ctx.round, ids[j], ids[i], CAUSE_ATTACK);
            if (a.trait == BLOODTHIRST) _heal(a, BLOODTHIRST_HP);
        } else {
            d.hp -= uint16(dmg);
            if (a.trait == VENOM) d.poison = POISON_ROUNDS;
            emit Hit(ctx.g, ctx.round, ids[i], ids[j], base, mBp, rollBp, crit, hidden, dmg, d.hp);
        }
    }

    /// @dev 回合末：中毒、毒圈、打气回血。返回存活数
    function _endOfRound(Ctx memory ctx, uint256[] memory ids, Creature[] memory cs) internal returns (uint256 alive) {
        uint256 ring = zoneRing(ctx.round);
        for (uint256 i; i < cs.length; ++i) {
            Creature memory c = cs[i];
            if (!c.alive) continue;

            uint256 poisonDmg;
            uint256 zoneDmg;
            if (c.poison > 0) {
                poisonDmg = POISON_DMG;
                c.poison--;
            }
            if (ring > 0 && (c.x < ring || c.y < ring || c.x > MAP_SIZE - 1 - ring || c.y > MAP_SIZE - 1 - ring)) {
                zoneDmg = ZONE_DMG;
            }
            uint256 dmg = poisonDmg + zoneDmg;
            if (dmg > 0) {
                emit Damaged(ctx.g, ctx.round, ids[i], poisonDmg, zoneDmg);
                if (dmg >= c.hp) {
                    c.hp = 0;
                    c.alive = false;
                    c.poison = 0;
                    c.diedRound = ctx.round;
                    emit Died(ctx.g, ctx.round, ids[i], 0, zoneDmg > 0 ? CAUSE_ZONE : CAUSE_POISON);
                    continue;
                }
                c.hp -= uint16(dmg);
            }

            uint256 total = cheers[ids[i]];
            if (total > c.lastCheers) {
                uint256 delta = total - c.lastCheers;
                c.lastCheers = uint32(total);
                if (delta > MAX_CHEERS_PER_ROUND) delta = MAX_CHEERS_PER_ROUND;
                uint256 heal = _heal(c, delta * CHEER_HP * (c.trait == SOCIAL ? 2 : 1));
                emit CheerHealed(ctx.g, ctx.round, ids[i], heal);
            }
            ++alive;
        }
    }

    // ═════════════════════════ 内部：属性 ═════════════════════════

    function _atk(Creature memory c) internal pure returns (uint256 atk) {
        (, atk,,) = classStats(c.cls);
        uint8 t = c.trait;
        if (t == HOARDER) atk -= 1;
        else if (t == VENOM) atk -= 2;
        else if (t == BOAST) atk += 2;
        else if (t == BERSERK && c.hp < BERSERK_THRESHOLD) atk += 3;
    }

    function _def(Creature memory c) internal pure returns (uint256 def) {
        (,, def,) = classStats(c.cls);
        if (c.trait == BERSERK || c.trait == SOCIAL) def -= 1;
    }

    function _spd(Creature memory c) internal pure returns (uint256 spd) {
        (,,, spd) = classStats(c.cls);
        if (c.trait == TURTLE) spd -= 1;
    }

    function _heal(Creature memory c, uint256 amount) internal pure returns (uint256 healed) {
        uint256 hp = c.hp;
        uint256 next = hp + amount;
        if (next > c.maxHp) next = c.maxHp;
        c.hp = uint16(next);
        healed = next - hp;
    }

    function _adjacent(Creature memory a, Creature memory b) internal pure returns (bool) {
        uint256 dx = a.x > b.x ? a.x - b.x : b.x - a.x;
        uint256 dy = a.y > b.y ? a.y - b.y : b.y - a.y;
        return dx <= 1 && dy <= 1 && (dx + dy) > 0;
    }

    function _tile(uint8 x, uint8 y) internal pure returns (uint256) {
        return uint256(y) * MAP_SIZE + x;
    }
}
