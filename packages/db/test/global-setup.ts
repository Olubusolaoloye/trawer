import { resetDatabase } from '../src/migrate';

export default async function setup() {
  const admin = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const url = await resetDatabase(admin, 'trawer_test');
  process.env.TEST_DATABASE_URL = url;
}
