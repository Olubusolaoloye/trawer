-- Indexes for the remaining slow paths found in the performance review.

-- Reports and the Today screen select sold orders by "confirmed (or created) time" per shop.
create index if not exists orders_sold_time_idx on public.orders (business_id, (coalesce(confirmed_at, created_at)))
  where status in ('confirmed', 'completed');

-- Customer search matches part of a phone number (phone like '%0803%'), like the name search.
create index if not exists customers_phone_trgm on public.customers using gin (phone extensions.gin_trgm_ops);

-- Special prices are read per shop in the POS price book.
create index if not exists customer_price_overrides_variant_idx on public.customer_price_overrides (business_id, variant_id);
