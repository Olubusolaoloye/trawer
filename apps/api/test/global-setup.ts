import { resetDatabase } from '@trawer/db/migrate';

export default async function setup() {
  await resetDatabase(process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres', 'trawer_api_test');
}
