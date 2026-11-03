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

## Production checklist

- Schedule the cron jobs (`Authorization: Bearer $CRON_SECRET`): `notifications` and `social` every minute, `whatsapp-catalog` every 15 minutes, `debt-reminders` and `retention` daily (on Supabase, `expire_reservations` and `apply_retention` also run via pg_cron).
- Set `SENTRY_DSN` to receive server and browser errors (browser errors are relayed through `/api/client-errors`, so no third-party script is added to pages). Personal data is masked before sending.
- Behind a load balancer/CDN set `TRUST_PROXY_HOPS`.
- Serve `apps/web/dist` through the API (it sends the pre-compressed `.br`/`.gz` files) or a CDN that honours them.
- Deploy `apps/web/dist-ssr` next to `dist` (both come from `pnpm --filter @trawer/web build`): the API then server-renders store home pages (`apps/api/src/ssr.ts`). Without it, store homes fall back to the browser-rendered app. Store home HTML is personal (wholesale prices), so it is sent `Cache-Control: private` — don't put a shared cache in front of `/s/*` or shop subdomains' `/`.
- See SECURITY.md for the review and what each protection is tested by.

## Deliveries

1. Invite riders in Dashboard → Settings → Staff with the **rider** role.
2. Riders sign in to the Trawer POS app with their phone number; they only see **Deliveries** and **Settings**.
3. On an order: Mark packed → pick a rider → Send out for delivery. The rider's app shows it; they tap Start, then Delivered (camera proof) or Couldn't deliver (reason). Buyers get WhatsApp updates at every step and can follow the public tracking link.
4. Behind a load balancer/CDN, set `TRUST_PROXY_HOPS` to the number of proxies so rate limits see the real client IP.

## Instagram & Facebook posting

Sandbox by default (`SOCIAL_PROVIDER=console`): connecting and posting work end to end, nothing leaves the server.

For real posting:
1. In your Meta app add **Facebook Login for Business** and the permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`, `instagram_basic`, `instagram_content_publish` (needs App Review for other businesses).
2. Add `${APP_URL}/api/social/callback` as a valid OAuth redirect URI.
3. Set `SOCIAL_PROVIDER=meta`, `META_APP_ID`, `META_APP_SECRET`.
4. Schedule `POST /api/cron/social` every minute (with `Authorization: Bearer $CRON_SECRET`).
5. The shop's Instagram must be a Business/Creator account linked to a Facebook Page. Instagram fetches photos from `${APP_URL}/api/social/image/…jpg`, so `APP_URL` must be public.

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
   pg_cron is not available, `POST /api/cron/expire-reservations`; plus once a day
   `POST /api/cron/debt-reminders` (WhatsApp reminders for overdue credit sales), each with
   `Authorization: Bearer $CRON_SECRET`.

## Clickable demo (no server)

`apps/web` has a demo build that runs the real app with sample data and an in-browser stand-in for the API
(`src/demo/mock.ts`), using hash URLs so it can be hosted as one static page. Normal builds contain none of it.

```bash
pnpm --filter @trawer/db exec tsx scripts/reset.ts --seed trawer_demo   # fresh sample shop
# start the API on :8811 against trawer_demo (AUTH_MODE=dev, PAYMENT_PROVIDER=fake, WEB_DIST=apps/web/dist)
node apps/web/scripts/demo/enrich.cjs                                     # credit, deliveries, expenses, social posts
DEMO_BID=<business id> node apps/web/scripts/demo/record.cjs fixtures.json  # record real API answers
node apps/web/scripts/demo/extra.cjs extra.json                           # prices + an order lifecycle
node apps/web/scripts/demo/merge.cjs fixtures.json extra.json             # → src/demo/data.json (not committed)
pnpm --filter @trawer/web build:demo && node apps/web/scripts/demo/artifact-page.mjs
```

Sign in as the owner with 0803 000 0001 or as a buyer with 0809 000 0001, code 000000.
