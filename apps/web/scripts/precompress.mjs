// Brotli + gzip copies of every text asset, so the server sends compressed bytes with no runtime cost.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const DIST = new URL('../dist/', import.meta.url).pathname;
async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p))); else out.push(p);
  }
  return out;
}
let saved = 0;
for (const f of await walk(DIST)) {
  if (!/\.(js|css|html|svg|json|webmanifest|txt)$/.test(f)) continue;
  const raw = await readFile(f);
  if (raw.length < 1024) continue;
  const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  await writeFile(`${f}.br`, br);
  await writeFile(`${f}.gz`, gzipSync(raw, { level: 9 }));
  saved += raw.length - br.length;
}
console.log(`precompressed (brotli saves ${Math.round(saved / 1024)} KB)`);
