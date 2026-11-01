# Trawer — Progress

Status legend: ✅ done · 🟡 partial · ⬜ not started

## Milestone plan

| # | Milestone | Status |
| - | --- | --- |
| 1 | Repo, auth, tenancy, RLS + tests | ⬜ |
| 2 | Products, variants, units, ledger + stock functions + tests | ⬜ |
| 3 | Price resolver + tests (SQL + TS parity) | ⬜ |
| 4 | Storefront + checkout + payments (Paystack sandbox) | ⬜ |
| 5 | POS offline + sync + tests | ⬜ |
| 6 | WhatsApp bot + notifications | ⬜ |
| 7 | Invoices, debtors' book | ⬜ |
| 8 | Delivery tracking | ⬜ |
| 9 | Instagram scheduler | ⬜ |
| 10 | Reports | ⬜ |
| 11 | Hardening | ⬜ |

## Decisions and deviations from the brief

| Decision | Why |
| --- | --- |
| Migrations live in `packages/db/supabase/migrations` (Supabase CLI workdir = `packages/db`). | Keeps the brief's `packages/db` while staying Supabase CLI compatible. |
| Web server queries Postgres directly inside RLS-scoped transactions (`withUser`), instead of supabase-js → PostgREST. | Fewer round trips for SSR, and RLS stays the enforcement point (same `role` + `request.jwt.claims` mechanism PostgREST uses). It also lets the app and e2e tests run against plain Postgres in CI. supabase-js is still used for Auth and Realtime. |
| SQL tests are Vitest + `pg` against a real Postgres, not pgTAP. | pgTAP isn't installed in the build environment; the brief allows "SQL tests". |
| Money is stored as integer kobo (`bigint`). | Avoids float rounding. |
| Development without Supabase uses a shim (`packages/db/test/supabase-shim.sql`) that provides `auth.users`, `auth.uid()`, `auth.jwt()`, the `anon`/`authenticated`/`service_role` roles and a minimal `vault`. | Local Postgres has no Supabase stack (no Docker daemon or GitHub downloads in the build env). Migrations themselves are unchanged. |
