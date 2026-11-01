# Trawer POS (Expo)

Offline-first till app: multiple open carts, barcode scanning (camera), customer lookup with
their tier price, payments (cash, card terminal, transfer, USSD, QR, credit), Bluetooth thermal
receipts (ESC/POS over BLE) and WhatsApp receipts (wa.me link), end-of-day cash-up.

- Storage: WatermelonDB on SQLite (JSI). Tokens in the OS keystore (expo-secure-store).
- Logic: `@trawer/core/pos` (`PosEngine`) — the same code is tested in Node with in-memory and
  LokiJS adapters and end-to-end against the real API.
- Offline rule: a till sells what a manager allocated to it (Dashboard → Settings → Tills).
  Sales queue in the outbox with client-generated ids and sync every 30 s / when the network
  returns. A manager override can sell beyond the allocation; the server then records a stock
  conflict instead of letting stock go negative.

Run (needs Android SDK or a device with a dev build — WatermelonDB is a native module, Expo Go
will not work):

```bash
pnpm --filter @trawer/pos exec expo prebuild
pnpm --filter @trawer/pos android
```

Set the API address in `app.json` → `expo.extra.apiUrl`.
