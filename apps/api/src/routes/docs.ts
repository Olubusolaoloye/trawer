/** Public invoices / receipts by unguessable token: JSON for the web page, and the PDF. */
import { Hono } from 'hono';
import { one, withService } from '../db';
import { env } from '../env';
import { ApiError, type AppEnv } from '../http';
import { renderDocumentPdf, type DocData } from '../pdf';
import { imageUrl } from '../storage';

export const docRoutes = new Hono<AppEnv>();
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

async function load(token: string): Promise<DocData & { business: { logo_path: string | null; slug: string } }> {
  if (!TOKEN.test(token)) throw new ApiError(404, 'not_found');
  const d = await withService((tx) => one<{ d: any }>(tx, `select public.document_by_token($1) d`, [token]));
  if (!d?.d) throw new ApiError(404, 'not_found');
  return d.d;
}

docRoutes.get('/:token', async (c) => {
  const d = await load(c.req.param('token'));
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  return c.json({ ...d, business: { ...d.business, logo_url: imageUrl(d.business.logo_path, 200) } });
});

docRoutes.get('/:token/pdf', async (c) => {
  const token = c.req.param('token');
  const d = await load(token);
  const bytes = await renderDocumentPdf(d, new URL(`/i/${token}`, env.APP_URL).toString());
  return c.body(new Uint8Array(bytes), 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${d.number}.pdf"`,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  });
});
