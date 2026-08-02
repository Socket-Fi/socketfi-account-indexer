import { Asset, Horizon, StrKey } from "@stellar/stellar-sdk";
import type { Network, TokenMetadata } from "@prisma/client";

import { env, networkConfig } from "../config/env.js";
import {
  getCuratedAsset,
  type CuratedAsset,
} from "../config/curated-assets.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

type PriceResult = {
  price: number;
  source: string;
  route: "stable" | "direct" | "via_xlm" | "none";
};

type CachedPrice = PriceResult & {
  expiresAt: number;
};

type AssetIdentity = {
  contract: string;
  code: string;
  issuer: string | null;
  decimals: number;
};

type OrderBook = {
  bids?: Array<{ price?: string; amount?: string }>;
};

type ExecutableQuote =
  | {
      ok: true;
      amountSold: number;
      amountReceived: number;
      vwap: number;
    }
  | {
      ok: false;
      reason: string;
    };

const REQUEST_TIMEOUT_MS = Number(
  process.env.STELLAR_DEX_PRICE_TIMEOUT_MS || 3_000
);
const ORDER_BOOK_CACHE_MS = Number(
  process.env.STELLAR_DEX_PAIR_CACHE_TTL_MS || 10_000
);
const NEGATIVE_CACHE_SECONDS = Number(
  process.env.STELLAR_DEX_NEGATIVE_CACHE_SECONDS || 20
);
const ORDER_BOOK_LIMIT = Math.min(
  200,
  Math.max(1, Number(process.env.STELLAR_DEX_ORDER_BOOK_LIMIT || 200))
);

function normalize(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function quoteConfiguration(network: Network): {
  code: string;
  issuer: string | null;
} {
  const code = normalize(
    process.env[`${network}_QUOTE_CODE`] || env.PRICE_QUOTE_ASSET
  );
  const issuer = process.env[`${network}_QUOTE_ISSUER`]?.trim() || null;
  return { code, issuer };
}

function toAsset(identity: AssetIdentity): Asset | null {
  if (identity.code === "XLM" || identity.issuer === null) {
    return identity.code === "XLM" ? Asset.native() : null;
  }

  if (
    !/^[A-Z0-9]{1,12}$/.test(identity.code) ||
    !StrKey.isValidEd25519PublicKey(identity.issuer)
  ) {
    return null;
  }

  return new Asset(identity.code, identity.issuer);
}

function assetKey(asset: Asset): string {
  return asset.isNative() ? "XLM" : `${asset.getCode()}:${asset.getIssuer()}`;
}

function identityFromCurated(asset: CuratedAsset): AssetIdentity {
  const code = normalize(asset.code);
  const native = code === "XLM" || normalize(asset.issuer) === "NATIVE";

  return {
    contract: normalize(asset.contract),
    code: native ? "XLM" : code,
    issuer: native ? null : asset.issuer.trim(),
    decimals: asset.decimals,
  };
}

function identityFromMetadata(
  token: TokenMetadata,
  contract: string
): AssetIdentity | null {
  const code = normalize(token.classicCode);
  if (!code) return null;

  const native = code === "XLM";
  const issuer = native ? null : token.classicIssuer?.trim() || null;
  if (!native && !issuer) return null;

  return {
    contract: normalize(contract),
    code,
    issuer,
    decimals: token.decimals,
  };
}

function sellAgainstBids(
  book: OrderBook,
  requestedAmount: string
): ExecutableQuote {
  const amount = positiveNumber(requestedAmount);
  const bids = Array.isArray(book.bids) ? book.bids : [];

  if (!amount || bids.length === 0) {
    return { ok: false, reason: "NO_EXECUTABLE_BIDS" };
  }

  let remaining = amount;
  let received = 0;

  for (const bid of bids) {
    if (remaining <= 0) break;

    const price = positiveNumber(bid.price);
    const available = positiveNumber(bid.amount);
    if (!price || !available) continue;

    const taken = Math.min(remaining, available);
    received += taken * price;
    remaining -= taken;
  }

  if (remaining > Math.max(1e-12, amount * 1e-12)) {
    return { ok: false, reason: "INSUFFICIENT_ORDER_BOOK_DEPTH" };
  }

  return {
    ok: true,
    amountSold: amount,
    amountReceived: received,
    vwap: received / amount,
  };
}

export class PriceService {
  private readonly priceCache = new Map<string, CachedPrice>();
  private readonly orderBookCache = new Map<
    string,
    { book: OrderBook; expiresAt: number }
  >();

  async getUsdPrice(
    network: Network,
    contract: string,
    amount = "1"
  ): Promise<PriceResult> {
    const normalizedContract = normalize(contract);
    const normalizedAmount = positiveNumber(amount)?.toString() || "1";
    const cacheKey = `${network}:${normalizedContract}:${normalizedAmount}`;
    const cached = this.priceCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return {
        price: cached.price,
        source: cached.source,
        route: cached.route,
      };
    }

    try {
      const identity = await this.resolveIdentity(network, normalizedContract);
      if (!identity) {
        return this.remember(
          cacheKey,
          { price: 0, source: "MISSING_CLASSIC_MAPPING", route: "none" },
          NEGATIVE_CACHE_SECONDS
        );
      }

      const quote = quoteConfiguration(network);
      if (!quote.code || !quote.issuer) {
        return this.remember(
          cacheKey,
          { price: 0, source: "MISSING_QUOTE_CONFIGURATION", route: "none" },
          NEGATIVE_CACHE_SECONDS
        );
      }

      if (identity.code === quote.code && identity.issuer === quote.issuer) {
        return this.remember(cacheKey, {
          price: 1,
          source: "USD_STABLECOIN",
          route: "stable",
        });
      }

      const asset = toAsset(identity);
      const quoteAsset = new Asset(quote.code, quote.issuer);

      if (!asset) {
        return this.remember(
          cacheKey,
          { price: 0, source: "INVALID_CLASSIC_MAPPING", route: "none" },
          NEGATIVE_CACHE_SECONDS
        );
      }

      const xlm = Asset.native();
      const [directBook, assetXlmBook, xlmQuoteBook] = await Promise.all([
        this.fetchOrderBook(network, asset, quoteAsset).catch(() => null),
        asset.isNative()
          ? Promise.resolve(null)
          : this.fetchOrderBook(network, asset, xlm).catch(() => null),
        this.fetchOrderBook(network, xlm, quoteAsset).catch(() => null),
      ]);

      const direct = directBook
        ? sellAgainstBids(directBook, normalizedAmount)
        : ({ ok: false, reason: "DIRECT_MARKET_UNAVAILABLE" } as const);

      let viaXlm: ExecutableQuote = {
        ok: false,
        reason: "XLM_ROUTE_UNAVAILABLE",
      };

      if (asset.isNative()) {
        if (xlmQuoteBook) {
          viaXlm = sellAgainstBids(xlmQuoteBook, normalizedAmount);
        }
      } else if (assetXlmBook && xlmQuoteBook) {
        const firstLeg = sellAgainstBids(assetXlmBook, normalizedAmount);
        if (firstLeg.ok) {
          const secondLeg = sellAgainstBids(
            xlmQuoteBook,
            String(firstLeg.amountReceived)
          );

          if (secondLeg.ok) {
            viaXlm = {
              ok: true,
              amountSold: Number(normalizedAmount),
              amountReceived: secondLeg.amountReceived,
              vwap: secondLeg.amountReceived / Number(normalizedAmount),
            };
          } else {
            viaXlm = secondLeg;
          }
        } else {
          viaXlm = firstLeg;
        }
      }

      if (direct.ok && viaXlm.ok) {
        return direct.vwap >= viaXlm.vwap
          ? this.remember(cacheKey, {
              price: direct.vwap,
              source: "STELLAR_DEX_DIRECT_VWAP",
              route: "direct",
            })
          : this.remember(cacheKey, {
              price: viaXlm.vwap,
              source: "STELLAR_DEX_VIA_XLM_VWAP",
              route: "via_xlm",
            });
      }

      if (direct.ok) {
        return this.remember(cacheKey, {
          price: direct.vwap,
          source: "STELLAR_DEX_DIRECT_VWAP",
          route: "direct",
        });
      }

      if (viaXlm.ok) {
        return this.remember(cacheKey, {
          price: viaXlm.vwap,
          source: asset.isNative()
            ? "STELLAR_DEX_DIRECT_VWAP"
            : "STELLAR_DEX_VIA_XLM_VWAP",
          route: asset.isNative() ? "direct" : "via_xlm",
        });
      }

      return this.remember(
        cacheKey,
        { price: 0, source: "NO_EXECUTABLE_USDC_ROUTE", route: "none" },
        NEGATIVE_CACHE_SECONDS
      );
    } catch (error) {
      logger.warn(
        { network, contract: normalizedContract, amount, err: error },
        "unable to estimate Stellar DEX USD price"
      );

      return this.remember(
        cacheKey,
        { price: 0, source: "STELLAR_DEX_REQUEST_FAILED", route: "none" },
        NEGATIVE_CACHE_SECONDS
      );
    }
  }

  private async resolveIdentity(
    network: Network,
    contract: string
  ): Promise<AssetIdentity | null> {
    const curated = getCuratedAsset(network, contract);

    if (curated) {
      const identity = identityFromCurated(curated);

      // Keep TokenMetadata useful for APIs and diagnostics, but pricing does
      // not depend on this write succeeding.
      await prisma.tokenMetadata
        .upsert({
          where: { network_contract: { network, contract } },
          create: {
            network,
            contract,
            symbol: identity.code,
            decimals: identity.decimals,
            classicCode: identity.code,
            classicIssuer: identity.issuer,
            icon: curated.icon || null,
            resolved: true,
            lastError: null,
            lastResolvedAt: new Date(),
          },
          update: {
            symbol: identity.code,
            decimals: identity.decimals,
            classicCode: identity.code,
            classicIssuer: identity.issuer,
            icon: curated.icon || undefined,
            resolved: true,
            lastError: null,
            lastResolvedAt: new Date(),
          },
        })
        .catch((error) => {
          logger.warn(
            { network, contract, err: error },
            "unable to synchronize curated token metadata"
          );
        });

      return identity;
    }

    const metadata = await prisma.tokenMetadata.findUnique({
      where: { network_contract: { network, contract } },
    });

    return metadata ? identityFromMetadata(metadata, contract) : null;
  }

  private async fetchOrderBook(
    network: Network,
    selling: Asset,
    buying: Asset
  ): Promise<OrderBook> {
    const key = `${network}:${assetKey(selling)}>${assetKey(buying)}`;
    const cached = this.orderBookCache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.book;
    }

    const server = new Horizon.Server(networkConfig[network].horizonUrl);
    const request = server
      .orderbook(selling, buying)
      .limit(ORDER_BOOK_LIMIT)
      .call() as Promise<OrderBook>;

    const book = await this.withTimeout(request);
    this.orderBookCache.set(key, {
      book,
      expiresAt: Date.now() + ORDER_BOOK_CACHE_MS,
    });

    return book;
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Horizon price request timed out")),
        REQUEST_TIMEOUT_MS
      );
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private remember(
    key: string,
    result: PriceResult,
    ttlSeconds = env.PRICE_CACHE_SECONDS
  ): PriceResult {
    this.priceCache.set(key, {
      ...result,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
    return result;
  }
}

export const priceService = new PriceService();
