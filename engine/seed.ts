// 哈希链承诺：chain[0] = s，chain[i+1] = keccak256(chain[i])，anchor = chain[K] 上链。
// start 揭示 chain[K-1]，第 r 回合揭示 chain[K-1-r]。合约检查 keccak256(x) == lastReveal。
// 秘密 s 只存在 engine/secrets/（已 gitignore），用于崩溃后续跑。
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { cfg } from "./config.ts";

export const K = 40;

export type HashChain = { secret: Hex; chain: Hex[] };

export function makeChain(secret: Hex = toHex(randomBytes(32))): HashChain {
  const chain: Hex[] = [secret];
  for (let i = 1; i <= K; i++) chain.push(keccak256(chain[i - 1]));
  return { secret, chain };
}

export const anchorOf = (c: HashChain) => c.chain[K];

/** 链上 lastReveal = chain[i] 时，下一个揭示值是 chain[i-1] */
export function nextReveal(c: HashChain, lastReveal: Hex): Hex {
  const i = c.chain.findIndex((h) => h.toLowerCase() === lastReveal.toLowerCase());
  if (i <= 0) throw new Error(`hash chain exhausted or mismatched (index ${i})`);
  return c.chain[i - 1];
}

export function saveChain(c: HashChain) {
  fs.mkdirSync(cfg.secretsDir, { recursive: true });
  const file = path.join(cfg.secretsDir, `${anchorOf(c)}.json`);
  fs.writeFileSync(file, JSON.stringify({ secret: c.secret, anchor: anchorOf(c), createdAt: Date.now() }), {
    mode: 0o600,
  });
}

/** 找到包含当前 lastReveal 的那条链（引擎重启后续跑用） */
export function loadChainFor(lastReveal: Hex): HashChain {
  const files = fs.existsSync(cfg.secretsDir) ? fs.readdirSync(cfg.secretsDir) : [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const { secret } = JSON.parse(fs.readFileSync(path.join(cfg.secretsDir, f), "utf8"));
    const c = makeChain(secret);
    if (c.chain.some((h) => h.toLowerCase() === lastReveal.toLowerCase())) return c;
  }
  throw new Error(`no local secret matches lastReveal ${lastReveal}`);
}
