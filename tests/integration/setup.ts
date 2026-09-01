/**
 * Integration setup.
 *
 * Fails fast and loudly when the services are not reachable, naming the two
 * ways to start them, rather than letting every test time out one by one.
 */
import { Client } from 'pg';
import { testConfig } from './harness';

const config = testConfig();

const client = new Client({ connectionString: config.DATABASE_URL });
try {
  await client.connect();
  await client.query('SELECT 1');
  await client.end();
} catch (error) {
  throw new Error(
    `Cannot reach PostgreSQL at ${config.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}.\n` +
      'Start the development services first:\n' +
      '  docker compose up -d         (when a Docker daemon is available)\n' +
      '  bash scripts/dev-services.sh (native PostgreSQL and Redis, no daemon needed)',
    { cause: error },
  );
}
