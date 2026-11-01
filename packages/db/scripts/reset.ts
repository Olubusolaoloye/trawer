// Local dev: recreate the database from scratch (shim + migrations [+ seed]).
// Usage: DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres tsx scripts/reset.ts [--seed] [dbname]
import { resetDatabase } from '../src/migrate';

const adminUrl = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const args = process.argv.slice(2);
const seed = args.includes('--seed');
const name = args.find((a) => !a.startsWith('--')) ?? 'trawer';
const url = await resetDatabase(adminUrl, name, { seed });
console.log(`database ready: ${url.replace(/:[^:@/]+@/, ':***@')}`);
