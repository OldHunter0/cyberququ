import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(ROOT, ".env"), quiet: true });

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env ${key} (see ${ROOT}/.env)`);
  return v;
}

const num = (key: string, dflt: number) => (process.env[key] ? Number(process.env[key]) : dflt);

export const cfg = {
  rpc: process.env.MONAD_RPC ?? "https://testnet-rpc.monad.xyz",
  operatorPk: need("OPERATOR_PK") as Hex,
  arena: need("ARENA_ADDRESS") as Address,
  explorer: process.env.EXPLORER_URL ?? "https://testnet.monadexplorer.com",
  llm: {
    baseUrl: need("OPENAI_BASE_URL").replace(/\/$/, ""),
    apiKey: need("OPENAI_API_KEY"),
    model: need("LLM_MODEL"),
  },
  port: num("ENGINE_PORT", 8787),
  adminToken: process.env.ADMIN_TOKEN ?? "",
  lobbySeconds: num("LOBBY_SECONDS", 60),
  autoStart: process.env.AUTO_START !== "0", // 0 = 只能用 POST /admin/start 开局
  autoNextSeconds: num("AUTO_NEXT_SECONDS", 0), // 0 = 结束后等 POST /admin/new
  roundMs: num("ROUND_MS", 8000),
  decideTimeoutMs: num("DECIDE_TIMEOUT_MS", 5000),
  classifyTimeoutMs: num("CLASSIFY_TIMEOUT_MS", 9000),
  narrateTimeoutMs: num("NARRATE_TIMEOUT_MS", 8000),
  decideBatch: num("DECIDE_BATCH", 8),
  houseCount: num("HOUSE_COUNT", 5),
  useLlm: process.env.USE_LLM !== "0", // 0 = 纯脚本 AI（调试用）
  botSeed: (process.env.BOT_SEED ?? "") as Hex,
  botFund: process.env.BOT_FUND ?? "0.5", // 机器人余额低于 1/3 时由运营方补到这个数
  logsDir: path.join(ROOT, "engine", "logs"),
  secretsDir: path.join(ROOT, "engine", "secrets"),
};

/** 运行中可通过 POST /admin/config 调整，不用重启 */
export const runtime = {
  realLimit: num("REAL_PLAYER_LIMIT", 2), // 每局真人名额，超出的不上场、开局时合约自动退款
  botCount: num("BOT_COUNT", 6), // 模拟用户数量
};
