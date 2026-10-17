// 模拟用户：每个机器人是一个独立钱包（私钥 = keccak256(BOT_SEED, i)），像真人一样直接往链上发交易：
// 大厅里随机延迟后 join，对局中随机打气、切姿态。引擎靠地址识别机器人，它们不占真人名额。
import { createWalletClient, encodePacked, keccak256, parseEther, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { arenaAbi } from "../shared/abi.ts";
import { getJoined, getRoster, monadTestnet, ownerOf, Phase, pub, readGlobal, transfer, transport } from "./chain.ts";
import { cfg, runtime } from "./config.ts";

const MAX_BOTS = 12;

const PROMPTS = [
  "静安寺门口排队三小时的网红奶茶",
  "武康路上拍照的文艺青年，自带滤镜",
  "外滩夜跑的健身狂魔，八块腹肌",
  "被甲方改稿 18 次的设计师，眼神死",
  "凌晨四点还在打卡的陆家嘴咖啡",
  "城隍庙里会说上海话的小笼包",
  "共享单车坟场里爬出来的小黄车",
  "迪士尼排队排到怀疑人生的家长",
  "徐家汇地铁站里永远找不到出口的游客",
  "南京路上发传单的熊猫人偶，很能扛",
  "弄堂口晒太阳的胖橘猫，脾气暴躁",
  "黄浦江上的海鸥，专门抢游客的薯条",
  "会计师事务所的审计狗，拿着计算器",
  "张江药谷里熬夜的博士，毒舌",
  "永康路酒吧的调酒师，社交达人",
  "社区团购的团长阿姨，囤货无数",
  "地铁 9 号线的早高峰，挤不进去也要挤",
  "梧桐区的流浪狗，灵活又警惕",
];

export const botAccounts = Array.from({ length: cfg.botSeed ? MAX_BOTS : 0 }, (_, i) =>
  privateKeyToAccount(keccak256(encodePacked(["bytes32", "uint256"], [cfg.botSeed, BigInt(i)])), { nonceManager }),
);
const botSet = new Set(botAccounts.map((a) => a.address.toLowerCase()));
export const isBot = (addr: string) => botSet.has(addr.toLowerCase());

const wallets = botAccounts.map((account) => createWalletClient({ chain: monadTestnet, transport, account }));
const arena = { address: cfg.arena, abi: arenaAbi } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

// Monad 按 gas limit 收费，机器人用略高于实测的固定 limit，省掉 estimate 请求
const GAS = { join: 260_000n, cheer: 90_000n, setStance: 80_000n };

let fees: { entry: bigint; cheer: bigint } | null = null;
const joinedGame = new Map<number, Set<number>>(); // gameId → 已 join 的机器人下标
const scheduled = new Set<string>(); // `${gameId}:${i}`

async function fundBots() {
  const target = parseEther(cfg.botFund);
  for (const a of botAccounts.slice(0, runtime.botCount)) {
    const bal = await pub.getBalance({ address: a.address });
    if (bal * 3n < target) {
      await transfer(a.address, target - bal);
      console.log(`[bots] funded ${a.address.slice(0, 8)} → ${cfg.botFund} MON`);
    }
  }
}

async function botTx(i: number, functionName: "join" | "cheer" | "setStance", args: readonly unknown[], value = 0n) {
  const hash = await wallets[i].writeContract({ ...arena, functionName, args, value, gas: GAS[functionName] } as any);
  return hash as Hex;
}

async function lobbyTick(g: number) {
  let joined = joinedGame.get(g);
  if (!joined) {
    // 引擎重启后：看看哪些机器人已经在这局里了，避免重复 join
    joined = new Set();
    const ids = await getJoined(g);
    const owners = await Promise.all(ids.map((id) => ownerOf(id)));
    owners.forEach((o) => {
      const k = botAccounts.findIndex((a) => a.address.toLowerCase() === o.toLowerCase());
      if (k >= 0) joined!.add(k);
    });
    joinedGame.set(g, joined);
    await fundBots().catch((e) => console.warn("[bots] fund", e.message.split("\n")[0]));
  }
  for (let i = 0; i < Math.min(runtime.botCount, botAccounts.length); i++) {
    const key = `${g}:${i}`;
    if (joined.has(i) || scheduled.has(key)) continue;
    scheduled.add(key);
    const delay = 2_000 + Math.random() * Math.max(5_000, cfg.lobbySeconds * 1000 * 0.6);
    setTimeout(async () => {
      try {
        const st = await readGlobal();
        if (st.phase !== Phase.Lobby || st.gameId !== g) return;
        await botTx(i, "join", [pick(PROMPTS)], fees!.entry);
        joined!.add(i);
      } catch (e) {
        console.warn(`[bots] #${i} join`, (e as Error).message.split("\n")[0]);
        scheduled.delete(key);
      }
    }, delay);
  }
}

async function runningTick(g: number) {
  const r = await getRoster(g);
  const alive = r.ids.filter((_, k) => r.cs[k].alive);
  if (!alive.length) return;
  for (let i = 0; i < Math.min(runtime.botCount, botAccounts.length); i++) {
    const roll = Math.random();
    if (roll > 0.3) continue; // 每个机器人每 tick 约 30% 概率做点什么
    const mine = r.ids.findIndex((_, k) => r.owners[k].toLowerCase() === botAccounts[i].address.toLowerCase());
    const myAlive = mine >= 0 && r.cs[mine].alive;
    try {
      if (myAlive && roll < 0.08) {
        await botTx(i, "setStance", [r.ids[mine], Math.floor(Math.random() * 3)]);
      } else {
        const target = myAlive && Math.random() < 0.5 ? r.ids[mine] : pick(alive);
        await botTx(i, "cheer", [target], fees!.cheer);
      }
    } catch (e) {
      console.warn(`[bots] #${i}`, (e as Error).message.split("\n")[0]);
    }
  }
}

export async function startBots() {
  if (!botAccounts.length) {
    console.log("[bots] BOT_SEED 未设置，模拟用户关闭");
    return;
  }
  const [entry, cheer] = await Promise.all([
    pub.readContract({ ...arena, functionName: "entryFee" }),
    pub.readContract({ ...arena, functionName: "cheerFee" }),
  ]);
  fees = { entry, cheer };
  console.log(`[bots] ${runtime.botCount} 个模拟用户：${botAccounts.slice(0, runtime.botCount).map((a) => a.address.slice(0, 8)).join(" ")}`);
  while (true) {
    try {
      if (runtime.botCount > 0) {
        const st = await readGlobal();
        if (st.phase === Phase.Lobby) await lobbyTick(st.gameId);
        else if (st.phase === Phase.Running && !st.over) await runningTick(st.gameId);
      }
    } catch (e) {
      console.warn("[bots]", (e as Error).message.split("\n")[0]);
    }
    await sleep(3000);
  }
}
