"use client";
// 手机页：临时钱包 → 自动领水 → 写一句人设进场 → 对局中切姿态 / 打气。所有交易直接从手机发上链。
import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, type Address } from "viem";
import {
  arena,
  CLASS_DESC,
  CLASS_EMOJI,
  CLASS_NAMES,
  PHASES,
  pub,
  STANCES,
  TRAIT_DESC,
  TRAIT_NAMES,
  txLink,
} from "@/lib/chain";
import { loadWallet } from "@/lib/wallet";

type C = {
  id: bigint;
  idx: number;
  owner: Address;
  hp: number;
  maxHp: number;
  cls: number;
  trait: number;
  alive: boolean;
  spawned: boolean;
  kills: number;
  poison: number;
  stance: number;
  cheers: number;
};

type G = {
  phase: number;
  gameId: number;
  round: number;
  entryFee: bigint;
  cheerFee: bigint;
  maxPlayers: number;
  playerCount: number;
  creatures: C[];
};

const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_PROMPT = 30;

async function readGame(): Promise<G> {
  const [phase, gameId, round, entryFee, cheerFee, maxPlayers] = await Promise.all([
    pub.readContract({ ...arena, functionName: "phase" }),
    pub.readContract({ ...arena, functionName: "gameId" }),
    pub.readContract({ ...arena, functionName: "currentRound" }),
    pub.readContract({ ...arena, functionName: "entryFee" }),
    pub.readContract({ ...arena, functionName: "cheerFee" }),
    pub.readContract({ ...arena, functionName: "maxPlayers" }),
  ]);
  const playerCount = Number(await pub.readContract({ ...arena, functionName: "playerCount", args: [gameId] }));
  let creatures: C[] = [];
  if (phase === 2 || phase === 3) {
    const [ids, cs, owners, cheers, stances] = await pub.readContract({ ...arena, functionName: "getRoster", args: [gameId] });
    creatures = ids.map((id, i) => ({ ...(cs[i] as any), id, idx: i, owner: owners[i], cheers: Number(cheers[i]), stance: stances[i] }));
  } else if (phase === 1) {
    const ids = await pub.readContract({ ...arena, functionName: "getJoined", args: [gameId] });
    creatures = await Promise.all(
      ids.map(async (id, i) => {
        const [c, owner, cheers, stance] = await Promise.all([
          pub.readContract({ ...arena, functionName: "creatures", args: [id] }),
          pub.readContract({ ...arena, functionName: "ownerOf", args: [id] }),
          pub.readContract({ ...arena, functionName: "cheers", args: [id] }),
          pub.readContract({ ...arena, functionName: "stanceOf", args: [id] }),
        ]);
        const [, hp, maxHp, , , cls, trait, kills, poison, spawned, alive] = c;
        return { id, idx: i, owner, hp, maxHp, cls, trait, kills, poison, spawned, alive, cheers: Number(cheers), stance } as C;
      }),
    );
  }
  return {
    phase,
    gameId,
    round,
    entryFee,
    cheerFee,
    maxPlayers: Number(maxPlayers),
    playerCount,
    creatures,
  };
}

export default function Phone() {
  const w = useRef<ReturnType<typeof loadWallet> | null>(null);
  const [addr, setAddr] = useState<Address | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [g, setG] = useState<G | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tx?: string; err?: boolean } | null>(null);
  const [faucetTried, setFaucetTried] = useState(false);

  const refresh = useCallback(async () => {
    if (!w.current) return;
    try {
      const [b, game] = await Promise.all([pub.getBalance({ address: w.current.account.address }), readGame()]);
      setBalance(b);
      setG(game);
    } catch (e) {
      console.warn(e);
    }
  }, []);

  useEffect(() => {
    w.current = loadWallet();
    setAddr(w.current.account.address);
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  // 余额不够就自动领一次水
  useEffect(() => {
    if (!addr || balance === null || faucetTried) return;
    if (balance >= 50_000_000_000_000_000n) return;
    setFaucetTried(true);
    setMsg({ text: "正在领测试币…" });
    fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: addr }) })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setMsg({ text: `领水失败：${j.error}`, err: true });
        else setMsg({ text: j.skipped ? "余额够用" : `领到 ${j.amount} MON 🎉`, tx: j.hash });
        refresh();
      })
      .catch((e) => setMsg({ text: `领水失败：${e.message}`, err: true }));
  }, [addr, balance, faucetTried, refresh]);

  async function tx(label: string, functionName: string, args: unknown[], value?: bigint) {
    if (!w.current) return;
    setBusy(label);
    setMsg({ text: `${label}…` });
    try {
      const req = { ...arena, functionName, args, value, account: w.current.account } as any;
      // Monad 按 gas limit 收费：用估算值 ×1.3，不要写死大数
      const est = await pub.estimateContractGas(req);
      const hash = await w.current.wallet.writeContract({ ...req, gas: (est * 13n) / 10n });
      setMsg({ text: `${label}：已发送`, tx: hash });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
      setMsg({ text: r.status === "success" ? `${label}成功 ✅` : `${label}失败`, tx: hash, err: r.status !== "success" });
      refresh();
    } catch (e) {
      const m = (e as any).shortMessage ?? (e as Error).message;
      setMsg({ text: `${label}失败：${m.split("\n")[0]}`, err: true });
    } finally {
      setBusy(null);
    }
  }

  const mine = g?.creatures.filter((c) => addr && c.owner.toLowerCase() === addr.toLowerCase()) ?? [];
  const me = mine[mine.length - 1];
  const phase = g ? PHASES[g.phase] : "…";
  const canJoin = g?.phase === 1 && !me && g.playerCount < g.maxPlayers;
  // 合约只在大厅 / 对局中接受打气，且对局中只能给活着的打气
  const others =
    g && (g.phase === 1 || g.phase === 2) ? g.creatures.filter((c) => c.spawned && (g.phase === 1 || c.alive) && c.id !== me?.id) : [];

  return (
    <main className="mx-auto max-w-md px-4 pb-16 pt-5">
      <header className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">赛博斗蛐蛐 🦗</h1>
          <p className="text-xs text-white/50">一句话捏一只 AI 蛐蛐，链上开打</p>
        </div>
        <div className="shrink-0 text-right text-xs text-white/60">
          <div className="font-mono">{addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "…"}</div>
          <div className="text-base font-bold text-white">{balance === null ? "…" : Number(formatEther(balance)).toFixed(3)} MON</div>
        </div>
      </header>

      <div className="mb-4 flex gap-2 text-xs">
        <span className="rounded-full bg-white/10 px-3 py-1">第 {g?.gameId ?? "–"} 局</span>
        <span className="rounded-full bg-white/10 px-3 py-1">
          {phase === "Lobby" ? "🚪 进场中" : phase === "Running" ? `⚔️ 第 ${g?.round} 回合` : phase === "Ended" ? "🏁 已结束" : "⏳ 等待开局"}
        </span>
        {g && (
          <span className="rounded-full bg-white/10 px-3 py-1">
            玩家 {g.playerCount}/{g.maxPlayers}
          </span>
        )}
      </div>

      {msg && (
        <div className={`mb-4 rounded-xl px-4 py-3 text-sm ${msg.err ? "bg-red-500/20 text-red-200" : "bg-emerald-500/15 text-emerald-100"}`}>
          {msg.text}
          {msg.tx && (
            <a className="ml-2 underline opacity-70" href={txLink(msg.tx)} target="_blank">
              查看交易
            </a>
          )}
        </div>
      )}

      {canJoin && (
        <section className="mb-6 rounded-2xl bg-white/5 p-4">
          <h2 className="mb-2 text-lg font-bold">捏一只你的蛐蛐</h2>
          <p className="mb-3 text-xs text-white/50">
            人设只决定性格和职业，不决定强度。自称无敌的会被征收吹牛税 🧾
          </p>
          <textarea
            className="mb-2 h-24 w-full resize-none rounded-xl bg-black/40 p-3 text-base outline-none ring-1 ring-white/10 focus:ring-fuchsia-400"
            placeholder="例：武康路上一只胆小但很能吃的松鼠"
            value={prompt}
            maxLength={MAX_PROMPT}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="mb-3 text-right text-xs text-white/40">
            {prompt.length}/{MAX_PROMPT}
          </div>
          <button
            className="w-full rounded-xl bg-fuchsia-500 py-3 text-lg font-bold disabled:opacity-40"
            disabled={!prompt.trim() || !!busy || balance === null || balance < (g?.entryFee ?? 0n)}
            onClick={() => tx("进场", "join", [prompt.trim()], g!.entryFee)}
          >
            {busy === "进场" ? "进场中…" : `进场（${formatEther(g!.entryFee)} MON 入奖池）`}
          </button>
        </section>
      )}

      {!g && <p className="mb-6 animate-pulse text-center text-white/60">正在连接 Monad 测试网…</p>}

      {g?.phase === 1 && !me && !canJoin && <p className="mb-6 text-center text-white/60">本局已满员，等下一局吧</p>}
      {(g?.phase === 0 || (g?.phase === 3 && !me)) && <p className="mb-6 text-center text-white/60">等待下一局开始…</p>}

      {me && (
        <section className="mb-6 rounded-2xl bg-gradient-to-br from-fuchsia-500/20 to-indigo-500/20 p-4 ring-1 ring-white/10">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-bold">我的蛐蛐 #{String(me.id)}</h2>
            <span className="text-sm">
              {!me.spawned ? "🔮 AI 正在读你的人设…（若真人名额已满，开局时自动退款）" : g?.phase === 1 ? "✅ 已就位" : me.alive ? "💪 战斗中" : "💀 阵亡"}
            </span>
          </div>
          {me.spawned && (
            <>
              <div className="mb-1 text-2xl font-black">
                {CLASS_EMOJI[me.cls]} {CLASS_NAMES[me.cls]} · {TRAIT_NAMES[me.trait]}
                {me.trait === 6 && <span className="ml-2 align-middle text-sm text-amber-300">🧾 吹牛税</span>}
              </div>
              <div className="mb-3 text-xs text-white/60">
                {CLASS_DESC[me.cls]}；{TRAIT_DESC[me.trait]}
              </div>
              <div className="mb-1 flex justify-between text-xs">
                <span>HP</span>
                <span>
                  {me.hp}/{me.maxHp} {me.poison > 0 && "☠️中毒"} {me.kills > 0 && `🗡×${me.kills}`}
                </span>
              </div>
              <div className="mb-4 h-3 overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full bg-gradient-to-r from-emerald-400 to-lime-300 transition-all"
                  style={{ width: `${(100 * me.hp) / Math.max(1, me.maxHp)}%` }}
                />
              </div>
            </>
          )}
          {(g?.phase === 1 || (g?.phase === 2 && me.alive)) && (
            <>
              <div className="mb-2 text-sm font-bold">战术姿态（AI 下回合必须听你的）</div>
              <div className="mb-3 grid grid-cols-3 gap-2">
                {STANCES.map((s, k) => (
                  <button
                    key={k}
                    disabled={!!busy}
                    onClick={() => tx(`切换为${s.name}`, "setStance", [me.id, k])}
                    className={`rounded-xl py-3 text-center ${me.stance === k ? "bg-white text-black" : "bg-white/10"}`}
                  >
                    <div className="text-2xl">{s.emoji}</div>
                    <div className="text-sm font-bold">{s.name}</div>
                    <div className="text-[10px] opacity-60">{s.desc}</div>
                  </button>
                ))}
              </div>
              {me.spawned && (
                <button
                  disabled={!!busy}
                  onClick={() => tx("打气", "cheer", [me.id], g!.cheerFee)}
                  className="w-full rounded-xl bg-amber-400 py-3 text-lg font-bold text-black disabled:opacity-40"
                >
                  📣 给自己打气 +5HP（{formatEther(g!.cheerFee)} MON）
                </button>
              )}
            </>
          )}
        </section>
      )}

      {others.length > 0 && (
        <section className="rounded-2xl bg-white/5 p-4">
          <h2 className="mb-1 text-lg font-bold">给别人打气</h2>
          <p className="mb-3 text-xs text-white/50">打气费进奖池，扶弱者翻盘。每回合每只最多吃 3 次。</p>
          <ul className="space-y-2">
            {others.map((c) => (
              <li key={String(c.id)} className="flex items-center justify-between rounded-xl bg-black/30 px-3 py-2">
                <div>
                  <div className="text-sm font-bold">
                    #{String(c.id)} {CLASS_EMOJI[c.cls]}
                    {CLASS_NAMES[c.cls]}·{TRAIT_NAMES[c.trait]} {c.owner === ZERO && <span className="text-xs text-white/40">庄家</span>}
                  </div>
                  <div className="text-xs text-white/50">
                    HP {c.hp}/{c.maxHp} · 📣{c.cheers}
                  </div>
                </div>
                <button
                  disabled={!!busy}
                  onClick={() => tx(`给 #${c.id} 打气`, "cheer", [c.id], g!.cheerFee)}
                  className="rounded-lg bg-amber-400/90 px-3 py-2 text-sm font-bold text-black disabled:opacity-40"
                >
                  📣 打气
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-8 text-center text-[10px] text-white/30">
        Monad Testnet · 合约 {arena.address.slice(0, 8)}… · 规则与随机数全部链上执行
      </footer>
    </main>
  );
}
