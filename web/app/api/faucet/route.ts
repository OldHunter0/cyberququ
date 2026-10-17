// 给玩家临时钱包发测试币。防滥用：
// 1) 对方余额已经 ≥ MIN_BALANCE 就不发（无状态，换实例也有效）
// 2) 每个 IP 最多 PER_IP 次（内存，进程级）
// 3) 进程累计发放不超过 FAUCET_MAX_TOTAL
import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, createWalletClient, formatEther, http, isAddress, parseEther, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { monadTestnet, RPC } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AMOUNT = parseEther(process.env.FAUCET_AMOUNT ?? "0.1");
const MIN_BALANCE = parseEther(process.env.FAUCET_MIN_BALANCE ?? "0.05");
const MAX_TOTAL = parseEther(process.env.FAUCET_MAX_TOTAL ?? "5");
const PER_IP = Number(process.env.FAUCET_PER_IP ?? 3);

const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC, { retryCount: 3 }) });
const account = process.env.FAUCET_PK ? privateKeyToAccount(process.env.FAUCET_PK as Hex, { nonceManager }) : null;
const wallet = account ? createWalletClient({ chain: monadTestnet, transport: http(RPC, { retryCount: 3 }), account }) : null;

const perIp = new Map<string, number>();
let sentTotal = 0n;

export async function POST(req: NextRequest) {
  if (!wallet || !account) return NextResponse.json({ error: "faucet not configured (FAUCET_PK)" }, { status: 500 });
  const { address } = await req.json().catch(() => ({}));
  if (typeof address !== "string" || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });

  const balance = await pub.getBalance({ address });
  if (balance >= MIN_BALANCE) return NextResponse.json({ ok: true, skipped: true, balance: formatEther(balance) });

  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const n = perIp.get(ip) ?? 0;
  if (n >= PER_IP) return NextResponse.json({ error: "这台设备领太多次啦" }, { status: 429 });
  if (sentTotal + AMOUNT > MAX_TOTAL) return NextResponse.json({ error: "水龙头今天发完了，找工作人员" }, { status: 429 });
  perIp.set(ip, n + 1);
  sentTotal += AMOUNT;

  try {
    const hash = await wallet.sendTransaction({ to: address, value: AMOUNT, gas: 21_000n });
    await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    return NextResponse.json({ ok: true, hash, amount: formatEther(AMOUNT) });
  } catch (e) {
    perIp.set(ip, n);
    sentTotal -= AMOUNT;
    return NextResponse.json({ error: (e as Error).message.split("\n")[0] }, { status: 500 });
  }
}
