import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4015),
  DATABASE_URL: z.string().min(1),
  APP_API_KEYS: z.string().min(16).transform((value) => {
    const keys = value.split(",").map((key) => key.trim()).filter(Boolean);
    if (keys.length === 0 || keys.some((key) => key.length < 16)) {
      throw new Error("APP_API_KEYS must contain one or more comma-separated keys of at least 16 characters");
    }
    return keys;
  }),
  TESTNET_RPC_URL: z.string().url(),
  PUBLIC_RPC_URL: z.string().url(),
  TESTNET_HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  PUBLIC_HORIZON_URL: z.string().url().default("https://horizon.stellar.org"),
  TESTNET_FACTORY_CONTRACT_ID: z.string().startsWith("C"),
  PUBLIC_FACTORY_CONTRACT_ID: z.string().startsWith("C"),
  TESTNET_SIMULATION_SOURCE: z.string().startsWith("G"),
  PUBLIC_SIMULATION_SOURCE: z.string().startsWith("G"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  TX_PAGE_LIMIT: z.coerce.number().int().min(1).max(200).default(200),
  EVENT_PAGE_LIMIT: z.coerce.number().int().min(1).max(10000).default(1000),
  START_LEDGER_TESTNET: z.string().optional(),
  START_LEDGER_PUBLIC: z.string().optional(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  PRICE_QUOTE_ASSET: z.string().default("USDC"),
  PRICE_CACHE_SECONDS: z.coerce.number().int().positive().default(300),
});

export const env = schema.parse(process.env);
export type Network = "TESTNET" | "PUBLIC";

export const networkConfig = {
  TESTNET: {
    rpcUrl: env.TESTNET_RPC_URL,
    horizonUrl: env.TESTNET_HORIZON_URL,
    factoryContractId: env.TESTNET_FACTORY_CONTRACT_ID,
    simulationSource: env.TESTNET_SIMULATION_SOURCE,
    startLedger: env.START_LEDGER_TESTNET ? BigInt(env.START_LEDGER_TESTNET) : undefined,
  },
  PUBLIC: {
    rpcUrl: env.PUBLIC_RPC_URL,
    horizonUrl: env.PUBLIC_HORIZON_URL,
    factoryContractId: env.PUBLIC_FACTORY_CONTRACT_ID,
    simulationSource: env.PUBLIC_SIMULATION_SOURCE,
    startLedger: env.START_LEDGER_PUBLIC ? BigInt(env.START_LEDGER_PUBLIC) : undefined,
  },
} satisfies Record<Network, {
  rpcUrl: string;
  horizonUrl: string;
  factoryContractId: string;
  simulationSource: string;
  startLedger?: bigint;
}>;
