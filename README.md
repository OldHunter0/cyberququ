# 赛博斗蛐蛐 · Prompt Arena

> Monad Blitz 上海 2026 参赛作品

观众用一句话"捏"一只 AI 生物，付 0.01 MON 进场。AI 世界模型替生物选择行动，战斗规则和随机数全部在 Monad 链上公开执行。最后活下来的那只，它的主人拿走奖池。

- 合约（Monad Testnet）：`0x36d9B8638251F566A2a31485D0ED281eE2dadCFe`
- 手机页（Vercel）：https://cyber-cricket-arena-ten.vercel.app
- 每局最多 16 名玩家，另有 4–6 只庄家生物（甲方爸爸、外卖小哥、陆家嘴卷王……），人少时也能开局。

## 公平性：prompt 决定性格，不决定强度

| 环节 | 谁来决定 | 怎么验证 |
|---|---|---|
| 生物强度 | LLM 只能从 3 职业 × 6 特性的枚举里选一个组合，数值写死在合约常量里 | `Spawned` 事件里只有职业和特性的编号 |
| 吹牛 | 人设自称无敌、最强、第一时，强制分配"自大"特性：ATK +2，代价是被嘲讽，**由合约强制执行** | `Taunted` 事件 |
| 行动合法性 | 合约检查：攻击必须相邻，移动不能越界、不能进占用格，吃东西脚下必须有食物；不合法的行动视为原地不动 | `Rejected` 事件 |
| 伤害 | `(ATK×4 − DEF) × 克制(1.5/0.7) × 骰子(0.8–1.2) × 暴击(10%, 1.5)`，HIDE 减半 | 每一刀都有 `Hit(base, matchupBp, rollBp, crit, hidden, dmg)` 事件，大屏实时显示计算过程 |
| 随机数 | 哈希链承诺：开局先上链 `anchor = H⁴⁰(s)`，每回合揭示 `x_r` 并要求 `keccak256(x_r) == 上一个揭示值`；种子为 `keccak256(x_r, prevrandao, blockhash, gameId, round)` | `RoundResolved(reveal, seed)`，任何人都能重算 |
| LLM 选招 | 所有生物共用同一个模板，temperature 设为 0，只能从合法选项中挑一个；每回合的完整输入输出算出哈希后上链 | `RoundResolved.llmLogHash` 等于 `keccak256(engine/logs/<局>/<回合>.llm.json)` |
| 奖池 | 合约余额就是奖池，冠军结算时自动转账；庄家生物获胜时顺延到下一局 | `Finished` 事件和转账交易 |

运营方只能做两件事：揭示早已承诺好的随机数，以及提交 LLM 选出的招式。数值、结算和发奖都由合约完成。

**为什么用 Monad**：每只生物的打气计数和战术姿态都放在独立的存储槽里（`cheers[id]`、`stanceOf[id]`），奖池也不用共享变量。所以全场观众同时打气、切换姿态时，交易互相不冲突，可以并行执行。整场战斗的结算都在链上进行：16 只生物时，每回合约 30 万 gas，2–3 秒出结果。

## 目录

```
contracts/   Foundry：src/Arena.sol（规则、随机数、奖池），test/Arena.t.sol（41 个测试）
engine/      Node + tsx，在笔记本上运行：大厅分类 → 每回合 LLM 选招 → resolveRound → 解说；同时提供 SSE 和 /logs
web/         Next.js：/ 手机页（临时钱包、进场、姿态、打气），/screen 大屏，/api/faucet
shared/      合约 ABI 和地址（由 contracts/export-abi.sh 生成）
```

## 运行

根目录 `.env` 已经写好钱包、RPC 和 LLM 配置（不要提交到仓库）。

```bash
# 1. 引擎（笔记本）
cd engine && npm start
#   环境变量：LOBBY_SECONDS=60 ROUND_MS=8000 HOUSE_COUNT=5 AUTO_START=1 AUTO_NEXT_SECONDS=0
#   MONAD_RPC_FALLBACK=<备用 RPC>   USE_LLM=0（纯脚本 AI，用于调试）

# 2. 前端
cd web && npm run build && npm start      # 监听 0.0.0.0:3000
#   web/.env.local：FAUCET_PK=...  NEXT_PUBLIC_ENGINE_URL=http://localhost:8787
#   可选：NEXT_PUBLIC_PLAY_URL=<手机访问地址>（大屏二维码使用）

#   线上部署：cd web && npx vercel deploy --prod（FAUCET_PK 存在 Vercel 的 Production 环境变量里，类型为 Sensitive）

# 3. 大屏：在笔记本浏览器打开 http://localhost:3000/screen（大屏要连本机引擎，所以不用 Vercel 上的版本）
#    右下角有"立即开局"和"下一局"按钮（对应引擎的 POST /admin/start 和 /admin/new）
```

合约：

```bash
cd contracts
~/.foundry/bin/forge test
MAX_PLAYERS=16 ~/.foundry/bin/forge script script/Deploy.s.sol --rpc-url monad --broadcast --private-key $OPERATOR_PK
ARENA_ADDRESS=0x... ./export-abi.sh && cp ../shared/abi.ts ../web/lib/abi.ts
```

## 自己验证某一回合

```bash
# 1. 随机数：揭示值必须能哈希回上一回合的揭示值
cast keccak <第 r 回合的 reveal>     # 应等于第 r-1 回合的 reveal（第 0 个揭示值哈希后等于 anchor）
# 2. LLM 日志
cast keccak "$(cat engine/logs/<局>/<回合>.llm.json)"   # 应等于链上 RoundResolved.llmLogHash
# 3. 伤害：用 Hit 事件里的 base × matchupBp × rollBp / 1e8（暴击再 ×1.5，HIDE 再 ÷2 或 ÷4）重算
```
