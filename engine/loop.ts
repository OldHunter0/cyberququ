// 引擎状态机：Idle/Ended → newGame → Lobby（分类 + spawn）→ start → Running（每回合 LLM 选招 + 链上结算）→ finish
// 用法：npm start（读取根目录 .env）。可以随时重启：所有状态以链上为准，秘密从 engine/secrets/ 恢复。
import fs from "node:fs";
import path from "node:path";
import { formatEther, keccak256, toHex, type Address, type Hex } from "viem";
import {
  creatureOf,
  getJoined,
  getRoster,
  logsBetween,
  ownerOf,
  Phase,
  potBalance,
  pub,
  readGlobal,
  send,
  txUrl,
  type Roster,
} from "./chain.ts";
import { cfg, runtime } from "./config.ts";
import { isBot, startBots } from "./bots.ts";
import { classify, decideActions, narrate, type Classified } from "./llm.ts";
import { anchorOf, loadChainFor, makeChain, nextReveal, saveChain } from "./seed.ts";
import {
  Board,
  CLASS_EMOJI,
  CLASS_NAMES,
  foodTiles,
  optionToAction,
  STANCE_NAMES,
  TRAIT_NAMES,
  zoneRing,
} from "./rules.ts";
import { broadcast, startServer } from "./server.ts";

// ───────────────────────── 庄家生物（上海梗，覆盖 3 个职业）─────────────────────────

const HOUSE: { name: string; emoji: string; cls: number; trait: number; catchphrase: string; persona: string }[] = [
  // 顺序有讲究：任取前 3 只以上都覆盖猛攻 / 坚守 / 敏捷
  { name: "甲方爸爸", emoji: "🧑‍💼", cls: 1, trait: 6, catchphrase: "这版不行，再改改", persona: "永远不满意的甲方，自称宇宙第一难搞" },
  { name: "外卖小哥", emoji: "🛵", cls: 2, trait: 0, catchphrase: "超时一分钟扣钱的！", persona: "在弄堂里穿梭的外卖小哥，手快脚快" },
  { name: "陆家嘴卷王", emoji: "💻", cls: 0, trait: 1, catchphrase: "今晚通宵上线", persona: "陆家嘴加班到凌晨的暴躁程序员" },
  { name: "2号线早高峰", emoji: "🚇", cls: 1, trait: 5, catchphrase: "往里走往里走！", persona: "早上八点半的 2 号线，挤得水泄不通" },
  { name: "梧桐区松鼠", emoji: "🐿️", cls: 2, trait: 2, catchphrase: "阿拉只是路过", persona: "武康路梧桐树上的胆小松鼠，爱囤坚果" },
  { name: "魔都房东", emoji: "🏠", cls: 0, trait: 3, catchphrase: "下个月涨房租哦", persona: "冷酷无情、只认钱的魔都房东" },
];

// ───────────────────────── 元数据 / 快照 ─────────────────────────

type Meta = Omit<Classified, "ms"> & {
  prompt: string;
  owner: Address;
  house: boolean;
  bot?: boolean;
  rejected?: boolean; // 真人名额已满：不上场，开局时合约退款
  lastSay?: string;
};
const meta = new Map<string, Meta>(); // key = id
let metaGame = 0;

function metaFile(g: number) {
  return path.join(cfg.logsDir, String(g), "meta.json");
}
function saveMeta(g: number) {
  fs.mkdirSync(path.dirname(metaFile(g)), { recursive: true });
  fs.writeFileSync(metaFile(g), JSON.stringify(Object.fromEntries(meta), null, 1));
}
function loadMeta(g: number) {
  if (metaGame === g) return;
  meta.clear();
  metaGame = g;
  if (fs.existsSync(metaFile(g))) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(metaFile(g), "utf8")))) meta.set(k, v as Meta);
  }
}

const fxLog: unknown[] = [];
const narrations: string[] = [];
const playerTxTimes: number[] = [];
let snapshot: any = { phase: "loading" };
let lobbyEndsAt = 0;
let winner: unknown = null;

function fx(type: string, data: Record<string, unknown>) {
  const e = { type, at: Date.now(), ...data };
  fxLog.push(e);
  if (fxLog.length > 80) fxLog.shift();
  broadcast("fx", e);
}

function nameOf(id: bigint | string) {
  const m = meta.get(String(id));
  return m ? `${m.emoji}${m.name}` : `#${id}`;
}

async function refresh() {
  const st = await readGlobal();
  const g = st.gameId;
  loadMeta(g);
  let creatures: any[] = [];
  if (st.phase === Phase.Running || st.phase === Phase.Ended) {
    const r = await getRoster(g);
    creatures = r.ids.map((id, i) => ({
      id: String(id),
      idx: i,
      owner: r.owners[i],
      cheers: Number(r.cheers[i]),
      stance: r.stances[i],
      ...r.cs[i],
      ...(meta.get(String(id)) ?? {}),
    }));
  } else if (st.phase === Phase.Lobby) {
    const ids = await getJoined(g);
    creatures = await Promise.all(
      ids.map(async (id, i) => ({ id: String(id), idx: i, ...(await creatureOf(id)), ...(meta.get(String(id)) ?? {}) })),
    );
  }
  const now = Date.now();
  while (playerTxTimes.length && playerTxTimes[0] < now - 10_000) playerTxTimes.shift();
  const live = creatures.filter((c) => c.spawned);
  snapshot = {
    arena: cfg.arena,
    explorer: cfg.explorer,
    phase: Phase[st.phase],
    gameId: g,
    round: st.currentRound,
    maxRounds: 20,
    over: st.over,
    zoneRing: zoneRing(st.currentRound),
    nextZoneRing: zoneRing(st.currentRound + 1),
    lobbyEndsAt: st.phase === Phase.Lobby ? lobbyEndsAt : 0,
    pot: formatEther(await potBalance()),
    food: foodTiles(st.foodMask),
    creatures,
    classDist: [0, 1, 2].map((k) => live.filter((c) => c.cls === k && (st.phase !== Phase.Running || c.alive)).length),
    alive: creatures.filter((c) => c.alive).length,
    playerTxPerSec: playerTxTimes.length / 10,
    narrations: narrations.slice(-8),
    recent: fxLog.slice(-30),
    winner: st.phase === Phase.Ended ? winner : null,
    realLimit: runtime.realLimit,
    botCount: runtime.botCount,
    realCount: [...meta.values()].filter((m) => !m.house && !m.bot && !m.rejected).length,
    names: { classes: CLASS_NAMES, classEmoji: CLASS_EMOJI, traits: TRAIT_NAMES, stances: STANCE_NAMES },
  };
  broadcast("snapshot", snapshot);
  return st;
}

// ───────────────────────── 事件轮询（玩家交易）─────────────────────────

const joinQueue: { gameId: number; id: bigint; owner: Address; prompt: string }[] = [];
let pollFrom = 0n;
let polling = false;

async function pollLogs() {
  if (polling) return;
  polling = true;
  try {
    const head = await pub.getBlockNumber();
    if (pollFrom === 0n) pollFrom = head > 300n ? head - 300n : 0n; // 重启时回看约 2 分钟
    if (head < pollFrom) return;
    const logs = await logsBetween(pollFrom, head);
    pollFrom = head + 1n;
    for (const l of logs as any[]) {
      const a = l.args;
      if (l.eventName === "Joined" && a.owner !== "0x0000000000000000000000000000000000000000") {
        joinQueue.push({ gameId: Number(a.gameId), id: a.id, owner: a.owner, prompt: a.prompt });
        playerTxTimes.push(Date.now());
      } else if (l.eventName === "Cheered") {
        playerTxTimes.push(Date.now());
        fx("cheer", { id: String(a.id), from: a.from, total: Number(a.total), name: nameOf(a.id) });
      } else if (l.eventName === "StanceSet") {
        playerTxTimes.push(Date.now());
        fx("stance", { id: String(a.id), stance: a.stance, stanceName: STANCE_NAMES[a.stance], name: nameOf(a.id) });
      }
    }
  } catch (e) {
    console.warn("[poll]", (e as Error).message.split("\n")[0]);
  } finally {
    polling = false;
  }
}

// ───────────────────────── 状态机 ─────────────────────────

let wantStart = false;
let wantNext = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newGame() {
  const c = makeChain();
  saveChain(c); // 先落盘再上链，崩溃也不丢秘密
  const { hash, logs } = await send("newGame", [anchorOf(c)]);
  const g = Number((logs.find((l: any) => l.eventName === "GameCreated") as any).args.gameId);
  console.log(`[game ${g}] newGame anchor=${anchorOf(c)} tx=${hash}`);
  loadMeta(g);
  lobbyEndsAt = Date.now() + cfg.lobbySeconds * 1000;
  winner = null;
  narrations.length = 0;
  fx("newGame", { gameId: g, anchor: anchorOf(c), tx: txUrl(hash) });
}

async function ensureHouse(g: number) {
  const ids = await getJoined(g);
  const owners = await Promise.all(ids.map((id) => ownerOf(id)));
  const existing = owners.filter((o) => o === "0x0000000000000000000000000000000000000000").length;
  for (const h of HOUSE.slice(existing, cfg.houseCount)) {
    const { logs } = await send("spawnHouse", [h.name, h.cls, h.trait]);
    const id = (logs.find((l: any) => l.eventName === "Spawned") as any).args.id as bigint;
    meta.set(String(id), {
      ...h,
      boast: h.trait === 6,
      safe: true,
      prompt: h.persona,
      owner: "0x0000000000000000000000000000000000000000",
      house: true,
      source: "llm",
    });
    console.log(`[game ${g}] house #${id} ${h.name}`);
  }
  saveMeta(g);
}

async function lobby(g: number) {
  loadMeta(g);
  if (!lobbyEndsAt) lobbyEndsAt = Date.now() + cfg.lobbySeconds * 1000;
  await ensureHouse(g);
  await refresh();
  const pending = new Map<string, Promise<void>>();
  const ready: { id: bigint; c: Classified }[] = [];

  const flushSpawn = async () => {
    if (!ready.length) return;
    const batch = ready.splice(0);
    const todo = [];
    for (const b of batch) if (!(await creatureOf(b.id)).spawned) todo.push(b);
    if (!todo.length) return;
    const { hash } = await send("spawn", [todo.map((b) => b.id), todo.map((b) => b.c.cls), todo.map((b) => b.c.trait)]);
    for (const b of todo) {
      fx("spawned", {
        id: String(b.id),
        name: nameOf(b.id),
        cls: b.c.cls,
        trait: b.c.trait,
        boastTax: b.c.boast,
        catchphrase: b.c.catchphrase,
        tx: txUrl(hash),
      });
    }
    console.log(`[game ${g}] spawned ${todo.map((b) => `#${b.id}`).join(" ")}`);
  };

  while (true) {
    try {
      if (await lobbyTick()) return;
    } catch (e) {
      console.warn("[lobby]", (e as Error).message.split("\n")[0]);
    }
    await sleep(1000);
  }

  const realAccepted = new Set(
    [...meta.entries()].filter(([, m]) => !m.house && !m.bot && !m.rejected).map(([id]) => id),
  );

  async function lobbyTick(): Promise<boolean> {
    await pollLogs();
    for (const j of joinQueue.splice(0)) {
      if (j.gameId !== g || meta.has(String(j.id)) || pending.has(String(j.id))) continue;
      const bot = isBot(j.owner);
      if (!bot && realAccepted.size >= runtime.realLimit) {
        // 真人名额已满：不分类、不 spawn，开局时合约自动退回入场费
        meta.set(String(j.id), {
          cls: 0,
          trait: 0,
          boast: false,
          safe: true,
          name: "名额已满",
          emoji: "🚫",
          catchphrase: "开局时自动退款",
          persona: j.prompt,
          source: "fallback",
          prompt: j.prompt,
          owner: j.owner,
          house: false,
          rejected: true,
        });
        saveMeta(g);
        fx("full", { id: String(j.id), owner: j.owner, realLimit: runtime.realLimit });
        console.log(`[game ${g}] #${j.id} 真人名额已满（${runtime.realLimit}），开局时退款`);
        continue;
      }
      if (!bot) realAccepted.add(String(j.id));
      fx("joined", { id: String(j.id), owner: j.owner, prompt: j.prompt, bot });
      pending.set(
        String(j.id),
        classify(j.prompt).then((c) => {
          meta.set(String(j.id), { ...c, prompt: j.prompt, owner: j.owner, house: false, bot });
          saveMeta(g);
          ready.push({ id: j.id, c });
          console.log(`[game ${g}] #${j.id} "${j.prompt}" → ${CLASS_NAMES[c.cls]}/${TRAIT_NAMES[c.trait]} (${c.source} ${c.ms}ms)`);
          pending.delete(String(j.id));
        }),
      );
    }
    await flushSpawn().catch((e) => console.warn("[spawn]", e.message));

    const humans = [...meta.values()].filter((m) => !m.house && !m.rejected).length; // 含模拟用户
    const timeUp = cfg.autoStart && Date.now() >= lobbyEndsAt && humans >= 1;
    if (wantStart || timeUp) {
      wantStart = false;
      await Promise.race([Promise.all(pending.values()), sleep(cfg.classifyTimeoutMs + 1000)]);
      await flushSpawn().catch((e) => console.warn("[spawn]", e.message));
      const { lastReveal } = await readGlobal();
      const x0 = nextReveal(loadChainFor(lastReveal), lastReveal);
      try {
        const { hash, logs } = await send("start", [x0], 1.3);
        const ev = logs.find((l: any) => l.eventName === "Started") as any;
        console.log(`[game ${g}] start: ${ev.args.count} creatures, seed=${ev.args.seed} tx=${hash}`);
        fx("started", { count: Number(ev.args.count), seed: ev.args.seed, reveal: x0, tx: txUrl(hash) });
        lobbyEndsAt = 0;
        await refresh();
        return true;
      } catch (e) {
        console.warn("[start]", (e as Error).message.split("\n")[0]);
        lobbyEndsAt = Date.now() + 15_000;
      }
    }
    return false;
  }
}

function formula(a: any) {
  const m = Number(a.matchupBp) / 1e4;
  const parts = [`基础 ${a.base}`];
  if (m !== 1) parts.push(`克制 ${m}`);
  parts.push(`骰子 ${(Number(a.rollBp) / 1e4).toFixed(2)}`);
  if (a.crit) parts.push("暴击 1.5");
  if (a.hidden) parts.push("躲避");
  return `${parts.join(" × ")} = ${a.dmg}`;
}

async function playRound(g: number, roster: Roster, st: Awaited<ReturnType<typeof readGlobal>>) {
  const t0 = Date.now();
  const round = st.currentRound + 1;
  const board = new Board(roster, st.foodMask, round);
  const aliveIdx = roster.cs.map((c, i) => (c.alive ? i : -1)).filter((i) => i >= 0);
  const views = aliveIdx.map((i) => board.view(i));
  const personas = new Map(aliveIdx.map((i) => [i, meta.get(String(roster.ids[i]))?.persona ?? "一只普通的蛐蛐"]));
  const decided = await decideActions(views, personas);

  const types = roster.ids.map(() => 0);
  const args = roster.ids.map(() => 0);
  for (const d of decided.decisions) {
    const a = optionToAction(d.o)!;
    types[d.i] = a.t;
    args[d.i] = a.arg;
    if (d.say) {
      const m = meta.get(String(roster.ids[d.i]));
      if (m) m.lastSay = d.say;
    }
  }
  const llmMs = Date.now() - t0;
  fx("says", {
    round,
    lines: decided.decisions.filter((d) => d.say).map((d) => ({ id: String(roster.ids[d.i]), say: d.say, o: d.o })),
  });

  const chainC = loadChainFor(st.lastReveal);
  const reveal = nextReveal(chainC, st.lastReveal);
  const llmLog = JSON.stringify({ gameId: g, round, model: cfg.llm.model, ...decided });
  const llmLogHash = keccak256(toHex(llmLog));
  const dir = path.join(cfg.logsDir, String(g));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${round}.llm.json`), llmLog); // keccak256(文件字节) == 链上 llmLogHash

  const { hash, logs, rcpt } = await send("resolveRound", [round, types, args, reveal, llmLogHash], 1.3);

  const events: any[] = [];
  const report: string[] = [];
  let seed: Hex | null = null;
  for (const l of logs as any[]) {
    const a = l.args;
    switch (l.eventName) {
      case "Hit":
        events.push({ type: "hit", attacker: String(a.attacker), target: String(a.target), base: Number(a.base), matchupBp: Number(a.matchupBp), rollBp: Number(a.rollBp), crit: a.crit, hidden: a.hidden, dmg: Number(a.dmg), hpAfter: Number(a.hpAfter), formula: formula(a) });
        report.push(`${nameOf(a.attacker)} → ${nameOf(a.target)}：${formula(a)}${a.crit ? " 💥暴击" : ""}`);
        break;
      case "Died":
        events.push({ type: "died", id: String(a.id), killer: String(a.killer), cause: Number(a.cause) });
        report.push(`${nameOf(a.id)} 阵亡${a.killer ? `（凶手 ${nameOf(a.killer)}）` : Number(a.cause) === 3 ? "（毒圈）" : "（中毒）"}`);
        break;
      case "Taunted":
        events.push({ type: "taunted", attacker: String(a.attacker), intended: String(a.intended), taunter: String(a.taunter) });
        report.push(`${nameOf(a.taunter)} 的嘲讽生效，${nameOf(a.attacker)} 被迫改打它`);
        break;
      case "Ate":
        events.push({ type: "ate", id: String(a.id), heal: Number(a.heal) });
        break;
      case "Damaged":
        events.push({ type: "damaged", id: String(a.id), poison: Number(a.poisonDmg), zone: Number(a.zoneDmg) });
        break;
      case "CheerHealed":
        events.push({ type: "cheerHealed", id: String(a.id), heal: Number(a.heal) });
        break;
      case "Rejected":
        events.push({ type: "rejected", id: String(a.id), actionType: Number(a.actionType), arg: Number(a.arg) });
        break;
      case "RoundResolved":
        seed = a.seed;
        break;
    }
  }
  const result = {
    gameId: g,
    round,
    tx: hash,
    txUrl: txUrl(hash),
    block: Number(rcpt.blockNumber),
    gasUsed: Number(rcpt.gasUsed),
    reveal,
    seed,
    llmLogHash,
    llmMs,
    llmFallbacks: decided.decisions.filter((d) => d.source === "fallback").length,
    decisions: decided.decisions.map((d) => ({ ...d, id: String(roster.ids[d.i]) })),
    events,
  };
  fs.writeFileSync(path.join(dir, `${round}.json`), JSON.stringify(result, null, 1));
  saveMeta(g);
  fx("round", { round, tx: txUrl(hash), seed, reveal, llmLogHash, events, gasUsed: result.gasUsed });
  console.log(
    `[game ${g}] round ${round}: llm ${llmMs}ms (${result.llmFallbacks}/${views.length} fallback), ${events.filter((e) => e.type === "hit").length} hits, gas ${rcpt.gasUsed}, total ${Date.now() - t0}ms`,
  );

  narrate(report).then((text) => {
    if (!text) return;
    narrations.push(text);
    fx("narration", { round, text });
  });
  return t0;
}

async function running(g: number) {
  loadMeta(g);
  while (true) {
    const st = await readGlobal();
    if (st.phase !== Phase.Running) return;
    if (st.over) {
      const { hash, logs } = await send("finish", []);
      const a = (logs.find((l: any) => l.eventName === "Finished") as any).args;
      const id = String(a.winnerId);
      winner = {
        id,
        name: a.winnerId ? nameOf(a.winnerId) : "无人生还",
        owner: a.winner,
        house: a.winner === "0x0000000000000000000000000000000000000000",
        prize: formatEther(a.prize),
        tx: txUrl(hash),
      };
      console.log(`[game ${g}] finished: winner ${id} ${a.winner} prize ${formatEther(a.prize)} MON tx=${hash}`);
      fx("finished", winner as Record<string, unknown>);
      await refresh();
      return;
    }
    const roster = await getRoster(g);
    const t0 = await playRound(g, roster, st);
    await refresh().catch(() => {});
    const wait = cfg.roundMs - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
}

async function main() {
  console.log(`[engine] arena ${cfg.arena}, llm ${cfg.useLlm ? cfg.llm.model : "OFF (scripted)"}`);
  startServer(() => snapshot, {
    start: () => (wantStart = true),
    next: () => (wantNext = true),
    config: (q) => {
      if (q.realLimit !== undefined) runtime.realLimit = Math.max(0, Math.min(16, q.realLimit));
      if (q.botCount !== undefined) runtime.botCount = Math.max(0, Math.min(12, q.botCount));
      console.log(`[config] realLimit=${runtime.realLimit} botCount=${runtime.botCount}`);
      refresh().catch(() => {});
      return { ...runtime };
    },
  });
  startBots();
  setInterval(() => {
    pollLogs().then(() => refresh()).catch(() => {});
  }, 2000);

  while (true) {
    try {
      const st = await refresh();
      if (st.phase !== Phase.Lobby) joinQueue.length = 0;
      if (st.phase === Phase.Idle) await newGame();
      else if (st.phase === Phase.Lobby) await lobby(st.gameId);
      else if (st.phase === Phase.Running) await running(st.gameId);
      else {
        // Ended：等 /admin/new 或自动开下一局
        const endedAt = Date.now();
        while (!wantNext && !(cfg.autoNextSeconds && Date.now() - endedAt > cfg.autoNextSeconds * 1000)) await sleep(500);
        wantNext = false;
        await newGame();
      }
    } catch (e) {
      console.error("[engine] error, retrying in 2s:", (e as Error).message.split("\n").slice(0, 2).join(" | "));
      await sleep(2000);
    }
  }
}

main();
