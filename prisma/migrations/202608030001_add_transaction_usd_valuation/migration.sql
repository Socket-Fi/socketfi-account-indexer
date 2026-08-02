ALTER TABLE "WalletTransaction"
  ADD COLUMN IF NOT EXISTS "priceUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "valueUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "priceSource" TEXT NOT NULL DEFAULT 'DEFAULT_ZERO';

CREATE INDEX IF NOT EXISTS "WalletTransaction_network_ledgerClosedAt_successful_idx"
  ON "WalletTransaction" ("network", "ledgerClosedAt", "successful");

CREATE INDEX IF NOT EXISTS "WalletTransaction_volume_dedupe_idx"
  ON "WalletTransaction" (
    "network",
    "txHash",
    "operationIndex",
    "eventIndex"
  );
