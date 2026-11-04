/**
 * Object storage for product photos, proof-of-delivery photos and wholesale applications.
 * Images are normalised to WebP (max 1600px) on upload; the storefront asks for resized
 * variants (Supabase image transformations, or sharp on the fly for the local driver).
 */
import { fetchWithTimeout } from '@trawer/core/http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { env } from './env';

// Uploads can be up to 12 MB on a slow link: generous, but never unbounded.
const http = fetchWithTimeout(30_000);

export type Bucket = 'products' | 'proofs' | 'applications';
const PUBLIC_BUCKETS: Bucket[] = ['products'];
const LOCAL_ROOT = resolve(process.cwd(), '.uploads');

export async function putImage(bucket: Bucket, prefix: string, input: Buffer): Promise<{ path: string; width: number; height: number }> {
  const img = sharp(input, { failOn: 'error' }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
  const { data, info } = await img.webp({ quality: 78 }).toBuffer({ resolveWithObject: true });
  const path = `${prefix.replace(/[^a-zA-Z0-9/_-]/g, '')}/${randomUUID()}.webp`;
  if (env.STORAGE_DRIVER === 'supabase') {
    const res = await http(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'image/webp', 'x-upsert': 'false' },
      body: data,
    });
    if (!res.ok) throw new Error(`storage upload failed: ${res.status}`);
  } else {
    const file = join(LOCAL_ROOT, bucket, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  return { path, width: info.width, height: info.height };
}

/** URL for an image at a given width. Private buckets are only served through authenticated routes. */
export function imageUrl(path: string | null | undefined, width = 640, bucket: Bucket = 'products'): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  if (env.STORAGE_DRIVER === 'supabase' && PUBLIC_BUCKETS.includes(bucket)) {
    return `${env.SUPABASE_URL}/storage/v1/render/image/public/${bucket}/${path}?width=${width}&quality=75`; // Supabase picks WebP/AVIF per browser
  }
  return `/media/${bucket}/${path}?w=${width}`;
}

const resizedCache = new Map<string, Buffer>();

/** Local driver only: read + resize (cached). Returns null when missing or outside the root. */
export async function readLocalImage(bucket: Bucket, path: string, width: number, format: 'webp' | 'avif' = 'webp'): Promise<Buffer | null> {
  const file = normalize(join(LOCAL_ROOT, bucket, path));
  if (!file.startsWith(join(LOCAL_ROOT, bucket))) return null;
  const w = [96, 200, 400, 640, 960, 1600].find((x) => x >= width) ?? 1600;
  const key = `${file}@${w}.${format}`;
  const hit = resizedCache.get(key);
  if (hit) return hit;
  const src = await readFile(file).catch(() => null);
  if (!src) return null;
  const resized = sharp(src).resize({ width: w, withoutEnlargement: true });
  // AVIF is ~20–30% smaller than WebP at the same look; slower to encode, so it's cached like WebP.
  const out = await (format === 'avif' ? resized.avif({ quality: 50, effort: 4 }) : resized.webp({ quality: 72 })).toBuffer();
  if (resizedCache.size > 500) resizedCache.clear();
  resizedCache.set(key, out);
  return out;
}

export function isPublicBucket(b: string): b is Bucket {
  return (PUBLIC_BUCKETS as string[]).includes(b);
}

/**
 * Private images (proof-of-delivery): only ever returned by routes that have already checked the
 * caller may see the record. Never exposed under /media.
 */
export async function readPrivateImage(bucket: Exclude<Bucket, 'products'>, path: string, width: number): Promise<Buffer | null> {
  if (!/^[A-Za-z0-9/_-]+\.webp$/.test(path)) return null;
  if (env.STORAGE_DRIVER !== 'supabase') return readLocalImage(bucket, path, width);
  const res = await http(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, { headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!res.ok) return null;
  const src = Buffer.from(await res.arrayBuffer());
  return sharp(src).resize({ width: Math.min(width, 1600), withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
}

/** Original bytes of a public product image (used to make Instagram-ready JPEGs). */
export async function readProductOriginal(path: string): Promise<Buffer | null> {
  if (!/^[A-Za-z0-9/_-]+\.webp$/.test(path)) return null;
  if (env.STORAGE_DRIVER === 'supabase') {
    const res = await http(`${env.SUPABASE_URL}/storage/v1/object/public/products/${path}`);
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }
  const file = normalize(join(LOCAL_ROOT, 'products', path));
  if (!file.startsWith(join(LOCAL_ROOT, 'products'))) return null;
  return readFile(file).catch(() => null);
}
