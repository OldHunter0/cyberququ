import { createPublicClient, defineChain, http } from "viem";
import { ARENA_ADDRESS, arenaAbi } from "./abi";

export const RPC = process.env.NEXT_PUBLIC_MONAD_RPC ?? "https://testnet-rpc.monad.xyz";
export const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://testnet.monadexplorer.com";
export const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:8787";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const pub = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC, { retryCount: 3, retryDelay: 500 }),
  batch: { multicall: { wait: 16 } },
});

export const arena = { address: ARENA_ADDRESS, abi: arenaAbi } as const;

export const PHASES = ["Idle", "Lobby", "Running", "Ended"] as const;
export const CLASS_NAMES = ["猛攻", "坚守", "敏捷"];
export const CLASS_EMOJI = ["🔥", "🛡", "💨"];
export const CLASS_DESC = ["攻高血薄，克敏捷", "血厚防高，克猛攻", "速度快走两格，克坚守"];
export const TRAIT_NAMES = ["囤粮", "狂暴", "龟缩", "嗜血", "毒刺", "社牛", "自大"];
export const TRAIT_DESC = [
  "吃东西回 35（常规 20），ATK −1",
  "HP < 40 时 ATK +3，DEF −1",
  "HIDE 减伤 75%，SPD −1",
  "击杀回 30 HP，初始 HP −10",
  "命中让对方中毒 3 回合，ATK −2",
  "被打气效果 ×2，DEF −1",
  "吹牛税：ATK +2，但会被所有人优先攻击",
];
export const STANCES = [
  { name: "进攻", emoji: "⚔️", desc: "积极找人打" },
  { name: "苟住", emoji: "🐢", desc: "躲起来保命" },
  { name: "觅食", emoji: "🍖", desc: "找吃的回血" },
];
export const txLink = (h: string) => `${EXPLORER}/tx/${h}`;
