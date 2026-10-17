import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { arenaAbi } from "../shared/abi.ts";
import { cfg } from "./config.ts";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// 公共 RPC 限 15 req/s：所有请求过一个全局限速器（默认 10/s）
const RPS = Number(process.env.RPC_RPS ?? 10);
let nextSlot = 0;
const limitedFetch: typeof fetch = async (input, init) => {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / RPS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
  return fetch(input, init);
};
const httpOpts = { retryCount: 5, retryDelay: 600, timeout: 15_000, fetchFn: limitedFetch };
export const transport = process.env.MONAD_RPC_FALLBACK
  ? fallback([http(cfg.rpc, httpOpts), http(process.env.MONAD_RPC_FALLBACK, httpOpts)])
  : http(cfg.rpc, httpOpts);
export const account = privateKeyToAccount(cfg.operatorPk, { nonceManager });
// batch.multicall：同一 tick 里的 readContract 自动合并成一次 eth_call
export const pub = createPublicClient({
  chain: monadTestnet,
  transport,
  pollingInterval: 400,
  batch: { multicall: { wait: 10 } },
});
const wallet = createWalletClient({ chain: monadTestnet, transport, account });
const arena = { address: cfg.arena, abi: arenaAbi } as const;

export enum Phase {
  Idle = 0,
  Lobby = 1,
  Running = 2,
  Ended = 3,
}

export type Creature = {
  gameId: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  cls: number;
  trait: number;
  kills: number;
  poison: number;
  spawned: boolean;
  alive: boolean;
  lastCheers: number;
  diedRound: number;
};

export type Roster = {
  ids: bigint[];
  cs: Creature[];
  owners: Address[];
  cheers: bigint[];
  stances: number[];
};

export async function readGlobal() {
  const [phase, gameId, currentRound, over, lastReveal, foodMask] = await Promise.all([
    pub.readContract({ ...arena, functionName: "phase" }),
    pub.readContract({ ...arena, functionName: "gameId" }),
    pub.readContract({ ...arena, functionName: "currentRound" }),
    pub.readContract({ ...arena, functionName: "over" }),
    pub.readContract({ ...arena, functionName: "lastReveal" }),
    pub.readContract({ ...arena, functionName: "foodMask" }),
  ]);
  return { phase: phase as Phase, gameId, currentRound, over, lastReveal: lastReveal as Hex, foodMask };
}

export async function getRoster(g: number): Promise<Roster> {
  const [ids, cs, owners, cheers, stances] = await pub.readContract({ ...arena, functionName: "getRoster", args: [g] });
  return { ids: [...ids], cs: cs as unknown as Creature[], owners: [...owners], cheers: [...cheers], stances: [...stances] };
}

export async function getJoined(g: number): Promise<bigint[]> {
  return [...(await pub.readContract({ ...arena, functionName: "getJoined", args: [g] }))];
}

export async function creatureOf(id: bigint) {
  const [gameId, hp, maxHp, x, y, cls, trait, kills, poison, spawned, alive, lastCheers, diedRound] = await pub.readContract({
    ...arena,
    functionName: "creatures",
    args: [id],
  });
  return { gameId, hp, maxHp, x, y, cls, trait, kills, poison, spawned, alive, lastCheers, diedRound } as Creature;
}

export async function ownerOf(id: bigint): Promise<Address> {
  return pub.readContract({ ...arena, functionName: "ownerOf", args: [id] });
}

export async function potBalance() {
  return pub.getBalance({ address: cfg.arena });
}

/** 运营方交易：Monad 按 gas limit 收费，所以 limit = estimate × margin，而不是固定大数 */
export async function send(functionName: string, args: readonly unknown[], margin = 1.2) {
  const req = { ...arena, functionName, args, account } as any;
  const est = await pub.estimateContractGas(req);
  const gas = (est * BigInt(Math.round(margin * 100))) / 100n;
  const hash = await wallet.writeContract({ ...req, gas });
  const rcpt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 60_000 });
  if (rcpt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  const logs = parseEventLogs({ abi: arenaAbi, logs: rcpt.logs });
  return { hash, rcpt, logs, gas, est };
}

/** 运营方转账（给模拟用户补 MON） */
export async function transfer(to: Address, value: bigint) {
  const hash = await wallet.sendTransaction({ to, value, gas: 21_000n });
  await pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 60_000 });
  return hash;
}

/** 增量拉取 Arena 的所有事件（Monad RPC 限制 eth_getLogs 区间，按 100 块分段） */
export async function logsBetween(fromBlock: bigint, toBlock: bigint) {
  const out = [];
  for (let a = fromBlock; a <= toBlock; a += 100n) {
    const b = a + 99n < toBlock ? a + 99n : toBlock;
    const raw = await pub.getLogs({ address: cfg.arena, fromBlock: a, toBlock: b });
    out.push(...parseEventLogs({ abi: arenaAbi, logs: raw }));
  }
  return out;
}

export const txUrl = (hash: Hex) => `${cfg.explorer}/tx/${hash}`;
