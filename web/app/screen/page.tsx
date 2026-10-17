"use client";
// 大屏：订阅笔记本上引擎的 SSE（snapshot 全量 + fx 特效），数值全部来自链上事件。
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { CLASS_EMOJI, CLASS_NAMES, ENGINE_URL, STANCES, TRAIT_NAMES } from "@/lib/chain";

type Cr = {
  id: string;
  idx: number;
  owner: string;
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
  cheers?: number;
  stance?: number;
  name?: string;
  emoji?: string;
  catchphrase?: string;
  persona?: string;
  house?: boolean;
  bot?: boolean;
  rejected?: boolean;
  lastSay?: string;
};

type Snap = {
  arena: string;
  explorer: string;
  phase: "Idle" | "Lobby" | "Running" | "Ended" | "loading";
  gameId: number;
  round: number;
  maxRounds: number;
  zoneRing: number;
  nextZoneRing: number;
  lobbyEndsAt: number;
  pot: string;
  food: [number, number][];
  creatures: Cr[];
  classDist: number[];
  alive: number;
  playerTxPerSec: number;
  narrations: string[];
  winner: { id: string; name: string; owner: string; house: boolean; prize: string; tx: string } | null;
  realLimit: number;
  realCount: number;
  botCount: number;
};

type Feed = { key: number; text: string; crit?: boolean; tx?: string; kind: string };
const MAP = 12;
let seq = 0;

export default function Screen() {
  const [s, setS] = useState<Snap | null>(null);
  const [bubbles, setBubbles] = useState<Record<string, { text: string; until: number }>>({});
  const [floats, setFloats] = useState<{ key: number; id: string; dmg: number; crit: boolean; until: number }[]>([]);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [toast, setToast] = useState<{ text: string; until: number } | null>(null);
  const [narr, setNarr] = useState<string>("");
  const [hitIds, setHitIds] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const [connected, setConnected] = useState(false);
  const [playUrl, setPlayUrl] = useState("");
  const snapRef = useRef<Snap | null>(null);

  useEffect(() => {
    setPlayUrl(process.env.NEXT_PUBLIC_PLAY_URL ?? window.location.origin);
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const es = new EventSource(`${ENGINE_URL}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const nameOf = (id: string) => {
      const c = snapRef.current?.creatures.find((c) => c.id === id);
      return c ? `${c.emoji ?? CLASS_EMOJI[c.cls]}${c.name ?? `#${id}`}` : `#${id}`;
    };
    const push = (f: Omit<Feed, "key">) => setFeed((xs) => [{ ...f, key: ++seq }, ...xs].slice(0, 9));

    let backfilled = false;
    es.addEventListener("snapshot", (e) => {
      const snap = JSON.parse((e as MessageEvent).data) as Snap;
      snapRef.current = snap;
      setS(snap);
      if (!backfilled) {
        backfilled = true;
        const hits: Feed[] = [];
        for (const f of (snap as any).recent ?? []) {
          if (f.type !== "round") continue;
          for (const ev of f.events) {
            if (ev.type === "hit") hits.unshift({ key: ++seq, kind: "hit", crit: ev.crit, tx: f.tx, text: `${nameOf(ev.attacker)} → ${nameOf(ev.target)}：${ev.formula}` });
            else if (ev.type === "died") hits.unshift({ key: ++seq, kind: "died", text: `💀 ${nameOf(ev.id)} 阵亡` });
          }
        }
        setFeed(hits.slice(0, 9));
      }
      if (snap.narrations?.length) setNarr((n) => n || snap.narrations[snap.narrations.length - 1]);
    });
    es.addEventListener("fx", (e) => {
      const f = JSON.parse((e as MessageEvent).data);
      const t = Date.now();
      switch (f.type) {
        case "says":
          setBubbles((b) => {
            const nb = { ...b };
            for (const l of f.lines) nb[l.id] = { text: l.say, until: t + 5000 };
            return nb;
          });
          break;
        case "round":
          for (const ev of f.events) {
            if (ev.type === "hit") {
              setFloats((xs) => [...xs.filter((x) => x.until > t), { key: ++seq, id: ev.target, dmg: ev.dmg, crit: ev.crit, until: t + 1400 }]);
              setHitIds((h) => ({ ...h, [ev.target]: t + 800 }));
              push({ kind: "hit", text: `${nameOf(ev.attacker)} → ${nameOf(ev.target)}：${ev.formula}`, crit: ev.crit, tx: f.tx });
            } else if (ev.type === "died") {
              push({ kind: "died", text: `💀 ${nameOf(ev.id)} 阵亡${ev.cause === 3 ? "（毒圈）" : ev.cause === 2 ? "（中毒）" : ""}` });
            } else if (ev.type === "taunted") {
              push({ kind: "taunt", text: `🧾 ${nameOf(ev.taunter)} 嘲讽生效！${nameOf(ev.attacker)} 被迫改打它` });
            } else if (ev.type === "cheerHealed") {
              push({ kind: "cheer", text: `📣 ${nameOf(ev.id)} 吃到打气 +${ev.heal}HP` });
            }
          }
          break;
        case "narration":
          setNarr(f.text);
          break;
        case "spawned":
          if (f.boastTax) setToast({ text: `🧾 检测到吹牛！${f.name} 已被征收吹牛税`, until: t + 4000 });
          else setToast({ text: `${f.name} 入场：「${f.catchphrase ?? ""}」`, until: t + 3000 });
          break;
        case "full":
          setToast({ text: `🚫 真人名额已满（${f.realLimit} 人），入场费开局时自动退回`, until: t + 4000 });
          break;
        case "cheer":
          setBubbles((b) => ({ ...b, [`cheer-${f.id}`]: { text: "📣", until: t + 1200 } }));
          break;
        case "stance":
          push({ kind: "stance", text: `${f.name} 切换为「${f.stanceName}」` });
          break;
        case "started":
          setToast({ text: "⚔️ 开打！", until: t + 2500 });
          setFeed([]);
          break;
        case "newGame":
          setFeed([]);
          setNarr("");
          break;
      }
    });
    return () => es.close();
  }, []);

  const admin = (p: string) => fetch(`${ENGINE_URL}/admin/${p}`, { method: "POST" });
  const tune = (q: string) => admin(`config?${q}`);

  if (!s || s.phase === "loading")
    return (
      <div className="flex h-screen items-center justify-center text-2xl text-white/50">
        {connected ? "加载中…" : `连接引擎 ${ENGINE_URL} …`}
      </div>
    );

  const live = s.creatures.filter((c) => c.spawned);
  const ranking = [...live].sort((a, b) => Number(b.alive) - Number(a.alive) || b.hp - a.hp || b.kills - a.kills);
  const lobbyLeft = s.lobbyEndsAt ? Math.max(0, Math.ceil((s.lobbyEndsAt - now) / 1000)) : 0;
  const totalCls = Math.max(1, s.classDist.reduce((a, b) => a + b, 0));

  return (
    <div className="flex h-screen w-screen gap-5 overflow-hidden p-5">
      {/* 左：地图 / 大厅 */}
      <div className="flex flex-1 flex-col">
        <div className="mb-3 flex items-center gap-4">
          <h1 className="text-4xl font-black">赛博斗蛐蛐 🦗</h1>
          <Badge>第 {s.gameId} 局</Badge>
          <Badge>
            {s.phase === "Lobby" ? `🚪 进场中 ${lobbyLeft}s` : s.phase === "Running" ? `⚔️ 回合 ${s.round}/${s.maxRounds}` : s.phase === "Ended" ? "🏁 结束" : "⏳"}
          </Badge>
          <Badge>💰 奖池 {Number(s.pot).toFixed(3)} MON</Badge>
          <Badge>❤️ 存活 {s.phase === "Lobby" ? live.length : s.alive}</Badge>
          <Badge>⚡ 玩家 TPS {s.playerTxPerSec.toFixed(1)}</Badge>
          {!connected && <Badge>🔌 断线重连中</Badge>}
        </div>

        {s.phase === "Lobby" || s.phase === "Idle" ? (
          <Lobby s={s} playUrl={playUrl} />
        ) : (
          <div className="relative flex-1">
            <Board s={s} bubbles={bubbles} floats={floats} hitIds={hitIds} now={now} />
          </div>
        )}
      </div>

      {/* 右：信息栏 */}
      <div className="flex w-[34%] min-w-[420px] flex-col gap-4">
        <Panel title="🎙 解说">
          <p className="pop text-2xl font-bold leading-snug" key={narr}>
            {narr || "等待开打…"}
          </p>
        </Panel>

        <Panel title="🗡 逐刀计算（链上 Hit 事件）" grow>
          <ul className="space-y-1.5">
            {feed.map((f) => (
              <li key={f.key} className={`pop text-[17px] leading-snug ${f.crit ? "text-amber-300" : f.kind === "died" ? "text-red-300" : f.kind === "taunt" ? "text-fuchsia-300" : ""}`}>
                {f.text}
                {f.crit && " 💥"}
              </li>
            ))}
            {!feed.length && <li className="text-white/40">伤害 = (ATK×4 − DEF) × 克制 × 骰子(0.8–1.2) × 暴击</li>}
          </ul>
        </Panel>

        <div className="grid grid-cols-2 gap-4">
          <Panel title="🏆 排行">
            <ol className="space-y-1 text-[15px]">
              {ranking.slice(0, 8).map((c, i) => (
                <li key={c.id} className={`flex justify-between ${c.alive || s.phase === "Lobby" ? "" : "opacity-35 line-through"}`}>
                  <span className="truncate">
                    {i + 1}. {c.emoji ?? CLASS_EMOJI[c.cls]} {c.name ?? `#${c.id}`}
                  </span>
                  <span className="font-mono">
                    {c.hp}
                    {c.kills > 0 && ` 🗡${c.kills}`}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
          <Panel title="⚖️ 职业分布（克制环）">
            {[0, 1, 2].map((k) => (
              <div key={k} className="mb-2">
                <div className="flex justify-between text-sm">
                  <span>
                    {CLASS_EMOJI[k]} {CLASS_NAMES[k]}
                  </span>
                  <span>{s.classDist[k]}</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-white/10">
                  <div className={`h-full ${["bg-red-400", "bg-sky-400", "bg-emerald-400"][k]}`} style={{ width: `${(100 * s.classDist[k]) / totalCls}%` }} />
                </div>
              </div>
            ))}
            <p className="mt-1 text-xs text-white/50">🔥 猛攻 &gt; 💨 敏捷 &gt; 🛡 坚守 &gt; 🔥 猛攻</p>
          </Panel>
        </div>

        <div className="flex items-center justify-between text-xs text-white/40">
          <span className="font-mono">合约 {s.arena}</span>
          <span className="space-x-2">
            <span>
              真人 {s.realCount}/{s.realLimit}
              <button className="ml-1 rounded bg-white/10 px-1.5 hover:bg-white/20" onClick={() => tune(`realLimit=${s.realLimit - 1}`)}>−</button>
              <button className="ml-0.5 rounded bg-white/10 px-1.5 hover:bg-white/20" onClick={() => tune(`realLimit=${s.realLimit + 1}`)}>+</button>
            </span>
            <span>
              🤖 {s.botCount}
              <button className="ml-1 rounded bg-white/10 px-1.5 hover:bg-white/20" onClick={() => tune(`bots=${s.botCount - 1}`)}>−</button>
              <button className="ml-0.5 rounded bg-white/10 px-1.5 hover:bg-white/20" onClick={() => tune(`bots=${s.botCount + 1}`)}>+</button>
            </span>
            <button className="rounded bg-white/10 px-2 py-1 hover:bg-white/20" onClick={() => admin("start")}>
              立即开局
            </button>
            <button className="rounded bg-white/10 px-2 py-1 hover:bg-white/20" onClick={() => admin("new")}>
              下一局
            </button>
          </span>
        </div>
      </div>

      {toast && toast.until > now && (
        <div className="pop fixed left-1/2 top-24 -translate-x-1/2 rounded-2xl bg-amber-400 px-8 py-4 text-3xl font-black text-black shadow-2xl">
          {toast.text}
        </div>
      )}

      {s.phase === "Ended" && s.winner && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70">
          <div className="pop rounded-3xl bg-gradient-to-br from-amber-300 to-fuchsia-500 p-12 text-center text-black shadow-2xl">
            <div className="text-3xl font-bold">🏆 冠军</div>
            <div className="my-4 text-7xl font-black">{s.winner.name}</div>
            <div className="text-2xl font-bold">
              {s.winner.house ? "庄家获胜，奖池顺延到下一局！" : `奖池 ${s.winner.prize} MON 已自动打到 ${s.winner.owner.slice(0, 6)}…${s.winner.owner.slice(-4)}`}
            </div>
            <a className="mt-4 block text-lg underline" href={s.winner.tx} target="_blank">
              在浏览器查看发奖交易
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-white/10 px-4 py-1.5 text-lg font-bold">{children}</span>;
}

function Panel({ title, children, grow }: { title: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <section className={`overflow-hidden rounded-2xl bg-white/5 p-4 ring-1 ring-white/10 ${grow ? "min-h-0 flex-1" : ""}`}>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-white/50">{title}</h2>
      {children}
    </section>
  );
}

function Lobby({ s, playUrl }: { s: Snap; playUrl: string }) {
  return (
    <div className="flex flex-1 gap-6">
      <div className="flex flex-col items-center justify-center rounded-3xl bg-white p-8 text-black">
        {playUrl && <QRCodeSVG value={playUrl} size={360} />}
        <div className="mt-4 text-3xl font-black">扫码捏一只蛐蛐</div>
        <div className="mt-1 text-lg">一句话人设 · 0.01 MON 进场 · 冠军拿走奖池</div>
        <div className="mt-1 font-mono text-sm text-black/50">{playUrl}</div>
      </div>
      <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-hidden">
        {s.creatures.map((c) => (
          <div key={c.id} className="pop rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
            <div className="flex items-center gap-2">
              <span className="text-4xl">{c.emoji ?? "🥚"}</span>
              <div className="min-w-0">
                <div className="truncate text-lg font-bold">
                  {c.name ?? `#${c.id}`} {c.house && <span className="text-xs text-white/40">庄家</span>}
                  {c.bot && <span className="text-xs text-white/40">🤖</span>}
                </div>
                <div className="text-sm text-white/60">
                  {c.rejected ? (
                    "真人名额已满 · 开局自动退款"
                  ) : c.spawned ? (
                    <>
                      {CLASS_EMOJI[c.cls]}
                      {CLASS_NAMES[c.cls]} · {TRAIT_NAMES[c.trait]}
                      {c.trait === 6 && <span className="ml-1 text-amber-300">🧾吹牛税</span>}
                    </>
                  ) : (
                    "🔮 AI 解读人设中…"
                  )}
                </div>
              </div>
            </div>
            {c.catchphrase && <div className="mt-1 truncate text-sm text-white/80">「{c.catchphrase}」</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Board({
  s,
  bubbles,
  floats,
  hitIds,
  now,
}: {
  s: Snap;
  bubbles: Record<string, { text: string; until: number }>;
  floats: { key: number; id: string; dmg: number; crit: boolean; until: number }[];
  hitIds: Record<string, number>;
  now: number;
}) {
  const ring = s.zoneRing;
  const next = s.nextZoneRing;
  const food = new Set(s.food.map(([x, y]) => y * MAP + x));
  const pct = (v: number) => `${((v + 0.5) * 100) / MAP}%`;
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative aspect-square h-full max-h-full max-w-full">
        <div className="grid h-full w-full grid-cols-12 grid-rows-12 gap-[2px] rounded-2xl bg-white/5 p-[2px]">
          {Array.from({ length: MAP * MAP }, (_, t) => {
            const x = t % MAP;
            const y = Math.floor(t / MAP);
            const out = x < ring || y < ring || x > MAP - 1 - ring || y > MAP - 1 - ring;
            const soon = !out && (x < next || y < next || x > MAP - 1 - next || y > MAP - 1 - next);
            return (
              <div
                key={t}
                className={`flex items-center justify-center rounded-[4px] text-xl ${out ? "bg-red-900/50" : soon ? "bg-amber-900/30" : "bg-white/[0.04]"}`}
              >
                {food.has(t) && "🍖"}
              </div>
            );
          })}
        </div>
        {s.creatures
          .filter((c) => c.spawned)
          .map((c) => {
            const b = bubbles[c.id];
            const hit = (hitIds[c.id] ?? 0) > now;
            return (
              <div
                key={c.id}
                className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-all duration-700 ${c.alive ? "" : "opacity-25 grayscale"}`}
                style={{ left: pct(c.x), top: pct(c.y), width: `${100 / MAP}%`, zIndex: c.alive ? 10 : 1 }}
              >
                {b && b.until > now && c.alive && (
                  <div className="pop absolute bottom-full mb-1 whitespace-nowrap rounded-xl bg-white px-2.5 py-1 text-[15px] font-bold text-black shadow-lg">
                    {b.text}
                  </div>
                )}
                {(bubbles[`cheer-${c.id}`]?.until ?? 0) > now && <div className="pop absolute -right-1 -top-2 text-2xl">📣</div>}
                <div className={`text-[42px] leading-none ${hit ? "shake" : ""}`}>{c.alive ? (c.emoji ?? CLASS_EMOJI[c.cls]) : "💀"}</div>
                <div className="mt-0.5 h-1.5 w-[80%] overflow-hidden rounded-full bg-black/60">
                  <div
                    className={`h-full transition-all ${c.hp / c.maxHp > 0.5 ? "bg-emerald-400" : c.hp / c.maxHp > 0.25 ? "bg-amber-400" : "bg-red-500"}`}
                    style={{ width: `${(100 * c.hp) / Math.max(1, c.maxHp)}%` }}
                  />
                </div>
                <div className="mt-0.5 max-w-[140%] truncate text-[11px] font-bold text-white/85">
                  {c.name ?? `#${c.id}`}
                  {c.trait === 6 && "🧾"}
                  {c.poison > 0 && "☠️"}
                  {c.stance !== undefined && c.alive && <span className="opacity-60">{STANCES[c.stance]?.emoji}</span>}
                </div>
                {floats
                  .filter((f) => f.id === c.id && f.until > now)
                  .map((f) => (
                    <div
                      key={f.key}
                      className={`dmg-float absolute left-1/2 top-0 font-black ${f.crit ? "text-4xl text-amber-300" : "text-3xl text-red-400"}`}
                    >
                      -{f.dmg}
                    </div>
                  ))}
              </div>
            );
          })}
      </div>
    </div>
  );
}
