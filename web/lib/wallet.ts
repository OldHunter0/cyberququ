"use client";
import { createWalletClient, http, type Hex } from "viem";
import { generatePrivateKey, nonceManager, privateKeyToAccount } from "viem/accounts";
import { monadTestnet, RPC } from "./chain";

const KEY = "arena.pk";

/** 临时钱包：私钥只存在这台手机的 localStorage 里 */
export function loadWallet() {
  let pk = localStorage.getItem(KEY) as Hex | null;
  if (!pk) {
    pk = generatePrivateKey();
    localStorage.setItem(KEY, pk);
  }
  const account = privateKeyToAccount(pk, { nonceManager });
  const wallet = createWalletClient({ chain: monadTestnet, transport: http(RPC, { retryCount: 2 }), account });
  return { account, wallet };
}
