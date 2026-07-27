import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { z } from "zod";
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./utils/logger.js";
import routes from "./api/routes.js";
import { walletRegistry } from "./services/wallet-registry.js";
import { NetworkWorker } from "./indexer/worker.js";

async function main() {
  // Prisma exposes ledger and sequence columns as bigint. Ensure every Express
  // response, including health and error payloads, serializes them safely.
  (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
    return this.toString();
  };

  await prisma.$connect();
  await walletRegistry.initialize();

  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN.split(",").map((x) => x.trim()), credentials: true }));
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));
  app.use(routes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Invalid request.",
        code: "VALIDATION_ERROR",
        issues: error.issues,
      });
      return;
    }

    logger.error({ err: error }, "request failed");
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, "SocketFi history indexer listening"));
  const workers = [new NetworkWorker("TESTNET"), new NetworkWorker("PUBLIC")];
  for (const worker of workers) void worker.run();

  const shutdown = async () => {
    workers.forEach((worker) => worker.stop());
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  logger.fatal({ err: error }, "startup failed");
  process.exit(1);
});
