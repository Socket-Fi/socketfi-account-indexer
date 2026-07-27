import type { Network } from "../config/env.js";
import { decodeScVal, normalizeNative } from "../utils/scval.js";
import type { ParsedEvent, RpcEvent } from "./types.js";

export function parseEvent(network: Network, raw: RpcEvent, eventIndex: number): ParsedEvent {
  return {
    network,
    eventIndex,
    contractId: raw.contractId,
    txHash: raw.txHash,
    ledger: BigInt(raw.ledger),
    ledgerClosedAt: raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt) : undefined,
    topics: raw.topic.map((topic) => normalizeNative(decodeScVal(topic))),
    data: normalizeNative(decodeScVal(raw.value)),
    raw,
  };
}

export function eventAction(topics: unknown[]): string {
  const first = String(topics[0] ?? "").toLowerCase();
  return first;
}
