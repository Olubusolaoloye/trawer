/** Push changed variants (stock, price, title) to each business's WhatsApp catalogue. */
import { metaSyncCatalog, type CatalogItem } from '@trawer/core/messaging';
import { many, withService } from './db';
import { env } from './env';
import { imageUrl } from './storage';
import { absoluteUrl } from './whatsapp';
import { logError } from './log';

export const catalogPushes: { businessId: string; items: CatalogItem[] }[] = []; // console mode record (dev/tests)

export async function syncWhatsAppCatalogs(): Promise<{ businesses: number; items: number }> {
  const businesses = await withService((tx) => many(tx,
    `select id, slug::text, whatsapp_catalog_id, whatsapp_catalog_synced_at, public.whatsapp_token(id) token
     from businesses where whatsapp_catalog_id is not null and status = 'active'`));
  let total = 0;
  for (const b of businesses) {
    const started = new Date();
    try {
      const rows = await withService((tx) => many(tx, `
        select v.sku, p.id product_id, p.name || coalesce(' · ' || nullif(concat_ws(' / ', v.colour, v.size), ''), '') title, p.description,
               v.retail_price_kobo, (v.is_active and p.status = 'active') live,
               coalesce((select sum(available) from stock_levels sl where sl.variant_id = v.id), 0)::int inventory,
               (select path from variant_images vi where vi.product_id = p.id and (vi.variant_id = v.id or vi.variant_id is null)
                order by vi.variant_id nulls last, vi.position limit 1) image
        from product_variants v join products p on p.id = v.product_id
        where v.business_id = $1 and (
          $2::timestamptz is null or greatest(v.updated_at, p.updated_at,
            coalesce((select max(updated_at) from stock_levels sl where sl.variant_id = v.id), v.updated_at)) > $2)
        limit 5000`, [b.id, b.whatsapp_catalog_synced_at]));
      const items: CatalogItem[] = rows.map((r) => ({
        retailerId: r.sku, title: r.title, description: r.description ?? '', priceKobo: r.retail_price_kobo,
        inventory: r.live ? r.inventory : 0, imageUrl: absoluteUrl(imageUrl(r.image, 960)),
        link: `https://${b.slug}.${env.ROOT_DOMAIN}/p/${r.product_id}`,
      }));
      if (items.length) {
        if (env.MESSAGING_PROVIDER === 'meta') await metaSyncCatalog(b.whatsapp_catalog_id, b.token ?? env.WHATSAPP_ACCESS_TOKEN ?? '', items, { graphVersion: env.META_GRAPH_VERSION });
        else catalogPushes.push({ businessId: b.id, items });
      }
      await withService((tx) => tx.query(`update businesses set whatsapp_catalog_synced_at = $2 where id = $1`, [b.id, started]));
      total += items.length;
    } catch (err) {
      logError(err, { job: 'whatsapp-catalog', business: b.id });
    }
  }
  return { businesses: businesses.length, items: total };
}
