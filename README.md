# SocketFi History Indexer

Production-oriented dual-network history service for SocketFi smart accounts.

## What it does

- Watches the configured TESTNET and PUBLIC factory contracts.
- Parses `Wallet/Creation` events and stores the full smart-wallet address.
- Maintains an in-memory `Set<string>` per network for constant-time membership checks.
- Scans each new ledger once and stores only transactions involving registered SocketFi wallets.
- Persists function name, invoked contract, arguments, auth addresses, token movement, direction, amount, symbol/decimals, DEX price, USD value, status, ledger and raw source payloads.
- Resolves SEP-41 token `symbol()` and `decimals()` through read-only simulation.
- Uses Stellar DEX midpoint pricing when a classic-asset mapping and quote issuer are configured; otherwise stores price `0` with source `DEFAULT_ZERO`.
- Exposes wallet history and aggregate metrics APIs.

## Start

```bash
cp .env.example .env
# Fill the two factory IDs, RPC URLs, simulation source accounts, and DATABASE_URL.
docker compose up -d
npm install
npx prisma generate
npx prisma db push
npm run dev
```

The simulation source is only used to build read-only simulation transactions. It does not sign or submit transactions.

## Pricing configuration

For DEX pricing, set these optional variables:

```env
PUBLIC_QUOTE_CODE=USDC
PUBLIC_QUOTE_ISSUER=G...
TESTNET_QUOTE_CODE=USDC
TESTNET_QUOTE_ISSUER=G...
```

Map a token contract to its underlying classic asset:

```http
PUT /v1/tokens/C.../classic-mapping
Content-Type: application/json

{
  "network": "PUBLIC",
  "classicCode": "XLM",
  "classicIssuer": null,
  "symbol": "XLM",
  "decimals": 7
}
```

## APIs

- `GET /health`
- `GET /v1/wallets?network=PUBLIC`
- `GET /v1/wallets/:address/transactions?network=PUBLIC&limit=25&offset=0`
- `GET /v1/wallets/:address/summary?network=PUBLIC`
- `GET /v1/transactions?network=PUBLIC`
- `GET /v1/transactions/:hash?network=PUBLIC`
- `GET /v1/metrics/overview?network=PUBLIC&since=2026-01-01T00:00:00Z`
- `GET /v1/metrics/timeseries?network=PUBLIC&days=30`

## Factory event compatibility

The parser expects the event emitted by:

```rust
#[contractevent(topics = ["Wallet", "Creation"])]
pub struct WalletCreationEvent {
    pub wallet: Address,
    pub passkey: Option<BytesN<65>>,
    pub stellar_signer: Option<BytesN<32>>,
    pub bls_keys: Vec<BytesN<96>>,
}
```

No contract change is required.

## App API-key authentication

All `/v1` routes require one of the comma-separated secrets configured in `APP_API_KEYS`.
`/health` remains unauthenticated for infrastructure health checks.

Send the key using either header:

```http
X-API-Key: your-app-api-key
```

or:

```http
Authorization: Bearer your-app-api-key
```

For zero-downtime rotation, temporarily configure both keys:

```env
APP_API_KEYS=current-secret,next-secret
```

Do not bundle this secret into a public browser application. A browser cannot keep an API key secret. Call this service through your own authenticated application backend or server-side API route.

## Wallet transaction history

Primary endpoint:

```http
GET /v1/wallets/:walletAddress/history?network=PUBLIC&limit=25
X-API-Key: your-app-api-key
```

Supported filters:

- `cursor`: opaque cursor returned as `nextCursor`
- `action` or `actionType`
- `asset` or `assetContract`
- `symbol`
- `direction=incoming|outgoing|self|unknown`
- `status=SUCCESS|FAILED`
- `successful=true|false`
- `function`
- `from`
- `to`
- `before=<ISO timestamp>`
- `after=<ISO timestamp>`

Example:

```bash
curl -s \
  -H "X-API-Key: $SOCKETFI_HISTORY_API_KEY" \
  "http://localhost:4015/v1/wallets/C.../history?network=PUBLIC&limit=25&direction=outgoing"
```

Continue to the next page using the returned cursor:

```bash
curl -s \
  -H "X-API-Key: $SOCKETFI_HISTORY_API_KEY" \
  "http://localhost:4015/v1/wallets/C.../history?network=PUBLIC&limit=25&cursor=<nextCursor>"
```

The response includes an Explorer URL for every transaction. The older offset-based
`/v1/wallets/:address/transactions` endpoint remains available for compatibility and is also API-key protected.

## Runtime compatibility fixes

This build safely serializes Prisma `BigInt` fields in every API response, supports both standard and fee-bump transaction envelopes, converts RPC `createdAt` Unix timestamps correctly, and logs complete RPC/parser errors under Pino's `err` field.
