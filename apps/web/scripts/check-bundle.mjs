// Fails the build if anything secret-shaped or internal ends up in what browsers download.
// The browser bundle must only ever contain public values (the root domain).
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const FORBIDDEN = [
  [/sk_(live|test)_[A-Za-z0-9]+/, 'payment secret key'],
  [/sk-ant-[A-Za-z0-9_-]+/, 'AI API key'],
  [/eyJ[\w-]{10,}\.[\w-]{20,}\.[\w-]{10,}/, 'JWT / service token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/SERVICE_ROLE|SUPABASE_JWT_SECRET|CRON_SECRET|PAYSTACK_SECRET|META_APP_SECRET|WHATSAPP_ACCESS_TOKEN|ANTHROPIC_API_KEY|STT_API_KEY|TERMII_API_KEY|DATABASE_URL/, 'server env variable name'],
  [/postgres(ql)?:\/\/[^\s'"]+/, 'database connection string'],
  [/sourceMappingURL=/, 'source map reference'],
];

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = await walk(DIST);
const problems = [];
for (const f of files) {
  if (f.endsWith('.map')) {
    if (process.env.SOURCEMAP === 'hidden') continue; // kept only for the uploader step, which must delete them
    await rm(f);
    continue;
  }
  if (!/\.(js|css|html|json|webmanifest|svg|txt)$/.test(f)) continue;
  const text = await readFile(f, 'utf8');
  for (const [re, what] of FORBIDDEN) if (re.test(text)) problems.push(`${f.replace(DIST, '')}: ${what}`);
}
if (problems.length) {
  console.error('Bundle check failed — remove these from client code:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`bundle check ok (${files.length} files, no secrets, no source maps)`);
