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

## WhatsApp (Meta Cloud API)

1. In Meta Business Manager create a WhatsApp Business app; note the **phone number ID** and a
   **system-user access token** (whatsapp_business_messaging + catalog_management).
2. Webhook URL: `https://app.<your-domain>/api/webhooks/whatsapp`, verify token = `META_WEBHOOK_VERIFY_TOKEN`,
   subscribe to `messages`. Requests are verified with `META_APP_SECRET`.
3. In Trawer: Dashboard → Settings → WhatsApp: paste the phone number ID, optional catalogue ID and the
   token (stored in Supabase Vault, never shown again; needs your authenticator code).
4. Create these **utility** message templates (language `en`) — used for updates sent more than
   24 hours after the buyer's last message:

| Template | Body (variables in order) |
| --- | --- |
| `trawer_order_placed` | {{1}}: order #{{2}} is held for you. Pay {{3}} to your account number to confirm it. Track it: {{4}} |
| `trawer_payment_received` | {{1}} received for order #{{2}}. Thank you! {{3}} is getting it ready. Track it: {{4}} |
| `trawer_order_confirmed` | Order #{{1}} at {{2}} is confirmed. Balance to pay: {{3}}. Track it: {{4}} |
| `trawer_order_packed` | Order #{{1}} from {{2}} is packed and ready. Track it: {{3}} |
| `trawer_order_dispatched` | Order #{{1}} from {{2}} is on the way! Track it: {{3}} |
| `trawer_order_delivered` | Order #{{1}} from {{2}} has been delivered. Thank you for buying! |
| `trawer_delivery_failed` | We couldn't deliver order #{{1}} from {{2}}. We'll call you to arrange it. Details: {{3}} |
| `trawer_debt_reminder` | Hello from {{1}}. A friendly reminder: {{2}} is due on order #{{3}}. Pay to {{4}} ({{5}}). Thank you! |
| `trawer_wholesale_approved` | Good news! {{1}} has approved your wholesale account. Sign in to see your wholesale prices: {{2}} |

5. Schedule the jobs every minute (Supabase: `pg_cron` + `pg_net`, or any scheduler):
   `POST /api/cron/notifications`, `POST /api/cron/whatsapp-catalog` (every 15 min) and, where
   pg_cron is not available, `POST /api/cron/expire-reservations`, each with
   `Authorization: Bearer $CRON_SECRET`.
