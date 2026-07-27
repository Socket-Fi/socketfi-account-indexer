import type { Network } from "../config/env.js";
import { env, networkConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";

type Cached = { price: number; source: string; expires: number };

export class PriceService {
  private readonly cache = new Map<string, Cached>();

  async getUsdPrice(network: Network, contract: string): Promise<{ price: number; source: string }> {
    const key = `${network}:${contract}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return { price: cached.price, source: cached.source };

    const token = await prisma.tokenMetadata.findUnique({ where: { network_contract: { network, contract } } });
    if (!token?.classicCode) return this.remember(key, 0, "DEFAULT_ZERO");
    if (token.classicCode.toUpperCase() === env.PRICE_QUOTE_ASSET.toUpperCase()) return this.remember(key, 1, "USD_STABLECOIN");

    // Horizon order books require the classic asset identity. Quote identity is configurable through env.
    const quoteCode = process.env[`${network}_QUOTE_CODE`] || env.PRICE_QUOTE_ASSET;
    const quoteIssuer = process.env[`${network}_QUOTE_ISSUER`];
    if (!quoteIssuer) return this.remember(key, 0, "DEFAULT_ZERO");

    const params = new URLSearchParams();
    if (token.classicCode.toUpperCase() === "XLM") params.set("selling_asset_type", "native");
    else {
      params.set("selling_asset_type", token.classicCode.length <= 4 ? "credit_alphanum4" : "credit_alphanum12");
      params.set("selling_asset_code", token.classicCode);
      if (!token.classicIssuer) return this.remember(key, 0, "DEFAULT_ZERO");
      params.set("selling_asset_issuer", token.classicIssuer);
    }
    params.set("buying_asset_type", quoteCode.length <= 4 ? "credit_alphanum4" : "credit_alphanum12");
    params.set("buying_asset_code", quoteCode);
    params.set("buying_asset_issuer", quoteIssuer);
    params.set("limit", "1");

    try {
      const response = await fetch(`${networkConfig[network].horizonUrl}/order_book?${params}`);
      if (!response.ok) return this.remember(key, 0, "DEFAULT_ZERO");
      const book = await response.json() as { bids?: Array<{ price: string }>; asks?: Array<{ price: string }> };
      const bid = Number(book.bids?.[0]?.price || 0);
      const ask = Number(book.asks?.[0]?.price || 0);
      const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask || 0;
      return this.remember(key, Number.isFinite(price) ? price : 0, price > 0 ? "STELLAR_DEX_MID" : "DEFAULT_ZERO");
    } catch {
      return this.remember(key, 0, "DEFAULT_ZERO");
    }
  }

  private remember(key: string, price: number, source: string) {
    this.cache.set(key, { price, source, expires: Date.now() + env.PRICE_CACHE_SECONDS * 1000 });
    return { price, source };
  }
}

export const priceService = new PriceService();
