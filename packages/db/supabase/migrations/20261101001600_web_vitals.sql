-- Real-user speed measurements (Core Web Vitals) sent by browsers to our own API.
-- No personal data: page type only (no URL, no IP, no user), connection type and device class.
create table public.web_vitals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  page text not null check (page ~ '^[a-z_]{1,40}$'),
  ssr boolean not null default false,
  mobile boolean not null default true,
  connection text check (connection is null or connection ~ '^[a-z0-9-]{1,10}$'),
  lcp_ms int check (lcp_ms between 0 and 120000),
  fcp_ms int check (fcp_ms between 0 and 120000),
  ttfb_ms int check (ttfb_ms between 0 and 120000),
  inp_ms int check (inp_ms between 0 and 60000),
  cls numeric(6, 4) check (cls between 0 and 50)
);
create index web_vitals_time_idx on public.web_vitals (created_at desc, page);
alter table public.web_vitals enable row level security; -- no policies: only the server (service role) reads/writes
revoke all on public.web_vitals from public, anon, authenticated;

-- p75 per page type over the last 7 days ("good" targets: LCP ≤ 2500 ms, INP ≤ 200 ms, CLS ≤ 0.1).
create view public.web_vitals_p75 with (security_invoker = true) as
select page, ssr, count(*) as visits,
  percentile_cont(0.75) within group (order by lcp_ms) filter (where lcp_ms is not null)::int as lcp_p75_ms,
  percentile_cont(0.75) within group (order by inp_ms) filter (where inp_ms is not null)::int as inp_p75_ms,
  round((percentile_cont(0.75) within group (order by cls) filter (where cls is not null))::numeric, 3) as cls_p75,
  percentile_cont(0.75) within group (order by ttfb_ms) filter (where ttfb_ms is not null)::int as ttfb_p75_ms,
  percentile_cont(0.75) within group (order by fcp_ms) filter (where fcp_ms is not null)::int as fcp_p75_ms
from public.web_vitals
where created_at > now() - interval '7 days'
group by page, ssr;
revoke all on public.web_vitals_p75 from public, anon, authenticated;
