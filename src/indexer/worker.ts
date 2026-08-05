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

function bigintString(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): string | undefined {
  /*
   * Soroban event values can contain nested maps, arrays, SDK wrapper
   * objects, getters, and occasionally circular references. Never recurse
   * into nullish or primitive values that are not integer-like.
   */
  if (value == null) {
    return undefined;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value)
  ) {
    return String(value);
  }

  if (typeof value === "string") {
    const normalized = value.trim();

    /*
     * Accept plain integers and common decoded Soroban integer suffixes such
     * as "21997800i128", "1000u32", and "-4i64".
     */
    const match = normalized.match(/^(-?\d+)(?:[iu](?:32|64|128|256))?$/i);

    return match?.[1];
  }

  if (typeof value !== "object") {
    return undefined;
  }

  if (depth >= 12 || seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = bigintString(item, seen, depth + 1);

        if (candidate !== undefined) {
          return candidate;
        }
      }

      return undefined;
    }

    const record = value as Record<string, unknown>;

    /*
     * Prefer semantically meaningful amount fields before scanning nested
     * values. The extra names cover common Soroban event-map representations.
     */
    for (const key of [
      "amount",
      "value",
      "amountAtomic",
      "fee",
      "fee_collected",
      "balance",
      "0",
    ]) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        continue;
      }

      const candidate = bigintString(record[key], seen, depth + 1);

      if (candidate !== undefined) {
        return candidate;
      }
    }

    /*
     * Some decoded maps use symbol-like keys or wrapper objects. Scan a
     * bounded number of own enumerable values as a safe fallback.
     */
    const values = Object.values(record).slice(0, 64);

    for (const nested of values) {
      const candidate = bigintString(nested, seen, depth + 1);

      if (candidate !== undefined) {
        return candidate;
      }
    }

    return undefined;
  } finally {
    seen.delete(value);
  }
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
  ) {
    return undefined;
  }

  const topic1 =
    typeof event.topics[1] === "string" ? event.topics[1] : undefined;

  const topic2 =
    typeof event.topics[2] === "string" ? event.topics[2] : undefined;

  let from: string | undefined;
  let to: string | undefined;

  /*
   * Standard Stellar Asset Contract event layouts:
   *
   * transfer: ["transfer", from, to, asset]
   * approve:  ["approve", from, spender, asset]
   * mint:     ["mint", to, asset]
   * burn:     ["burn", from, asset]
   *
   * The previous implementation interpreted topic[2] as `to` for every event,
   * causing mint/burn asset identifiers to be treated as addresses.
   */
  if (name === "transfer" || name === "approve") {
    from = topic1;
    to = topic2;
  } else if (name === "mint") {
    to = topic1;
  } else if (name === "burn") {
    from = topic1;
  }

  const amountAtomic = bigintString(event.data);

  let direction: string | undefined;
  let counterparty: string | undefined;

  if (from === wallet && to === wallet) {
    direction = "SELF";
  } else if (from === wallet) {
    direction = "OUT";
    counterparty = to;
  } else if (to === wallet) {
    direction = "IN";
    counterparty = from;
  } else {
    return undefined;
  }

  return {
    name,
    from,
    to,
    amountAtomic,
    direction,
    counterparty,
  };
}

const MAX_EVENT_PAGES_PER_LEDGER = 100;
const MAX_TRANSACTION_PAGES_PER_LEDGER = 100;

async function pagedEvents(
  network: Network,
  startLedger: number,
  endLedger: number
): Promise<RpcEvent[]> {
  const all: RpcEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 1; page <= MAX_EVENT_PAGES_PER_LEDGER; page += 1) {
    const result = await rpcCall<RpcEventsResult>(
      network,
      "getEvents",
      cursor
        ? {
            filters: [{ type: "contract" }],
            pagination: {
              limit: env.EVENT_PAGE_LIMIT,
              cursor,
            },
          }
        : {
            startLedger,
            endLedger,
            filters: [{ type: "contract" }],
            pagination: {
              limit: env.EVENT_PAGE_LIMIT,
            },
          }
    );

    all.push(...result.events);

    logger.debug(
      {
        network,
        startLedger,
        endLedger,
        page,
        received: result.events.length,
        total: all.length,
        cursor: result.cursor,
      },
      "event page fetched"
    );

    const nextCursor = result.cursor;
    const hasFullPage = result.events.length === env.EVENT_PAGE_LIMIT;

    if (!nextCursor || !hasFullPage) {
      return all;
    }

    if (seenCursors.has(nextCursor)) {
      throw new Error(
        `${network} RPC repeated event cursor while processing ledgers ` +
          `${startLedger}-${endLedger}: ${nextCursor}`
      );
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(
    `${network} event pagination exceeded ${MAX_EVENT_PAGES_PER_LEDGER} pages ` +
      `for ledgers ${startLedger}-${endLedger}`
  );
}

async function pagedTransactions(
  network: Network,
  ledger: number
): Promise<RpcTransactionItem[]> {
  const all: RpcTransactionItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 1; page <= MAX_TRANSACTION_PAGES_PER_LEDGER; page += 1) {
    const result = await rpcCall<RpcTransactionsResult>(
      network,
      "getTransactions",
      cursor
        ? {
            pagination: {
              limit: env.TX_PAGE_LIMIT,
              cursor,
            },
          }
        : {
            startLedger: ledger,
            pagination: {
              limit: env.TX_PAGE_LIMIT,
            },
          }
    );

    const rows = result.transactions.filter(
      (transaction) => Number(transaction.ledger) === ledger
    );

    all.push(...rows);

    const reachedLaterLedger = result.transactions.some(
      (transaction) => Number(transaction.ledger) > ledger
    );

    const firstTransaction = result.transactions.at(0);
    const lastTransaction = result.transactions.at(-1);

    logger.info(
      {
        network,
        ledger,
        page,
        received: result.transactions.length,
        retained: rows.length,
        totalRetained: all.length,
        firstLedger: firstTransaction ? Number(firstTransaction.ledger) : null,
        lastLedger: lastTransaction ? Number(lastTransaction.ledger) : null,
        cursor: result.cursor,
        reachedLaterLedger,
      },
      "transaction page fetched"
    );

    if (reachedLaterLedger) {
      return all;
    }

    const nextCursor = result.cursor;
    const hasFullPage = result.transactions.length === env.TX_PAGE_LIMIT;

    if (!nextCursor || !hasFullPage) {
      return all;
    }

    if (seenCursors.has(nextCursor)) {
      throw new Error(
        `${network} RPC repeated transaction cursor while processing ` +
          `ledger ${ledger}: ${nextCursor}`
      );
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(
    `${network} transaction pagination exceeded ` +
      `${MAX_TRANSACTION_PAGES_PER_LEDGER} pages for ledger ${ledger}`
  );
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
    const price =
      contract && amountString
        ? await priceService.getUsdPrice(network, contract, amountString)
        : { price: 0, source: "DEFAULT_ZERO", route: "none" as const };

    const amountDecimal = amountString
      ? new Prisma.Decimal(amountString).abs()
      : new Prisma.Decimal(0);
    const priceDecimal = new Prisma.Decimal(
      Number.isFinite(price.price) && price.price > 0 ? price.price : 0
    );
    const valueUsd = amountDecimal.mul(priceDecimal);
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
        priceUsd: priceDecimal,
        valueUsd,
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
        assetSymbol: normalizeAssetSymbol(metadata?.symbol),
        assetDecimals: metadata?.decimals ?? 7,
        priceUsd: priceDecimal,
        valueUsd,
        priceSource: price.source,
      },
    });
  }
}

async function processLedger(network: Network, ledger: number): Promise<void> {
  logger.info({ network, ledger }, "ledger processing started");

  const [rawEvents, transactions] = await Promise.all([
    pagedEvents(network, ledger, ledger + 1),
    pagedTransactions(network, ledger),
  ]);

  logger.info(
    {
      network,
      ledger,
      rawEvents: rawEvents.length,
      transactions: transactions.length,
    },
    "ledger RPC data fetched"
  );

  const events = rawEvents.map((event, index) =>
    parseEvent(network, event, index)
  );

  await ingestFactoryEvents(network, events);

  const eventsByTx = new Map<string, ParsedEvent[]>();

  for (const event of events) {
    const existing = eventsByTx.get(event.txHash);

    if (existing) {
      existing.push(event);
    } else {
      eventsByTx.set(event.txHash, [event]);
    }
  }

  let parsedInvocationCount = 0;
  let relevantWalletCount = 0;
  let savedWalletCount = 0;
  let parseFailureCount = 0;

  for (const tx of transactions) {
    let invocations: ParsedInvocation[] = [];

    try {
      invocations = parseInvocations(network, tx);
    } catch (error) {
      parseFailureCount += 1;

      logger.warn(
        {
          network,
          ledger,
          txHash: tx.txHash,
          err: error,
        },
        "unable to parse transaction envelope"
      );

      continue;
    }

    parsedInvocationCount += invocations.length;

    const txEvents = eventsByTx.get(tx.txHash) ?? [];

    for (const invocation of invocations) {
      const wallets = relevantWallets(network, invocation, txEvents);

      relevantWalletCount += wallets.size;

      for (const wallet of wallets) {
        await saveForWallet(network, wallet, tx, invocation, txEvents);

        savedWalletCount += 1;
      }
    }
  }

  logger.info(
    {
      network,
      ledger,
      transactionsSeen: transactions.length,
      eventsSeen: events.length,
      parsedInvocations: parsedInvocationCount,
      relevantWallets: relevantWalletCount,
      walletSaves: savedWalletCount,
      parseFailures: parseFailureCount,
    },
    "ledger processing completed"
  );
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
        update: {
          nextLedger: first,
          latestSeen: BigInt(health.latestLedger),
        },
      });

      logger.info(
        {
          network: this.network,
          configuredStartLedger: configured?.toString() ?? null,
          firstLedger: first.toString(),
          oldestLedger: health.oldestLedger,
          latestLedger: health.latestLedger,
        },
        "indexer checkpoint initialized"
      );
    }

    let next = checkpoint.nextLedger;
    const latest = BigInt(health.latestLedger);

    await prisma.indexerCheckpoint.update({
      where: { network: this.network },
      data: {
        latestSeen: latest,
      },
    });

    logger.info(
      {
        network: this.network,
        nextLedger: next.toString(),
        latestLedger: latest.toString(),
        behindBy: next <= latest ? (latest - next + 1n).toString() : "0",
      },
      "indexer tick started"
    );

    while (!this.stopped && next <= latest) {
      const ledger = Number(next);

      if (!Number.isSafeInteger(ledger)) {
        throw new Error(
          `${this.network} ledger ${next.toString()} exceeds ` +
            "JavaScript safe integer range"
        );
      }

      await processLedger(this.network, ledger);

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

      logger.info(
        {
          network: this.network,
          processedLedger: ledger,
          nextLedger: next.toString(),
          latestLedger: latest.toString(),
        },
        "checkpoint advanced"
      );
    }
  }
}
