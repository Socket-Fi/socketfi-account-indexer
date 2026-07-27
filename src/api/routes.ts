import { Buffer } from "node:buffer";
import { ActionType, Prisma, TransactionStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { tokenMetadataService } from "../services/token-metadata.js";
import { requireAppApiKey } from "./auth.js";

const router = Router();
const networkSchema = z.enum(["TESTNET", "PUBLIC"]);
const actionSchema = z.nativeEnum(ActionType);
const statusSchema = z.nativeEnum(TransactionStatus);

const historyQuerySchema = z.object({
  network: networkSchema.default("PUBLIC"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  action: actionSchema.optional(),
  actionType: actionSchema.optional(),
  asset: z.string().min(1).optional(),
  assetContract: z.string().min(1).optional(),
  symbol: z.string().min(1).max(32).optional(),
  direction: z.enum(["incoming", "outgoing", "self", "unknown"]).optional(),
  status: statusSchema.optional(),
  successful: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  function: z.string().min(1).max(128).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  before: z.coerce.date().optional(),
  after: z.coerce.date().optional(),
});

type HistoryCursor = {
  ledger: string;
  indexedAt: string;
  id: string;
};

function encodeCursor(item: { ledger: bigint; indexedAt: Date; id: string }): string {
  const cursor: HistoryCursor = {
    ledger: item.ledger.toString(),
    indexedAt: item.indexedAt.toISOString(),
    id: item.id,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): HistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
    if (!parsed.ledger || !parsed.indexedAt || !parsed.id) throw new Error();
    BigInt(parsed.ledger);
    const date = new Date(parsed.indexedAt);
    if (Number.isNaN(date.getTime())) throw new Error();
    return { ledger: parsed.ledger, indexedAt: date.toISOString(), id: parsed.id };
  } catch {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["cursor"],
        message: "Invalid history cursor.",
      },
    ]);
  }
}

function parseOffsetPage(query: Record<string, unknown>) {
  const limit = Math.min(100, Math.max(1, Number(query.limit || 25)));
  const offset = Math.max(0, Number(query.offset || 0));
  return { limit, offset };
}

function explorerUrl(network: "TESTNET" | "PUBLIC", hash: string): string {
  return `https://stellar.expert/explorer/${network === "PUBLIC" ? "public" : "testnet"}/tx/${hash}`;
}

function serializeHistoryItem<T extends { network: "TESTNET" | "PUBLIC"; txHash: string }>(item: T) {
  return {
    ...item,
    explorerUrl: explorerUrl(item.network, item.txHash),
  };
}

router.get("/health", async (_req, res, next) => {
  try {
    const checkpoints = await prisma.indexerCheckpoint.findMany({ orderBy: { network: "asc" } });
    res.json({
      success: true,
      status: checkpoints.every((item) => !item.lastError) ? "healthy" : "degraded",
      checkpoints,
    });
  } catch (error) {
    next(error);
  }
});

// Every application data endpoint requires the SocketFi app API key.
router.use("/v1", requireAppApiKey);

router.get("/v1/wallets/:address/history", async (req, res, next) => {
  try {
    const query = historyQuerySchema.parse(req.query);
    const walletAddress = req.params.address.trim();

    const wallet = await prisma.socketFiWallet.findUnique({
      where: {
        network_address: {
          network: query.network,
          address: walletAddress,
        },
      },
      select: {
        id: true,
        address: true,
        network: true,
        authType: true,
        createdAtLedger: true,
        createdAtLedgerTime: true,
      },
    });

    if (!wallet) {
      res.status(404).json({
        success: false,
        error: "SocketFi wallet not found on the requested network.",
        code: "WALLET_NOT_FOUND",
      });
      return;
    }

    const where: Prisma.WalletTransactionWhereInput = {
      network: query.network,
      walletAddress,
    };

    where.actionType = query.action ?? query.actionType;
    where.assetContract = query.asset ?? query.assetContract;
    where.assetSymbol = query.symbol ? { equals: query.symbol, mode: "insensitive" } : undefined;
    where.direction = query.direction;
    where.status = query.status;
    where.successful = query.successful;
    where.functionName = query.function;
    where.fromAddress = query.from;
    where.toAddress = query.to;

    if (query.before || query.after) {
      where.ledgerClosedAt = {
        ...(query.before ? { lt: query.before } : {}),
        ...(query.after ? { gte: query.after } : {}),
      };
    }

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      const ledger = BigInt(cursor.ledger);
      const indexedAt = new Date(cursor.indexedAt);

      where.AND = [
        {
          OR: [
            { ledger: { lt: ledger } },
            { ledger, indexedAt: { lt: indexedAt } },
            { ledger, indexedAt, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const rows = await prisma.walletTransaction.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { indexedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    res.json({
      success: true,
      network: query.network,
      wallet,
      count: page.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      filters: {
        action: query.action ?? query.actionType ?? null,
        asset: query.asset ?? query.assetContract ?? null,
        symbol: query.symbol ?? null,
        direction: query.direction ?? null,
        status: query.status ?? null,
        successful: query.successful ?? null,
        function: query.function ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        before: query.before?.toISOString() ?? null,
        after: query.after?.toISOString() ?? null,
      },
      transactions: page.map(serializeHistoryItem),
    });
  } catch (error) {
    next(error);
  }
});

// Backwards-compatible alias. New applications should use /history.
router.get("/v1/wallets/:address/transactions", async (req, res, next) => {
  try {
    const network = networkSchema.parse(req.query.network || "PUBLIC");
    const { limit, offset } = parseOffsetPage(req.query);
    const where = { network, walletAddress: req.params.address } as const;
    const [items, total] = await prisma.$transaction([
      prisma.walletTransaction.findMany({
        where,
        orderBy: [{ ledger: "desc" }, { indexedAt: "desc" }],
        skip: offset,
        take: limit,
      }),
      prisma.walletTransaction.count({ where }),
    ]);
    res.json({
      success: true,
      network,
      walletAddress: req.params.address,
      total,
      limit,
      offset,
      items: items.map(serializeHistoryItem),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/v1/wallets/:address/summary", async (req, res, next) => {
  try {
    const network = networkSchema.parse(req.query.network || "PUBLIC");
    const walletAddress = req.params.address;
    const [wallet, transactionCount, aggregates, first, last] = await Promise.all([
      prisma.socketFiWallet.findUnique({ where: { network_address: { network, address: walletAddress } } }),
      prisma.walletTransaction.count({ where: { network, walletAddress } }),
      prisma.walletTransaction.aggregate({
        where: { network, walletAddress, successful: true },
        _sum: { valueUsd: true },
        _count: true,
      }),
      prisma.walletTransaction.findFirst({ where: { network, walletAddress }, orderBy: { ledger: "asc" } }),
      prisma.walletTransaction.findFirst({ where: { network, walletAddress }, orderBy: { ledger: "desc" } }),
    ]);

    if (!wallet) {
      res.status(404).json({ success: false, error: "Wallet not found", code: "WALLET_NOT_FOUND" });
      return;
    }

    res.json({
      success: true,
      network,
      wallet,
      transactionCount,
      volumeUsd: aggregates._sum.valueUsd || 0,
      firstTransaction: first ? serializeHistoryItem(first) : null,
      lastTransaction: last ? serializeHistoryItem(last) : null,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/v1/transactions", async (req, res, next) => {
  try {
    const network = networkSchema.parse(req.query.network || "PUBLIC");
    const { limit, offset } = parseOffsetPage(req.query);
    const where: Prisma.WalletTransactionWhereInput = { network };
    if (req.query.actionType) where.actionType = actionSchema.parse(req.query.actionType);
    if (req.query.assetContract) where.assetContract = String(req.query.assetContract);
    if (req.query.from) where.fromAddress = String(req.query.from);
    if (req.query.to) where.toAddress = String(req.query.to);
    const [items, total] = await prisma.$transaction([
      prisma.walletTransaction.findMany({
        where,
        orderBy: [{ ledger: "desc" }, { indexedAt: "desc" }],
        skip: offset,
        take: limit,
      }),
      prisma.walletTransaction.count({ where }),
    ]);
    res.json({ success: true, network, total, limit, offset, items: items.map(serializeHistoryItem) });
  } catch (error) {
    next(error);
  }
});

router.get("/v1/transactions/:hash", async (req, res, next) => {
  try {
    const network = networkSchema.parse(req.query.network || "PUBLIC");
    const items = await prisma.walletTransaction.findMany({
      where: { network, txHash: req.params.hash },
      orderBy: [{ walletAddress: "asc" }, { eventIndex: "asc" }],
    });
    if (!items.length) {
      res.status(404).json({ success: false, error: "Transaction not found", code: "TRANSACTION_NOT_FOUND" });
      return;
    }
    res.json({ success: true, network, txHash: req.params.hash, items: items.map(serializeHistoryItem) });
  } catch (error) {
    next(error);
  }
});

router.get("/v1/metrics/overview", async (req, res, next) => {
  try {
    const network = networkSchema.parse(req.query.network || "PUBLIC");
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    if (since && Number.isNaN(since.getTime())) throw new Error("Invalid since date");
    const txWhere: Prisma.WalletTransactionWhereInput = {
      network,
      ...(since ? { ledgerClosedAt: { gte: since } } : {}),
    };
    const walletWhere: Prisma.SocketFiWalletWhereInput = {
      network,
      ...(since ? { createdAtLedgerTime: { gte: since } } : {}),
    };
    const [wallets, transactions, successful, failed, volume, activeWallets, actionGroups, assetGroups] = await Promise.all([
      prisma.socketFiWallet.count({ where: walletWhere }),
      prisma.walletTransaction.count({ where: txWhere }),
      prisma.walletTransaction.count({ where: { ...txWhere, successful: true } }),
      prisma.walletTransaction.count({ where: { ...txWhere, successful: false } }),
      prisma.walletTransaction.aggregate({ where: { ...txWhere, successful: true }, _sum: { valueUsd: true, amount: true } }),
      prisma.walletTransaction.groupBy({ by: ["walletAddress"], where: txWhere, _count: true }),
      prisma.walletTransaction.groupBy({ by: ["actionType"], where: txWhere, _count: true, _sum: { valueUsd: true }, orderBy: { _count: { actionType: "desc" } } }),
      prisma.walletTransaction.groupBy({ by: ["assetContract", "assetSymbol"], where: { ...txWhere, assetContract: { not: null } }, _count: true, _sum: { valueUsd: true, amount: true }, orderBy: { _sum: { valueUsd: "desc" } }, take: 20 }),
    ]);
    res.json({
      success: true,
      network,
      since: since?.toISOString() || null,
      wallets,
      users: wallets,
      transactions,
      successful,
      failed,
      successRate: transactions ? successful / transactions : 0,
      activeWallets: activeWallets.length,
      volumeUsd: volume._sum.valueUsd || 0,
      rawTokenVolume: volume._sum.amount || 0,
      byAction: actionGroups,
      topAssets: assetGroups,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/v1/metrics/timeseries", async (req, res, next) => {
  try {
    const network = networkSchema.parse(req.query.network || "PUBLIC");
    const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
    const rows = await prisma.$queryRaw<
      Array<{ day: Date; transactions: bigint; active_wallets: bigint; volume_usd: Prisma.Decimal }>
    >(Prisma.sql`
      SELECT date_trunc('day', "ledgerClosedAt") AS day,
             count(*)::bigint AS transactions,
             count(DISTINCT "walletAddress")::bigint AS active_wallets,
             COALESCE(sum("valueUsd"), 0) AS volume_usd
      FROM "WalletTransaction"
      WHERE network = ${network}::"Network"
        AND "ledgerClosedAt" >= now() - (${days} * interval '1 day')
      GROUP BY 1 ORDER BY 1 ASC
    `);
    res.json({
      success: true,
      network,
      days,
      items: rows.map((row) => ({
        day: row.day,
        transactions: Number(row.transactions),
        activeWallets: Number(row.active_wallets),
        volumeUsd: row.volume_usd,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/v1/wallets", async (req, res, next) => {
  try {
    const network = networkSchema.parse(req.query.network || "PUBLIC");
    const { limit, offset } = parseOffsetPage(req.query);
    const [items, total] = await prisma.$transaction([
      prisma.socketFiWallet.findMany({ where: { network }, orderBy: { createdAtLedger: "desc" }, skip: offset, take: limit }),
      prisma.socketFiWallet.count({ where: { network } }),
    ]);
    res.json({ success: true, network, total, limit, offset, items });
  } catch (error) {
    next(error);
  }
});

router.put("/v1/tokens/:contract/classic-mapping", async (req, res, next) => {
  try {
    const network = networkSchema.parse(req.body.network);
    const body = z.object({
      classicCode: z.string().min(1).max(12),
      classicIssuer: z.string().nullable().optional(),
      symbol: z.string().optional(),
      decimals: z.number().int().min(0).max(18).optional(),
      icon: z.string().url().nullable().optional(),
    }).parse(req.body);
    const token = await tokenMetadataService.setClassicMapping(network, req.params.contract, body);
    res.json({ success: true, token });
  } catch (error) {
    next(error);
  }
});

export default router;
