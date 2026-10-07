import { closePool, databaseUrl, describeDatabase, waitForDatabase } from '../client.js';
import { migrate } from '../migrate.js';

async function main(): Promise<void> {
  const where = describeDatabase(databaseUrl());
  if (where) console.log(`[migrate] ${where}`);
  await waitForDatabase();
  const result = await migrate();
  for (const name of result.applied) console.log(`[migrate] applied ${name}`);
  if (result.applied.length === 0) console.log('[migrate] already up to date');
  await closePool();
}

main().catch(async (error) => {
  console.error('[migrate] failed:', error instanceof Error ? error.message : error);
  await closePool();
  process.exit(1);
});
