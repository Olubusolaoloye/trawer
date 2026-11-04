# Performance

Each item from the speed checklist: what Trawer does, where, and how it is checked.
✅ done · ⏭ deliberately not done (with the reason) · 🛠 a deployment setting, not code.

Storefront home on a mid-range phone (Lighthouse, slow 4G + 4× CPU, real throttling): **LCP 1.7–1.8 s,
score 94–95, CLS 0** (target LCP ≤ 2.5 s).

## Loading and rendering

| Item | Status | How |
|---|---|---|
| Skeleton loading screens | ✅ | Every loading state is a layout-shaped skeleton (`PageSkeleton`, `ListSkeleton`, `ProductGridSkeleton` in `components/ui.tsx`); no spinners left. |
| Render on the server / at build time | ✅ | Store home pages are server-rendered with React (`apps/api/src/ssr.ts`, `entry-server.tsx`) and hydrate without refetching. |
| Split JavaScript by page | ✅ | Every route is a lazy chunk; buyers never download dashboard code; the Excel reader loads only on the import page. |
| Load third-party scripts after the page | ✅ | There are none (CSP `script-src 'self'`). Our own speed tracker starts when the browser is idle. |
| Lazy load images below the screen | ✅ | `loading="lazy"` + `decoding="async"` on every image except the ones that are the first thing painted (hero, product photo, logo). |
| Serve images as WebP / AVIF | ✅ | Uploads are stored as WebP; the image route serves AVIF to browsers that accept it (cached, `Vary: Accept`); Supabase picks the best format per browser. |
| Brotli / gzip | ✅ | Pre-compressed `.br`/`.gz` for build files, compressed JSON responses and server-rendered pages. |
| Virtualise long lists | ✅ | Lists are paginated (50–100 rows), and rows use `content-visibility: auto` so off-screen rows cost nothing; the 1,000-row import preview renders 150 rows at a time. A virtualisation library isn't needed at these sizes. |
| Prevent unnecessary re-renders | ✅ | Product cards are memoised (adding to cart no longer re-renders the grid); store context values are stable; data hooks subscribe per key. |

## Data and requests

| Item | Status | How |
|---|---|---|
| Prevent duplicate API calls | ✅ | `useApi` shares one request per key between components and caches it; buttons are disabled while their request runs; server-rendered data is reused on hydration. |
| Debounce search and autocomplete | ✅ | `useDebounced` (300 ms) on every typed search: orders, products, customers, post builder, till stock. |
| Update the UI before the server responds | ✅ | `optimistic()` in `lib/use-api.ts`: privacy switches, auto-post toggle, resolving stock alerts and removing special prices change at once and roll back on error. Cart changes are instant (stored on the phone). |
| Run independent requests in parallel | ✅ | Server: `Promise.all` throughout. Browser: independent saves run together (store designer). |
| Paginate API results | ✅ | Store products (cursor), dashboard orders/products (pages of 50), customers (100), reports by date range. |
| Timeouts on external API calls | ✅ | `fetchWithTimeout` on every outbound call: payments and WhatsApp 15 s, Instagram 30 s, catalogue sync 60 s, Supabase 10–30 s, Sentry 5 s; Claude 60 s with one retry. Database: 5 s to connect, 15 s per query. |
| Stream AI responses token by token | ⏭ | The only AI call fills a form (snap-to-upload) with a short structured draft; the form can't be used until the draft is complete, so streaming would add complexity without the owner seeing anything sooner. Revisit if a chat-style AI feature is added. |
| Move slow work to a background queue | ✅ | WhatsApp/SMS notifications, debt reminders, Instagram posts and catalogue syncs go through database queues processed by cron workers (`/api/cron/*`), with retries. Requests only do what the person is waiting for. |

## Database

| Item | Status | How |
|---|---|---|
| Fix N+1 queries | ✅ | Product creation (forms, snap, imports) now writes variants, costs, photos and opening stock in one statement each; tier prices and volume breaks likewise. Listing pages use set-based queries. |
| Indexes for common queries | ✅ | Migration 1500 adds the remaining ones: sold orders by confirmed time (reports, Today), customer phone search (trigram), special prices by variant. Listing, search and status indexes already existed. |
| Select only the columns you need | ✅ | The dashboard's business and product queries list their columns (this also stopped sending a secret reference and the store-design blob to the browser). |
| Connection pooling | ✅ 🛠 | `pg` pool per instance (`PG_POOL_MAX`, default 10) behind Supabase's pooler (Supavisor) in production. |

## Caching and infrastructure

| Item | Status | How |
|---|---|---|
| Cache frequently accessed data with Redis | ⏭ | Not needed yet. The hot pages are served from one server-rendered response with the data embedded, the browser cache shares requests, and Postgres answers the remaining queries in a few milliseconds with the indexes above. Most data is personal (wholesale prices differ per buyer), which is where shared caches go wrong. Adding Redis means another service to run, secure and keep consistent. Revisit when traces show the same query repeated across many requests. |
| Serve static files through a CDN | 🛠 | Build files have content hashes and `Cache-Control: immutable`, and come pre-compressed, so any CDN (Cloudflare, Bunny, CloudFront) can cache them forever. Put the CDN in front of `/assets/*` and `/media/*`; do **not** cache `/s/*` or `/api/*` (personal). |
| Servers close to the database | 🛠 | Run the API in the same region as the Supabase project. Supabase has no African region; pick the closest one to your users that your host also offers (London `eu-west-2` and Frankfurt `eu-central-1` are the usual choices for Nigeria) and put both there. |

## Measurement

| Item | Status | How |
|---|---|---|
| Real-user speed tracking | ✅ | `lib/vitals.ts` measures LCP, INP, CLS, FCP and TTFB on real visits and sends them to `/api/vitals` (our own server, no third party, no URL, no personal data). Stored in `web_vitals` for 90 days; p75 per page type at `GET /api/cron/vitals` (cron secret). |
| Trace slow backend requests (OpenTelemetry) | ✅ | Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces (incoming requests, every Postgres query, outbound calls) to any OTLP backend; query values are never recorded. Always on: a `Server-Timing` header on every response and a `slow_request` log line above `SLOW_REQUEST_MS` (default 1 s). |
| Remove unused dependencies | ✅ | Removed `clsx`, `zod` and `vitest` from the web app (unused there). |

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PG_POOL_MAX` | 10 | Database connections per API instance |
| `PG_QUERY_TIMEOUT_MS` | 15000 | Longest a single query may run |
| `SLOW_REQUEST_MS` | 1000 | Log requests slower than this |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (off) | Turns on OpenTelemetry tracing |
| `OTEL_SERVICE_NAME` | trawer-api | Service name in traces |
