import type { Network } from "../config/env.js";

export interface RpcEvent {
  type: string;
  ledger: number;
  ledgerClosedAt?: string;
  contractId?: string;
  id: string;
  pagingToken?: string;
  topic: string[];
  value: string;
  txHash: string;
  inSuccessfulContractCall?: boolean;
}

export interface RpcEventsResult {
  events: RpcEvent[];
  latestLedger: number;
  cursor?: string;
}

export interface RpcTransactionItem {
  status: "SUCCESS" | "FAILED" | string;
  txHash: string;
  applicationOrder?: number;
  feeBump?: boolean;
  envelopeXdr: string;
  resultXdr?: string;
  resultMetaXdr?: string;
  diagnosticEventsXdr?: string[];
  ledger: number;
  createdAt?: number | string;
}

export interface RpcTransactionsResult {
  transactions: RpcTransactionItem[];
  latestLedger: number;
  latestLedgerCloseTime?: string;
  oldestLedger?: number;
  oldestLedgerCloseTime?: string;
  cursor?: string;
}

export interface ParsedInvocation {
  operationIndex: number;
  sourceAccount?: string;
  contractId?: string;
  functionName?: string;
  args: unknown[];
  authAddresses: string[];
  memoType?: string;
  memoValue?: string;
}

export interface ParsedEvent {
  network: Network;
  eventIndex: number;
  contractId?: string;
  txHash: string;
  ledger: bigint;
  ledgerClosedAt?: Date;
  topics: unknown[];
  data: unknown;
  raw: RpcEvent;
}
