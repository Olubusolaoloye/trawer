import pg from 'pg';

/** Fresh rate-limit windows for each run (the e2e suite reuses seeded phone numbers). */
export default async function globalSetup() {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev' });
  await c.connect();
  await c.query('delete from rate_limits');
  await c.end();
}
