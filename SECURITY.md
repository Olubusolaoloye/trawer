# Security & privacy review (milestone 11)

Each item says what protects it and which automated test proves it. Tests run on every change
(`pnpm test`, `pnpm --filter @trawer/web e2e`).

## Data access

| Check | How | Proof |
|---|---|---|
| RLS on every table | `alter table … enable row level security` in every migration | `db 01` “row level security enabled on every table”, generic cross-tenant read/update/delete/insert tests over all tables |
| Anonymous visitors can't write | No INSERT/UPDATE/DELETE/TRUNCATE grants for `anon` at all (migration 1300), on top of RLS | `db 11` “anonymous visitors have no write grants” |
| Only reviewed functions are public | Every function revokes `public, anon`; the 7 storefront functions open to visitors are an explicit allowlist | `db 11` “only the reviewed storefront functions are open” (fails if a new one appears) |
| No search_path hijacking | Every `SECURITY DEFINER` function sets `search_path = ''` | `db 11` “every SECURITY DEFINER function pins its search_path” |
| Secrets in Vault only | WhatsApp, Facebook/Instagram tokens in Supabase Vault; read only by service-role functions; reference columns hidden | `db 06`, `db 09`, `db 11` “app roles cannot read Vault secrets” |
| Money paths need 2FA | Staff, payout, price tiers, WhatsApp and social connections require an aal2 (TOTP) session | `db 01`, `db 09`, e2e MFA flows |
| Private files stay private | Delivery proof photos in a private bucket, served only after an RLS check; public pages show no names/phones/photos | `api deliveries`, `db 08` |

## Inputs and abuse

| Check | How | Proof |
|---|---|---|
| Input validation | Zod on every API body/query (zod 4.6.7 — fixes GHSA-mrhx-c7xc-m3w5); closed choice lists for anything rendered (store design) | per-route tests; `core storefront` |
| Request size | 1 MB JSON, 13 MB uploads, 16 KB error reports — refused before parsing | `api hardening` “oversized requests are refused” |
| Rate limits | OTP (5/phone, 30/IP per hour), sign-up (10/user, 40/IP), checkout (30/user, 120/IP), public token pages (300/IP), browser error reports, privacy requests, WhatsApp inbound | `db 01`, `api hardening` “checkout is rate limited” |
| Rate-limit counters can't be abused | `check_rate_limit` is server-only (it used to be callable by anyone, which would have let a stranger lock a buyer out of sign-in) | `db 01` |
| Real client IP | `X-Forwarded-For` only trusted for `TRUST_PROXY_HOPS` proxies, right-most entry | `api client-ip` |
| Webhook signatures | Paystack HMAC-SHA512, Meta `X-Hub-Signature-256`, constant-time compare; bad signature → empty 401 | `api storefront`, `api whatsapp` |
| CSRF | Cookie sessions + required `X-Trawer` header on every write; SameSite cookies | `api storefront` |
| OAuth state | Facebook Login state HMAC-signed, bound to the user + shop, 10-minute expiry | `api social` “forged state is refused” |
| CSV formula injection | Cells starting `= + - @` are neutralised in every download | `core csv`, `api reports` |
| Sessions | Refresh tokens rotate; parallel refreshes share one call so nobody is signed out by a race | `api hardening` “parallel requests … share one refresh” |

## Browser

| Check | How | Proof |
|---|---|---|
| No secrets in the bundle | Build fails on keys, JWTs, server env names, DB URLs, source maps | `scripts/check-bundle.mjs` (runs in `pnpm build`) |
| Headers | CSP `default-src 'self'` (fonts self-only, `frame-ancestors 'self'`), HSTS 2 years, `X-Frame-Options: SAMEORIGIN`, COOP, `Permissions-Policy` (camera/geolocation/payment off) | `api hardening` “security headers” |
| No third-party fonts or scripts | Fonts bundled; error reports go to our own origin and are relayed server-side | CSP above |

## Server rendering

| Check | How | Proof |
|---|---|---|
| Shop text can't inject markup | Every shop-typed value is HTML-escaped; page data travels in a non-executable `application/json` block with `<`, `>`, `&`, U+2028/9 escaped | `api ssr` “escapes whatever a shop owner types”, “embedded data can never close its script tag” |
| No data leaks between visitors | Rendering is synchronous; the data cache is cleared before and after every render | `entry-server.tsx` |
| Personal pages aren't cached publicly | `Cache-Control: private, no-cache`, `Vary: Cookie` | `api ssr`, e2e |
| Sessions stay valid | A session refreshed while rendering is passed on to the browser | manual check (refresh-token-only request) |

## Privacy (NDPA 2023)

| Right | Where | Proof |
|---|---|---|
| Consent at sign-up, per shop, withdrawable | Store → Account → Privacy & your data; append-only consent log | `db 11`, `api hardening` |
| Access / portability | “Download my data” (JSON, every shop) | `db 11`, `api hardening` |
| Erasure | “Delete my account” — needs a fresh SMS code + typing DELETE; refused while money is owed or while the person is staff; sales records kept without personal data; audited | `db 11`, `api hardening` |
| Storage limitation | Daily retention job: anonymises customers inactive past the shop's retention period (default 72 months), deletes message logs after 12 months, prunes raw webhooks after 90 days | `db 11` |
| No personal data in logs | Phones, emails, JWTs, keys and link tokens masked before logging or sending to Sentry | `api hardening` “scrubs …” |

## Accessibility

axe-core (WCAG 2.2 A/AA) on 7 storefront pages, tracking + invoice pages, 10 dashboard pages, and the
store home in all four themes: 0 violations (`e2e/a11y.spec.ts`).

## Known and accepted

- `pnpm audit --prod`: 2 moderate findings in `glob`/`minimatch` inside Expo's developer CLI
  (`@expo/cli`), which runs on a developer's machine only and is never shipped to phones or servers.
  Will clear with the next Expo SDK.
- Storefront performance (Lighthouse mobile, slow 4G + 4× CPU). Store home pages are server-rendered
  (`apps/api/src/ssr.ts`). Real throttling (devtools): LCP 1.7–2.1 s, score 90–95 (was 3.0–3.4 s without
  server rendering). Lighthouse's default simulated mode still estimates 2.6 s because it counts the app's
  JavaScript and fonts against first paint; the HTML paints before they arrive.
