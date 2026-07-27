import { networkConfig, type Network } from "../config/env.js";

let requestId = 0;

export async function rpcCall<T>(network: Network, method: string, params: unknown): Promise<T> {
  const response = await fetch(networkConfig[network].rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });
  const payload = await response.json() as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (!response.ok || payload.error) {
    throw new Error(payload.error ? `RPC ${method} failed (${payload.error.code}): ${payload.error.message}${payload.error.data ? ` — ${JSON.stringify(payload.error.data)}` : ""}` : `RPC ${method} failed with HTTP ${response.status}`);
  }
  if (payload.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return payload.result;
}

export interface RpcHealth { status: string; latestLedger: number; oldestLedger: number; ledgerRetentionWindow: number; }
export const getHealth = (network: Network) => rpcCall<RpcHealth>(network, "getHealth", {});
