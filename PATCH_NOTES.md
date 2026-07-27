# Compatibility patch

This build fixes:

1. Soroban RPC pagination: cursor requests no longer include `startLedger`/`endLedger`.
2. Transaction pagination: cursor requests no longer include `startLedger`.
3. Protocol/XDR compatibility: `@stellar/stellar-sdk` is upgraded to `^15.1.0` so the decoder understands current Soroban credential variants.

After replacing an older copy, reinstall from a clean dependency tree:

```bash
rm -rf node_modules package-lock.json
npm install
npx prisma generate
npm run dev
```
