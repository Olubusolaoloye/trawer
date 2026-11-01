import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  AUTH_MODE: z.enum(['supabase', 'dev']).default('dev'),
  PORT: z.coerce.number().default(8787),
  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  STORAGE_DRIVER: z.enum(['supabase', 'local']).default('local'),
  ROOT_DOMAIN: z.string().default('localhost:5173'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  WEB_DIST: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(['paystack', 'fake']).default('fake'),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PREFERRED_BANK: z.string().optional(),
  MESSAGING_PROVIDER: z.enum(['meta', 'console']).default('console'),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v23.0'),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().default('Trawer'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  STT_API_URL: z.string().optional(),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default('whisper-1'),
  CRON_SECRET: z.string().min(16).default('dev-cron-secret-change-me'),
  SENTRY_DSN: z.string().optional(),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.AUTH_MODE === 'dev') throw new Error('AUTH_MODE=dev is not allowed in production');
    if (env.PAYMENT_PROVIDER === 'fake') throw new Error('PAYMENT_PROVIDER=fake is not allowed in production');
    if (env.CRON_SECRET.startsWith('dev-')) throw new Error('Set CRON_SECRET in production');
  }
  return env;
}

export const env = load();
export const isDev = env.NODE_ENV !== 'production';
