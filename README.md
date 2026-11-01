# Trawer

Wholesale-first commerce + inventory for Nigerian traders: one live stock count across the web
storefront, WhatsApp, Instagram and an offline POS. See [ARCHITECTURE.md](ARCHITECTURE.md) and
[PROGRESS.md](PROGRESS.md).

```
apps/web       React SPA (Vite): storefront {slug}.trawer.shop + /dashboard
apps/api       Hono API: auth, checkout, webhooks, POS sync, cron — serves the SPA in production
packages/db    Supabase migrations, seed, DB test harness
packages/core  Shared domain logic: pricing, units, schemas, providers
```

## Local setup (8 steps)

1. Install Node 22+, pnpm 10 and PostgreSQL 16 (or use a Supabase project).
2. `pnpm install`
3. `cp .env.example .env.local` (defaults work locally: dev auth, fake payments, local storage).
4. Create the database with the demo shop: `DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @trawer/db db:reset -- --seed trawer`
5. Optional demo photos: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/trawer pnpm --filter @trawer/api exec tsx scripts/seed-images.ts`
6. Start the API: `pnpm --filter @trawer/api dev` (port 8787)
7. Start the web app: `pnpm --filter @trawer/web dev` (port 5173, proxies `/api`)
8. Open <http://localhost:5173/s/balogun> (shop) or <http://localhost:5173/dashboard>, sign in as the
   owner `08030000001` with code `000000`. Approved wholesaler buyer: `08090000001`.

On Supabase: `supabase link`, `supabase db push` (workdir `packages/db`), set `AUTH_MODE=supabase`,
configure phone auth with Termii, and use Paystack test keys.
