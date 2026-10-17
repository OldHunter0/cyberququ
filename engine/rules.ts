// 合约规则的 TS 镜像：只用来给 LLM 生成"局部视野 + 合法选项"和兜底行动。
// 真正的结算永远在链上，这里算错最多导致某个行动被合约判为原地不动。
import type { Creature, Roster } from "./chain.ts";

export const MAP = 12;
export const CLASS_NAMES = ["猛攻", "坚守", "敏捷"];
export const CLASS_EMOJI = ["🔥", "🛡", "💨"];
export const TRAIT_NAMES = ["囤粮", "狂暴", "龟缩", "嗜血", "毒刺", "社牛", "自大"];
export const STANCE_NAMES = ["进攻", "苟住", "觅食"];
export const BOAST = 6;

export const ACT = { STAY: 0, MOVE: 1, ATTACK: 2, EAT: 3, HIDE: 4 } as const;
const DIRS = [
  { code: "N", dx: 0, dy: -1, arg: 0 },
  { code: "E", dx: 1, dy: 0, arg: 1 },
  { code: "S", dx: 0, dy: 1, arg: 2 },
  { code: "W", dx: -1, dy: 0, arg: 3 },
];

export type Action = { t: number; arg: number };
export type Option = string; // "A3" | "N" | "E" | "S" | "W" | "EAT" | "HIDE" | "STAY"

export function zoneRing(round: number) {
  if (round < 5) return 0;
  return Math.min(Math.floor((round - 5) / 3) + 1, 5);
}

export const inZone = (x: number, y: number, ring: number) =>
  x >= ring && y >= ring && x <= MAP - 1 - ring && y <= MAP - 1 - ring;

export function foodTiles(mask: bigint): [number, number][] {
  const out: [number, number][] = [];
  for (let t = 0; t < MAP * MAP; t++) if ((mask >> BigInt(t)) & 1n) out.push([t % MAP, Math.floor(t / MAP)]);
  return out;
}

export function optionToAction(o: Option): Action | null {
  if (o === "STAY") return { t: ACT.STAY, arg: 0 };
  if (o === "EAT") return { t: ACT.EAT, arg: 0 };
  if (o === "HIDE") return { t: ACT.HIDE, arg: 0 };
  const d = DIRS.find((d) => d.code === o);
  if (d) return { t: ACT.MOVE, arg: d.arg };
  const m = /^A(\d+)$/.exec(o);
  if (m) return { t: ACT.ATTACK, arg: Number(m[1]) };
  return null;
}

const cheb = (a: Creature, b: Creature) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export type View = {
  i: number;
  cls: string;
  trait: string;
  hp: number;
  maxHp: number;
  stance: string;
  pos: [number, number];
  inSafeZone: boolean;
  safeZone: [number, number]; // 本回合结束时的安全区 [min,max]
  enemies: { i: number; dx: number; dy: number; cls: string; hp: number; boast: boolean }[];
  food: [number, number][]; // 相对坐标
  options: Option[];
  hint: Option; // 脚本 AI 的建议
};

export class Board {
  occ = new Map<number, number>(); // tile → roster index
  food: [number, number][];
  ring: number;

  constructor(
    public roster: Roster,
    foodMask: bigint,
    public round: number,
  ) {
    roster.cs.forEach((c, i) => c.alive && this.occ.set(c.y * MAP + c.x, i));
    this.food = foodTiles(foodMask);
    this.ring = zoneRing(round);
  }

  private free(x: number, y: number) {
    return x >= 0 && y >= 0 && x < MAP && y < MAP && !this.occ.has(y * MAP + x);
  }

  options(i: number): Option[] {
    const c = this.roster.cs[i];
    const opts: Option[] = [];
    this.roster.cs.forEach((o, j) => {
      if (j !== i && o.alive && cheb(c, o) === 1) opts.push(`A${j}`);
    });
    for (const d of DIRS) if (this.free(c.x + d.dx, c.y + d.dy)) opts.push(d.code);
    if (this.food.some(([fx, fy]) => fx === c.x && fy === c.y)) opts.push("EAT");
    opts.push("HIDE", "STAY");
    return opts;
  }

  view(i: number): View {
    const c = this.roster.cs[i];
    const enemies = this.roster.cs
      .map((o, j) => ({ o, j }))
      .filter(({ o, j }) => j !== i && o.alive && cheb(c, o) <= 2)
      .map(({ o, j }) => ({ i: j, dx: o.x - c.x, dy: o.y - c.y, cls: CLASS_NAMES[o.cls], hp: o.hp, boast: o.trait === BOAST }));
    const food = this.food
      .filter(([fx, fy]) => Math.abs(fx - c.x) <= 3 && Math.abs(fy - c.y) <= 3)
      .map(([fx, fy]) => [fx - c.x, fy - c.y] as [number, number]);
    return {
      i,
      cls: CLASS_NAMES[c.cls],
      trait: TRAIT_NAMES[c.trait],
      hp: c.hp,
      maxHp: c.maxHp,
      stance: STANCE_NAMES[this.roster.stances[i]] ?? "进攻",
      pos: [c.x, c.y],
      inSafeZone: inZone(c.x, c.y, this.ring),
      safeZone: [this.ring, MAP - 1 - this.ring],
      enemies,
      food,
      options: this.options(i),
      hint: this.fallback(i),
    };
  }

  /** 朝目标走一步：优先缩短距离更大的那个轴，被挡就换轴 */
  private toward(i: number, tx: number, ty: number, away = false): Option | null {
    const c = this.roster.cs[i];
    const s = away ? -1 : 1;
    const dx = (tx - c.x) * s;
    const dy = (ty - c.y) * s;
    const xs = dx > 0 ? "E" : dx < 0 ? "W" : null;
    const ys = dy > 0 ? "S" : dy < 0 ? "N" : null;
    const order = Math.abs(dx) >= Math.abs(dy) ? [xs, ys] : [ys, xs];
    const opts = this.options(i);
    for (const o of order) if (o && opts.includes(o)) return o;
    return null;
  }

  private nearestEnemy(i: number) {
    const c = this.roster.cs[i];
    let best = -1;
    let bestD = Infinity;
    this.roster.cs.forEach((o, j) => {
      if (j === i || !o.alive) return;
      const d = cheb(c, o);
      if (d < bestD) [best, bestD] = [j, d];
    });
    return best;
  }

  private nearestFood(i: number): [number, number] | null {
    const c = this.roster.cs[i];
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const f of this.food) {
      const d = Math.abs(f[0] - c.x) + Math.abs(f[1] - c.y);
      if (d < bestD) [best, bestD] = [f, d];
    }
    return best;
  }

  private bestTarget(i: number): Option | null {
    const attacks = this.options(i).filter((o) => o.startsWith("A"));
    if (!attacks.length) return null;
    const score = (o: Option) => {
      const t = this.roster.cs[Number(o.slice(1))];
      return (t.trait === BOAST ? -1000 : 0) + t.hp;
    };
    return attacks.sort((a, b) => score(a) - score(b))[0];
  }

  /** 姿态默认行动（LLM 超时 / 输出不合法时用）：进攻 → 打最近的敌人；苟住 → HIDE；觅食 → 走向食物 */
  fallback(i: number): Option {
    const c = this.roster.cs[i];
    const stance = this.roster.stances[i] ?? 0;
    const opts = this.options(i);
    const center = (MAP - 1) / 2;
    const attack = this.bestTarget(i);
    const outside = !inZone(c.x, c.y, zoneRing(this.round + 1));
    const hurt = c.hp < c.maxHp;
    // 本回合结束就要吃毒圈伤害：任何姿态都先往圈里走（走不动再说）
    if (!inZone(c.x, c.y, this.ring)) {
      const step = this.toward(i, center, center);
      if (step) return step;
    }

    if (stance === 0) {
      if (attack) return attack;
      if (outside) return this.toward(i, center, center) ?? "STAY";
      const e = this.nearestEnemy(i);
      if (e >= 0) return this.toward(i, this.roster.cs[e].x, this.roster.cs[e].y) ?? "STAY";
      return "STAY";
    }
    if (outside) return this.toward(i, center, center) ?? "HIDE";
    if (stance === 1) {
      if (attack) return "HIDE";
      if (hurt && opts.includes("EAT")) return "EAT";
      return "HIDE";
    }
    // 觅食
    if (hurt && opts.includes("EAT")) return "EAT";
    const f = this.nearestFood(i);
    if (f && !(f[0] === c.x && f[1] === c.y)) {
      const step = this.toward(i, f[0], f[1]);
      if (step) return step;
    }
    return attack ?? (opts.includes("EAT") ? "EAT" : "STAY");
  }
}
