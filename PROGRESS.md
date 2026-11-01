# Trawer — Progress

Status legend: ✅ done · 🟡 partial · ⬜ not started

## Milestone plan

| # | Milestone | Status | Notes |
| - | --- | --- | --- |
| 1 | Repo, auth, tenancy, RLS + tests | ✅ | 19 DB tests: RLS on every table, cross-tenant read/write/insert isolation (generic over all tables), permissions, MFA gating, buyer registration, rate limits |
| 2 | Products, variants, units, ledger + stock functions + tests | ✅ | 20 DB tests: ledger replay = stock_levels, all-or-nothing reservations, idempotent commit/release, device allocation, 40-way concurrency, no deadlocks |
| 3 | Price resolver + tests | ✅ | SQL `resolve_price` + TS mirror; parity test over 504 combinations; tier prices visible only to approved buyers |
| 4 | Storefront + checkout + payments (sandbox) | ✅ | `place_order`, Paystack DVA webhook (signed, idempotent), expiry, cancel, **50-way cross-channel concurrency test**; React storefront + dashboard; 12 API tests; 3 Playwright e2e tests; Balogun Fabrics seed |
| 5 | POS offline + sync + tests | ⬜ | `allocate_to_device` + device tables exist; sync function + Expo app next |
| 6 | WhatsApp bot + notifications | ⬜ | |
| 7 | Invoices, debtors' book | ⬜ | |
| 8 | Delivery tracking | ⬜ | |
| 9 | Instagram scheduler | ⬜ | |
| 10 | Reports | ⬜ | |
| 11 | Hardening | ⬜ | |

### Not yet built inside finished milestones
- Snap-to-upload (AI draft), bulk CSV/Excel import and barcode label PDFs are linked from the UI
  but their endpoints arrive with later work (product creation API they will call is done).
- Privacy page (`/privacy`) for NDPA export/delete: milestone 11.
- Supabase Storage bucket policies: local driver is used in dev; bucket SQL lands with hardening.

## Decisions and deviations from the brief

| Decision | Why |
| --- | --- |
| **Frontend is a React SPA (Vite + React 19 + React Router), not Next.js** — requested by the product owner for speed. A separate **Hono API (`apps/api`)** holds all server work. | Storefront ships ~98 KB gzipped JS on first load (React DOM is ~58 KB of it); the dashboard is code-split into lazy chunks so buyers never download it. The API serves the SPA on the same origin in production (no CORS, httpOnly cookies). |
| React Router in declarative mode (`BrowserRouter`), no TanStack Query (60-line SWR cache instead). | Cut ~17 KB gzipped vs the data-router + query library. |
| Live order status via Postgres `LISTEN/NOTIFY` + Server-Sent Events, polling fallback. Supabase Realtime publication also enabled. | Works on any host, no browser-side Supabase client or token exposure. Needs a session-mode DB connection (`DATABASE_LISTEN_URL`). |
| Migrations live in `packages/db/supabase/migrations` (Supabase CLI workdir = `packages/db`). | Keeps the brief's `packages/db` while staying Supabase CLI compatible. |
| API queries Postgres directly inside RLS-scoped transactions (`withUser`), instead of supabase-js → PostgREST. | Fewer round trips; RLS stays the enforcement point (same `role` + `request.jwt.claims` mechanism PostgREST uses); runs against plain Postgres in CI. Supabase Auth is used via its REST API. |
| `AUTH_MODE=dev` issues Supabase-shaped JWTs locally with OTP/TOTP code `000000`. Refused when `NODE_ENV=production`. | Local dev + e2e without SMS. Production uses Supabase phone OTP (Termii as SMS provider) and Supabase TOTP MFA. |
| `PAYMENT_PROVIDER=fake` simulates Paystack DVA + HMAC-signed webhooks (same webhook route). Refused in production. | Full checkout→transfer→confirmation flow runs offline. `PaystackProvider` targets test keys (`sk_test_…`). |
| CSRF: every non-GET `/api` call needs `X-Trawer: 1` + JSON; cookies are `SameSite=Lax; HttpOnly`. Webhooks/cron/POS are exempt (signature/secret/device token). | Simple and robust for a same-origin SPA. |
| SQL tests are Vitest + `pg` against a real Postgres, not pgTAP. | pgTAP isn't installed in the build environment; the brief allows "SQL tests". |
| Money is integer kobo (`bigint`) everywhere. | Avoids float rounding. |
| Dev/test use a shim (`packages/db/test/supabase-shim.sql`) providing `auth.users`, `auth.uid()`, `auth.jwt()`, API roles and a minimal `vault`. | No Docker daemon or GitHub downloads in the build env. Migrations are unchanged for real Supabase. |
| Transfers to a DVA carry no order id: allocated to an open order whose balance equals the amount (newest), else the oldest pending order, else oldest with a balance; remainder kept unallocated on the customer. | Matches how traders reconcile transfers. |
| Paid-after-expiry orders re-reserve stock if available, else are flagged `needs_attention` (money kept). | Never oversell, never lose a payment. |
| Payments to virtual accounts require the business's Paystack settlement subaccount (`payout_account_missing` otherwise). | "Never hold funds": money settles straight to the trader. |

## How to run the tests

```bash
pnpm --filter @trawer/core test      # pure domain logic
pnpm --filter @trawer/db test        # SQL / RLS / ledger / concurrency (needs local Postgres)
pnpm --filter @trawer/api test       # API integration
pnpm --filter @trawer/web build && pnpm --filter @trawer/web e2e   # Playwright against seeded DB
```
