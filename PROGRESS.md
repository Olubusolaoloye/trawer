# Trawer — Progress

Status legend: ✅ done · 🟡 partial · ⬜ not started

## Milestone plan

| # | Milestone | Status | Notes |
| - | --- | --- | --- |
| 1 | Repo, auth, tenancy, RLS + tests | ✅ | 19 DB tests: RLS on every table, cross-tenant read/write/insert isolation (generic over all tables), permissions, MFA gating, buyer registration, rate limits |
| 2 | Products, variants, units, ledger + stock functions + tests | ✅ | 20 DB tests: ledger replay = stock_levels, all-or-nothing reservations, idempotent commit/release, device allocation, 40-way concurrency, no deadlocks |
| 3 | Price resolver + tests | ✅ | SQL `resolve_price` + TS mirror; parity test over 504 combinations; tier prices visible only to approved buyers |
| 4 | Storefront + checkout + payments (sandbox) | ✅ | `place_order`, Paystack DVA webhook (signed, idempotent), expiry, cancel, **50-way cross-channel concurrency test**; React storefront + dashboard; 12 API tests; 3 Playwright e2e tests; Balogun Fabrics seed |
| 5 | POS offline + sync + tests | ✅ | `sync_pos_sale` (idempotent; allocation → shared pool → recorded conflict, never negative), cash-up; `@trawer/core/pos` engine (multi-cart, offline allocation budget, outbox, receipts); bearer-token POS API; Expo app (WatermelonDB, camera scan, BLE printer, WhatsApp receipt, cash-up); dashboard Tills page. Tests: 9 DB (incl. two-device + online storm), 6 core engine, 5 API (two real engines syncing, lost-ack retry), 2 WatermelonDB repo tests. Android JS bundle builds (Hermes); native APK not built here (no Android SDK) |
| 6 | WhatsApp bot + notifications | ✅ | Bot state machine in `@trawer/core/whatsapp` (menu, categories, search incl. "how much…", colour, piece/bundle/carton, "2 cartons" parsing, stock guard, cart, pickup/delivery, place order, transfer details, my orders, hand-off to a person). Signed webhook (one processing per message id), first-contact customers, per-business number + Vault token (MFA, write-only). Notification outbox filled by DB triggers (placed, paid, credit-confirmed, packed, dispatched, delivered, failed, wholesale approved; de-duplicated), cron sender: free text inside 24 h, approved templates outside, retries with back-off, Meta read receipts. Catalogue sync of live stock (delta). Public tracking page `/t/:token` (from M8). Tests: 9 core bot + 3 helpers, 12 API (incl. same tier price on web and WhatsApp), 5 DB, 2 e2e. Debt-reminder sending lands with M7 (template + kind ready). |
| 7 | Invoices, debtors' book | ✅ | Migration 0800: `invoices` (INV-/RCT- numbers per shop, one invoice per order, a receipt auto-issued for every payment, unguessable public token) and a signed `credit_entries` ledger fed by triggers (charge when a credit sale confirms, payment entries as it is paid). `confirm_on_credit` (needs `credit.manage`, enforces the credit limit, clears the approval flag, audited), shop default credit terms (7 days), `set_due_date`, `debtors_report` (overdue + ageing 1–30/31–60/60+), `customer_statement` (running balance). Debt reminders: daily cron from the due date, then weekly, max 4, de-duplicated per day; manual "Remind on WhatsApp". Public invoice page `/i/:token` + server-rendered PDF (pdf-lib, embedded Inter — no font requests), no phone numbers on public documents. Dashboard: "Who owes you" book, statements, sell-on-credit / due date / remind on the order, invoice & receipts with View / PDF / WhatsApp share; buyers get an invoice from their order page. Credit buyers are issued a transfer account so every invoice shows where to pay. Tests: 8 DB (incl. consent opt-out), 4 API, 1 e2e. |
| 8 | Delivery tracking | ✅ | Migration 1000: `deliveries` (address snapshot, rider, cash to collect, attempts, timestamps per stage, private proof photo, received by) + append-only `delivery_events`. One function, `set_fulfilment`, enforces confirmed → packed → dispatched → delivered / failed (reason required) → retry or returned (stock goes back once), pickups packed → collected; delivered needs a proof photo from the shop's own uploads; riders may only move their assigned deliveries; idempotent on client id; audited; delivered/collected completes the order. `assign_rider`, `my_deliveries` (run sheet), `order_delivery` (staff vs buyer views), `tracking_events` (public: status + time only). WhatsApp updates per attempt with rider first name + cash to collect. POS: Deliveries tab (riders see only Deliveries + Settings): run sheet by stage, one-tap Start / Delivered (camera proof + received by) / Couldn't deliver (reasons) / Try again, map, call, WhatsApp; offline outbox with photo-first upload and cached run sheet. Dashboard: delivery card with timeline, rider picker, actions, proof upload + private viewer. Public tracking + buyer order page show times, rider name and failed state. Tests: 5 DB, 2 API, 3 POS, 1 e2e. |
| 9 | Instagram scheduler | ✅ | Migration 1100: `social_accounts` (token in Vault, quota cache), `social_posts`, short-lived `social_connect_sessions`. Facebook Login with HMAC-signed, user-bound, 10-minute state; callback stores candidate Pages (tokens straight to Vault), owner picks one under MFA and the rest are destroyed; disconnect cancels waiting posts and deletes the token. `SocialProvider` (Meta Graph with appsecret_proof on every call; console sandbox): Instagram single + carousel (containers, status polling, publish, permalink), Facebook photo + multi-photo posts, `content_publishing_limit` checked before every Instagram publish. Scheduler (cron `/api/cron/social`, SKIP LOCKED): back-off 2/8/18/32 min, 5 attempts; Instagram limit or Graph rate limit waits an hour without using an attempt; dead token marks the account “reconnect”. Captions from the shop template (name, price, colours, link) or a numbered new-arrivals carousel, within 2,200 chars / 30 hashtags. Product auto-post when a product goes live. Instagram-ready JPEG endpoint pads WebP photos to 4:5…1.91:1. Dashboard: Social posts page (connect, accounts + quota, composer with product picker, live Instagram preview, now/later, posts by status with retry/cancel) and Post-to-Instagram + auto-post on products. Tests: 6 DB, 6 core, 4 API, 1 e2e. |
| 10 | Reports | ⬜ | |
| 11 | Hardening | ⬜ | |

### Design: Market Light (applied across web + POS)
Design canvas: claude.ai artifact "Trawer — UI/UX Design" (17 screens, flows, design system).
Tokens: ink #0E1411 · paper #FAF7F0 · green #0B7A4B (money/actions) · indigo #23308C (wholesale only)
· gold #F2B705 (highlight fill only) · red #C8261B (act now) · each storefront uses the shop's brand colour.
Type: Bricolage Grotesque (display, prices) + Inter (UI). Pidgin (`pcm`) translations for storefront + Today.
Backed by new `dashboard_today()` (Today command centre) and buyer `owing_kobo` / saved account on store info.
Shown in the design but waiting for their milestones (no placeholder buttons in the app): AI snap-to-upload,
debt reminders (M7), WhatsApp bot (M6), rider/delivery steps (M8), Instagram posting (M9).

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

| POS models use explicit accessors instead of WatermelonDB decorators. | Avoids a Babel decorators transform that conflicts with Expo SDK 58's Babel preset; identical runtime behaviour. |
| POS auth: phone OTP on the till, tokens returned in the body (`X-Client: pos`) and stored in the keystore; `/api/pos/*` accepts bearer tokens only. | POS endpoints are CSRF-exempt, so they must never accept ambient browser cookies. |
| Offline sales keep the price the till charged (`price_source = pos_offline`); a mismatch with the current server price flags the order `offline_price_mismatch` for review. Cashier credit sales are flagged `credit_sale_needs_approval`. | The sale already happened; the server records truth and surfaces anomalies instead of rejecting. |
| WhatsApp buyers are identified by their WhatsApp number; first contact creates a retail customer (lawful basis: fulfilling their request). Marketing opt-in stays false. | NDPA: no marketing without opt-in. |
| WhatsApp hand-off: "agent/person" pauses the bot for 12 h (or until the buyer types "menu"); staff see waiting chats on Today and reply from their own WhatsApp. | Unified inbox is out of scope for Phase 1. |
| Self-hosted fonts (`@fontsource`), no source maps in production, bundle secret scan in `build`, uniform auth errors. | Requested by the product owner: no third-party font requests, don't reveal key/API structure. |
| POS bootstrap returns up to 20,000 changed variants per call (delta by `updated_at`). | Enough for first sync of most shops; paging for 50k+ catalogues is a hardening item. |

- **Invoice PDFs** are rendered on the server with pdf-lib and the Inter TTF embedded in full (pdf-lib's subsetter dropped glyphs, incl. ₦, from these builds). ~370 KB per PDF; fine for WhatsApp, revisit with a subsetted static font if bandwidth matters.
- **Debt reminders**: first on the due date, then every 7 days, at most 4 per order; never to buyers who withdrew WhatsApp consent. Shops can switch them off (`debt_reminders_enabled`).
- **Public documents** use 18-byte random tokens and show names, items, totals and the pay-to account — never phone numbers. Responses are `no-store` + `noindex`.

### Store designer + UI refresh (v2)
- **Owners customise their store** at Dashboard → Store design, with a live phone/desktop preview (the real store in a same-origin iframe, fed the draft by `postMessage` with origin + source checks). Choices: logo, shop colour, theme (Market, Linen, Midnight, Bold), headline font (Modern, Elegant, Friendly, Clean), header (colour, clean, glass), product cards (classic, photo, minimal), corners, grid density, banner (photo, headline, button → category), announcement bar, featured collection, section order + visibility, about text, Instagram/TikTok/WhatsApp, optional "only N left" badges (≤ 10 only).
- **Safe by construction**: the design is a closed set of choices + bounded text validated by `@trawer/core/storefront` (zod); no CSS/HTML from shops; banner photos must be the shop's own uploads; saved via `set_storefront` (needs `settings.manage`, audited). Migration 0900.
- **Theming** maps choices onto CSS variables (`lib/theme.ts`); storefront components use theme tokens (`surface`, `paper`, `ink`…) so dark and bold themes work everywhere. Extra fonts (Fraunces, Nunito) are bundled and lazy-loaded only for shops that pick them — no third-party font requests.
- **UI refresh**: soft depth (card shadows instead of hard outlines), glass headers and floating cart, focus halos, press feedback, page-rise transitions, staggered grids, shimmer skeletons instead of spinners, image zoom on hover, hero banners, icon sidebar with active accent, glass bottom bar on phones, Today prompt to design the store.
- **Security headers**: CSP (`default-src 'self'`, fonts self-only, `frame-ancestors 'self'`), `X-Frame-Options: SAMEORIGIN` (needed for the designer preview only).
- Tests: 3 core, 3 API, 1 e2e (designer → live preview → publish → buyers see it).

### POS refresh (v2 look)
- Same Market Light v2 language as the web app: glowing ink header with the shop initial and a breathing "Live" dot, rounded content sheet, soft shadows instead of hard outlines, lucide icons everywhere (react-native-svg), spring press feedback + haptics (expo-haptics), bottom sheets on phones / centred dialogs on tablets.
- Sell: cart chips with item-count badges, icon search + scan button, product tiles with photo or colour thumbnail, line cards with a pill stepper (bin icon at qty 1), customer pill, big total, Charge button; scanner gets an aim frame. Tablet empty state prompts scan/search.
- Pay: method tiles (Cash, Card, Transfer, USSD, QR, split by tapping several), quick-cash chips (Exact / next round note), live "Change to give / Still to pay", switches for credit + manager override.
- Receipt: animated success mark, big change-to-give, Print / WhatsApp / Next customer.
- Cash-up: ink "taken today" card, per-method table with icons, ink display + soft keypad with `00` key (hold ⌫ to clear).
- Sign-in, setup and settings rebuilt with grouped rows. On phones the offline pill uses a short label so the shop name stays readable.
- Native deps pinned to Expo SDK 58's own table (react-native-svg 15.16.0, expo-haptics ~58.0.7). Fonts remain bundled.

- **Proof photos are private** (`proofs` bucket, never under `/media`): staff fetch them through an RLS-checked route; buyers and the public tracking page get the timeline only. Proof paths must belong to the shop that owns the order.
- **Riders work offline**: status updates queue on the phone (WatermelonDB key-value store) with a client id; the photo uploads first and its server path is saved before the status is sent, so a dropped connection never re-uploads or double-records. Updates the server rejects are reported and skipped so they can't block the queue. The proof photo stays in the phone's cache until sent.
- **Debtors' book order** (fix): equal overdue amounts are now ordered by days late, then balance (migration 1010).
- **Client IP for rate limits** (security fix): `X-Forwarded-For` is only read when `TRUST_PROXY_HOPS` > 0, and then the entry written by our own proxy is used, not the client-typed left-most one. Default is the socket address.

- **Social tokens**: Page tokens (from a long-lived user token, so they don't expire) live only in Vault; the API never returns them and staff can't even read the secret reference column. The OAuth `state` is HMAC-signed, bound to the signed-in user and shop, and expires in 10 minutes. Number-only tags such as a product's “#001” don't count as hashtags (Instagram doesn't link them).
- **Phones**: `scroll-padding-bottom` keeps scrolled-to and focused controls clear of the fixed bottom bars (WCAG 2.4.11).

## How to run the tests

```bash
pnpm --filter @trawer/core test      # pure domain logic
pnpm --filter @trawer/db test        # SQL / RLS / ledger / concurrency (needs local Postgres)
pnpm --filter @trawer/api test       # API integration
pnpm --filter @trawer/pos test       # WatermelonDB repositories (LokiJS adapter)
pnpm --filter @trawer/web build && pnpm --filter @trawer/web e2e   # Playwright against seeded DB
```
