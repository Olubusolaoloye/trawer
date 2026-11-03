/**
 * Getting products in fast: bulk import (spreadsheet rows / pasted lists, parsed in the browser by
 * @trawer/core/import) and snap-to-upload (photo + note → AI draft the owner confirms).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { productInput, type ProductInput } from '@trawer/core/schemas';
import { dbErrorCode, many, one } from '../db';
import { aiProvider, draft, photoForModel, type PriceHint } from '../ai';
import { imageUrl, putImage } from '../storage';
import { ApiError, body, requireUser, type AppEnv } from '../http';
import { limitUserAndIp } from '../limits';
import { createProduct } from '../products';
import { asStaff } from './dashboard';

export const catalogRoutes = new Hono<AppEnv>();

const importBody = z.object({
  dry_run: z.boolean(),
  duplicates: z.enum(['skip', 'add']).default('skip'),
  products: z.array(z.unknown()).min(1).max(1000),
});

interface ReportLine { index: number; name: string; variants: number; status: 'new' | 'duplicate' | 'invalid' | 'created' | 'failed' | 'skipped'; messages: string[] }

/**
 * POST /api/biz/:bid/import — `dry_run: true` checks everything and reports per product (nothing saved);
 * `dry_run: false` creates the valid ones, each in its own savepoint so one bad product never blocks the rest.
 */
catalogRoutes.post('/:bid/import', async (c) => {
  const claims = requireUser(c);
  const input = await body(c, importBody);
  if (!input.dry_run) await limitUserAndIp(c, 'import', claims.sub!, 20, 60);

  return asStaff(c, async (tx, b) => {
    const parsed = input.products.map((raw) => productInput.safeParse(raw));
    const names = parsed.flatMap((p) => (p.success ? [p.data.name.toLowerCase()] : []));
    const skus = parsed.flatMap((p) => (p.success ? p.data.variants.map((v) => v.sku).filter((s): s is string => !!s) : []));
    const [existingNames, existingSkus] = await Promise.all([
      names.length ? many<{ n: string }>(tx, `select lower(name) n from products where business_id = $1 and lower(name) = any($2::text[]) and status <> 'archived'`, [b, names]) : [],
      skus.length ? many<{ sku: string }>(tx, `select sku from product_variants where business_id = $1 and sku = any($2::text[])`, [b, skus]) : [],
    ]);
    const nameTaken = new Set(existingNames.map((r) => r.n));
    const skuTaken = new Set(existingSkus.map((r) => r.sku));
    const skuInBatch = new Map<string, number>();

    const report: ReportLine[] = [];
    const ok: { index: number; product: ProductInput }[] = [];
    parsed.forEach((p, index) => {
      const rawName = String((input.products[index] as { name?: unknown })?.name ?? '').slice(0, 200);
      if (!p.success) {
        report.push({ index, name: rawName, variants: 0, status: 'invalid', messages: p.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'product'}: ${i.message}`) });
        return;
      }
      const messages: string[] = [];
      for (const v of p.data.variants) {
        if (!v.sku) continue;
        if (skuTaken.has(v.sku)) messages.push(`SKU ${v.sku} is already used in your shop`);
        const seen = skuInBatch.get(v.sku);
        if (seen !== undefined && seen !== index) messages.push(`SKU ${v.sku} appears on two products in this file`);
        skuInBatch.set(v.sku, index);
      }
      if (messages.length) { report.push({ index, name: p.data.name, variants: p.data.variants.length, status: 'invalid', messages }); return; }
      if (nameTaken.has(p.data.name.toLowerCase()) && input.duplicates === 'skip') {
        report.push({ index, name: p.data.name, variants: p.data.variants.length, status: 'duplicate', messages: ['Already in your shop (skipped)'] });
        return;
      }
      report.push({ index, name: p.data.name, variants: p.data.variants.length, status: 'new', messages: [] });
      ok.push({ index, product: p.data });
    });

    if (input.dry_run) return c.json({ report, summary: summarise(report) });

    for (const { index, product } of ok) {
      const line = report.find((r) => r.index === index)!;
      await tx.query('savepoint import_one');
      try {
        await createProduct(tx, b, product);
        await tx.query('release savepoint import_one');
        line.status = 'created';
      } catch (err) {
        await tx.query('rollback to savepoint import_one');
        line.status = 'failed';
        line.messages = [dbErrorCode(err)];
      }
    }
    for (const r of report) if (r.status === 'duplicate') r.status = 'skipped';
    return c.json({ report, summary: summarise(report) });
  });
});

function summarise(report: ReportLine[]) {
  const count = (s: ReportLine['status']) => report.filter((r) => r.status === s).length;
  return { new: count('new'), created: count('created'), duplicate: count('duplicate'), skipped: count('skipped'), invalid: count('invalid'), failed: count('failed') };
}

/**
 * POST /api/biz/:bid/products/snap (multipart: file = photo, note = optional text, e.g. a voice note
 * turned into text on the phone). Stores the photo as the product image and returns an AI draft the
 * owner reviews in the normal product form. Nothing is created here.
 */
catalogRoutes.post('/:bid/products/snap', async (c) => {
  const claims = requireUser(c);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  const note = String(form?.get('note') ?? '').slice(0, 1000);
  if (!(file instanceof File)) throw new ApiError(422, 'file_required');
  if (file.size > 12 * 1024 * 1024) throw new ApiError(422, 'file_too_large');
  if (!/^image\/(jpeg|png|webp|heic|heif|avif)$/.test(file.type)) throw new ApiError(422, 'unsupported_image');
  if (!aiProvider()) throw new ApiError(503, 'ai_unavailable');
  const raw = Buffer.from(await file.arrayBuffer());

  // Staff check, photo storage and shop context first (in the transaction); the AI call happens after it.
  const ctx = await asStaff(c, async (tx, b) => {
    const [shop, hints, names] = await Promise.all([
      one<{ name: string; kind: string }>(tx, `select name, kind::text from businesses where id = $1`, [b]),
      many<PriceHint>(tx, `
        select coalesce(p.category, 'Other') category, count(distinct p.id)::int products,
               (min(v.retail_price_kobo) / 100)::int min_naira,
               (percentile_cont(0.5) within group (order by v.retail_price_kobo) / 100)::int median_naira,
               (max(v.retail_price_kobo) / 100)::int max_naira
        from products p join product_variants v on v.product_id = p.id and v.is_active
        where p.business_id = $1 and p.status = 'active' and v.retail_price_kobo > 0
        group by 1 order by products desc limit 15`, [b]),
      many<{ name: string }>(tx, `select name from products where business_id = $1 and status = 'active' order by created_at desc limit 8`, [b]),
    ]);
    return { b, shop: shop!, hints, names: names.map((n) => n.name) };
  });
  await limitUserAndIp(c, 'ai_draft', claims.sub!, 60, 150);
  const [stored, image] = await Promise.all([putImage('products', ctx.b, raw), photoForModel(raw)]);
  const result = await draft({
    image, note, shopName: ctx.shop.name, shopKind: ctx.shop.kind,
    categories: ctx.hints.map((h) => h.category).filter((x) => x !== 'Other'), priceHints: ctx.hints, exampleNames: ctx.names,
  });
  return c.json({ draft: result, image: { path: stored.path, url: imageUrl(stored.path, 640) } });
});
