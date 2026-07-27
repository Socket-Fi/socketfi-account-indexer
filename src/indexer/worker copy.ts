import { Prisma, type Network, type WalletAuthType } from "@prisma/client";
import { env, networkConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { collectStellarAddresses } from "../utils/scval.js";
import { rpcCall, getHealth } from "../services/rpc-client.js";
import { walletRegistry } from "../services/wallet-registry.js";
import { tokenMetadataService } from "../services/token-metadata.js";
import { priceService } from "../services/price-service.js";
import { classifyAction } from "./action.js";
import { parseEvent, eventAction } from "./event-parser.js";
import { parseInvocations } from "./transaction-parser.js";
import type {
  ParsedEvent,
  ParsedInvocation,
  RpcEvent,
  RpcEventsResult,
  RpcTransactionItem,
  RpcTransactionsResult,
} from "./types.js";

function objectRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

function optionalHex(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return null;
}

function factoryAuthType(data: Record<string, unknown>): WalletAuthType {
  const passkey = data.passkey != null;

  const stellar = data.stellar_signer != null || data.stellarSigner != null;

  const evm = data.evm_signer != null || data.evmSigner != null;

  const blsValue = data.bls_keys ?? data.blsKeys;

  const bls = Array.isArray(blsValue) && blsValue.length > 0;

  const count = Number(passkey) + Number(stellar) + Number(evm) + Number(bls);

  if (count > 1) {
    return "HYBRID";
  }

  if (passkey) {
    return "PASSKEY";
  }

  if (stellar) {
    return "STELLAR";
  }

  if (evm) {
    return "EVM";
  }

  if (bls) {
    return "BLS";
  }

  return "UNKNOWN";
}

function decimalAmount(atomic: string, decimals: number): string {
  const negative = atomic.startsWith("-");
  const digits = negative ? atomic.slice(1) : atomic;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction =
    decimals > 0 ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function transactionClosedAt(value: number | string | undefined): Date | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+$/.test(value)) {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function bigintString(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isInteger(value))
    return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  const record = objectRecord(value);
  for (const key of ["amount", "value", "0"]) {
    const candidate = bigintString(record[key]);
    if (candidate !== undefined) return candidate;
  }
  if (Array.isArray(value))
    for (const item of value) {
      const candidate = bigintString(item);
      if (candidate !== undefined) return candidate;
    }
  return undefined;
}

function normalizeAssetSymbol(symbol: string | null | undefined): string {
  const normalized = symbol?.trim();

  if (!normalized) {
    return "UNKNOWN";
  }

  if (normalized.toLowerCase() === "native") {
    return "XLM";
  }

  return normalized;
}

function movement(event: ParsedEvent, wallet: string) {
  const name = eventAction(event.topics);
  if (
    name !== "transfer" &&
    name !== "approve" &&
    name !== "mint" &&
    name !== "burn"
  )
    return undefined;
  const from =
    typeof event.topics[1] === "string" ? event.topics[1] : undefined;
  const to = typeof event.topics[2] === "string" ? event.topics[2] : undefined;
  const amountAtomic = bigintString(event.data);
  let direction: string | undefined;
  let counterparty: string | undefined;
  if (from === wallet && to === wallet) direction = "SELF";
  else if (from === wallet) {
    direction = "OUT";
    counterparty = to;
  } else if (to === wallet) {
    direction = "IN";
    counterparty = from;
  } else if (name === "approve" && from === wallet) {
    direction = "OUT";
    counterparty = to;
  } else return undefined;
  return { name, from, to, amountAtomic, direction, counterparty };
}

async function pagedEvents(
  network: Network,
  startLedger: number,
  endLedger: number
): Promise<RpcEvent[]> {
  const all: RpcEvent[] = [];
  let cursor: string | undefined;
  do {
    const result = await rpcCall<RpcEventsResult>(
      network,
      "getEvents",
      cursor
        ? {
            filters: [{ type: "contract" }],
            pagination: { limit: env.EVENT_PAGE_LIMIT, cursor },
          }
        : {
            startLedger,
            endLedger,
            filters: [{ type: "contract" }],
            pagination: { limit: env.EVENT_PAGE_LIMIT },
          }
    );
    all.push(...result.events);
    const next = result.cursor;
    cursor =
      next && next !== cursor && result.events.length === env.EVENT_PAGE_LIMIT
        ? next
        : undefined;
  } while (cursor);
  return all;
}

async function pagedTransactions(
  network: Network,
  ledger: number
): Promise<RpcTransactionItem[]> {
  const all: RpcTransactionItem[] = [];
  let cursor: string | undefined;
  do {
    const result = await rpcCall<RpcTransactionsResult>(
      network,
      "getTransactions",
      cursor
        ? {
            pagination: { limit: env.TX_PAGE_LIMIT, cursor },
          }
        : {
            startLedger: ledger,
            pagination: { limit: env.TX_PAGE_LIMIT },
          }
    );
    const rows = result.transactions.filter((tx) => tx.ledger === ledger);
    all.push(...rows);
    if (result.transactions.some((tx) => tx.ledger > ledger)) break;
    const next = result.cursor;
    cursor =
      next &&
      next !== cursor &&
      result.transactions.length === env.TX_PAGE_LIMIT
        ? next
        : undefined;
  } while (cursor);
  return all;
}

// async function ingestFactoryEvents(
//   network: Network,
//   events: ParsedEvent[]
// ): Promise<void> {
//   const factory = networkConfig[network].factoryContractId;
//   for (const event of events) {
//     if (event.contractId !== factory) continue;
//     if (
//       String(event.topics[0]).toLowerCase() !== "wallet" ||
//       String(event.topics[1]).toLowerCase() !== "creation"
//     )
//       continue;
//     const data = objectRecord(event.data);
//     const wallet = String(data.wallet || "");
//     if (!wallet.startsWith("C")) {
//       logger.warn(
//         { network, txHash: event.txHash, data },
//         "wallet creation event had no wallet address"
//       );
//       continue;
//     }
//     const blsKeys = data.bls_keys ?? data.blsKeys;
//     await walletRegistry.add({
//       network,
//       address: wallet,
//       factoryAddress: factory,
//       authType: factoryAuthType(data),
//       stellarSignerHex: optionalHex(data.stellar_signer ?? data.stellarSigner),
//       passkeyHex: optionalHex(data.passkey),
//       blsKeyCount: Array.isArray(blsKeys) ? blsKeys.length : 0,
//       creationTxHash: event.txHash,
//       createdAtLedger: event.ledger,
//       createdAtLedgerTime: event.ledgerClosedAt ?? null,
//     });
//   }
// }

async function ingestFactoryEvents(
  network: Network,
  events: ParsedEvent[]
): Promise<void> {
  const factory = networkConfig[network].factoryContractId;

  for (const event of events) {
    if (event.contractId !== factory) {
      continue;
    }

    if (
      String(event.topics[0] ?? "").toLowerCase() !== "account" ||
      String(event.topics[1] ?? "").toLowerCase() !== "creation"
    ) {
      continue;
    }

    const data = objectRecord(event.data);

    const account = String(data.account || "");

    if (!account.startsWith("C")) {
      logger.warn(
        {
          network,
          txHash: event.txHash,
          data,
        },
        "account creation event had no account address"
      );

      continue;
    }

    const blsKeys = data.bls_keys ?? data.blsKeys;

    await walletRegistry.add({
      network,
      address: account,
      factoryAddress: factory,
      authType: factoryAuthType(data),
      stellarSignerHex: optionalHex(data.stellar_signer ?? data.stellarSigner),
      evmSignerHex: optionalHex(data.evm_signer ?? data.evmSigner),
      passkeyHex: optionalHex(data.passkey),
      blsKeyCount: Array.isArray(blsKeys) ? blsKeys.length : 0,
      creationTxHash: event.txHash,
      createdAtLedger: event.ledger,
      createdAtLedgerTime: event.ledgerClosedAt ?? null,
    });
  }
}

function relevantWallets(
  network: Network,
  invocation: ParsedInvocation,
  events: ParsedEvent[]
): Set<string> {
  const wallets = new Set<string>();
  if (
    invocation.contractId &&
    walletRegistry.has(network, invocation.contractId)
  )
    wallets.add(invocation.contractId);
  for (const address of invocation.authAddresses)
    if (walletRegistry.has(network, address)) wallets.add(address);
  for (const event of events) {
    const addresses = collectStellarAddresses([event.topics, event.data]);
    for (const address of addresses)
      if (walletRegistry.has(network, address)) wallets.add(address);
  }
  return wallets;
}

async function saveForWallet(
  network: Network,
  walletAddress: string,
  tx: RpcTransactionItem,
  invocation: ParsedInvocation,
  txEvents: ParsedEvent[]
): Promise<void> {
  const wallet = await prisma.socketFiWallet.findUnique({
    where: { network_address: { network, address: walletAddress } },
  });
  if (!wallet) return;
  const matchingMovements = txEvents
    .map((event) => ({ event, parsed: movement(event, walletAddress) }))
    .filter((x) => x.parsed !== undefined) as Array<{
    event: ParsedEvent;
    parsed: NonNullable<ReturnType<typeof movement>>;
  }>;

  if (matchingMovements.length === 0) {
    await prisma.walletTransaction.upsert({
      where: {
        network_txHash_walletAddress_operationIndex_eventIndex: {
          network,
          txHash: tx.txHash,
          walletAddress,
          operationIndex: invocation.operationIndex,
          eventIndex: -1,
        },
      },
      create: {
        network,
        walletId: wallet.id,
        walletAddress,
        txHash: tx.txHash,
        ledger: BigInt(tx.ledger),
        ledgerClosedAt: transactionClosedAt(tx.createdAt),
        status: tx.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        successful: tx.status === "SUCCESS",
        actionType: classifyAction(invocation.functionName),
        functionName: invocation.functionName,
        invokedContract: invocation.contractId,
        sourceAccount: invocation.sourceAccount,
        operationIndex: invocation.operationIndex,
        eventIndex: -1,
        assetSymbol: "UNKNOWN",
        assetDecimals: 7,
        priceUsd: new Prisma.Decimal(0),
        valueUsd: new Prisma.Decimal(0),
        priceSource: "DEFAULT_ZERO",
        memoType: invocation.memoType,
        memoValue: invocation.memoValue,
        authAddresses: invocation.authAddresses,
        argumentsJson: invocation.args as Prisma.InputJsonValue,
        rawTransactionJson: tx as unknown as Prisma.InputJsonValue,
      },
      update: {
        status: tx.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        successful: tx.status === "SUCCESS",
        updatedAt: new Date(),
      },
    });
    return;
  }

  for (const { event, parsed } of matchingMovements) {
    const contract = event.contractId || invocation.contractId;
    const metadata = contract
      ? await tokenMetadataService.get(network, contract)
      : null;

    const assetSymbol = normalizeAssetSymbol(metadata?.symbol);
    const assetDecimals = metadata?.decimals ?? 7;

    const atomic = parsed.amountAtomic;
    const amountString = atomic
      ? decimalAmount(atomic, metadata?.decimals ?? 7)
      : undefined;
    const price = contract
      ? await priceService.getUsdPrice(network, contract)
      : { price: 0, source: "DEFAULT_ZERO" };
    const valueUsd = amountString ? Number(amountString) * price.price : 0;
    await prisma.walletTransaction.upsert({
      where: {
        network_txHash_walletAddress_operationIndex_eventIndex: {
          network,
          txHash: tx.txHash,
          walletAddress,
          operationIndex: invocation.operationIndex,
          eventIndex: event.eventIndex,
        },
      },
      create: {
        network,
        walletId: wallet.id,
        walletAddress,
        txHash: tx.txHash,
        ledger: BigInt(tx.ledger),
        ledgerClosedAt:
          event.ledgerClosedAt ?? transactionClosedAt(tx.createdAt),
        status: tx.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        successful: tx.status === "SUCCESS",
        actionType: classifyAction(
          invocation.functionName,
          parsed.name,
          parsed.direction
        ),
        functionName: invocation.functionName,
        invokedContract: invocation.contractId,
        sourceAccount: invocation.sourceAccount,
        operationIndex: invocation.operationIndex,
        eventIndex: event.eventIndex,
        assetContract: contract,
        assetSymbol,
        assetDecimals,
        amountAtomic: atomic,
        amount: amountString ? new Prisma.Decimal(amountString) : null,
        direction: parsed.direction,
        fromAddress: parsed.from,
        toAddress: parsed.to,
        counterparty: parsed.counterparty,
        priceUsd: new Prisma.Decimal(price.price),
        valueUsd: new Prisma.Decimal(Number.isFinite(valueUsd) ? valueUsd : 0),
        priceSource: price.source,
        memoType: invocation.memoType,
        memoValue: invocation.memoValue,
        authAddresses: invocation.authAddresses,
        argumentsJson: invocation.args as Prisma.InputJsonValue,
        rawEventJson: event.raw as unknown as Prisma.InputJsonValue,
        rawTransactionJson: tx as unknown as Prisma.InputJsonValue,
      },
      update: {
        status: tx.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        successful: tx.status === "SUCCESS",
        assetSymbol: metadata?.symbol ?? "UNKNOWN",
        assetDecimals: metadata?.decimals ?? 7,
        priceUsd: new Prisma.Decimal(price.price),
        valueUsd: new Prisma.Decimal(Number.isFinite(valueUsd) ? valueUsd : 0),
        priceSource: price.source,
      },
    });
  }
}

async function processLedger(network: Network, ledger: number): Promise<void> {
  const [rawEvents, transactions] = await Promise.all([
    pagedEvents(network, ledger, ledger + 1),
    pagedTransactions(network, ledger),
  ]);
  const events = rawEvents.map((event, index) =>
    parseEvent(network, event, index)
  );
  await ingestFactoryEvents(network, events);
  const eventsByTx = new Map<string, ParsedEvent[]>();
  for (const event of events)
    eventsByTx.set(event.txHash, [
      ...(eventsByTx.get(event.txHash) || []),
      event,
    ]);

  for (const tx of transactions) {
    let invocations: ParsedInvocation[] = [];
    try {
      invocations = parseInvocations(network, tx);
    } catch (error) {
      logger.warn(
        { network, ledger, txHash: tx.txHash, err: error },
        "unable to parse transaction envelope"
      );
      continue;
    }
    const txEvents = eventsByTx.get(tx.txHash) || [];
    for (const invocation of invocations) {
      const wallets = relevantWallets(network, invocation, txEvents);
      for (const wallet of wallets)
        await saveForWallet(network, wallet, tx, invocation, txEvents);
    }
  }
}

export class NetworkWorker {
  private stopped = false;
  constructor(private readonly network: Network) {}

  stop() {
    this.stopped = true;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (error) {
        logger.error(
          { network: this.network, err: error },
          "indexer tick failed"
        );
        await prisma.indexerCheckpoint.upsert({
          where: { network: this.network },
          create: {
            network: this.network,
            nextLedger: 0n,
            lastError: error instanceof Error ? error.message : String(error),
          },
          update: {
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, env.POLL_INTERVAL_MS));
    }
  }

  private async tick(): Promise<void> {
    const health = await getHealth(this.network);
    let checkpoint = await prisma.indexerCheckpoint.findUnique({
      where: { network: this.network },
    });
    if (!checkpoint || checkpoint.nextLedger === 0n) {
      const configured = networkConfig[this.network].startLedger;
      const first =
        configured ??
        BigInt(Math.max(health.oldestLedger, health.latestLedger - 10));
      checkpoint = await prisma.indexerCheckpoint.upsert({
        where: { network: this.network },
        create: {
          network: this.network,
          nextLedger: first,
          latestSeen: BigInt(health.latestLedger),
        },
        update: { nextLedger: first, latestSeen: BigInt(health.latestLedger) },
      });
    }
    let next = checkpoint.nextLedger;
    const latest = BigInt(health.latestLedger);
    while (!this.stopped && next <= latest) {
      await processLedger(this.network, Number(next));
      next += 1n;
      await prisma.indexerCheckpoint.update({
        where: { network: this.network },
        data: {
          nextLedger: next,
          latestSeen: latest,
          lastError: null,
          lastSuccessAt: new Date(),
        },
      });
    }
  }
}
