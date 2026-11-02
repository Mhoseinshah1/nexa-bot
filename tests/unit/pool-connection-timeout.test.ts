import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  POOL_CONNECTION_TIMEOUT_MS,
} from '../../apps/api/src/infrastructure/persistence/database';

/**
 * R12 F2 item 2: no checkout waits for ever. `pg-pool` defaults `connectionTimeoutMillis` to
 * 0, which means an exhausted pool queued every later request with no bound — the API hung
 * rather than answering. Every pool this process builds goes through `createDatabase`.
 */
describe('the database pool', () => {
  it('bounds every checkout at five seconds', async () => {
    // Nothing connects at construction, so an unreachable address is fine here.
    const handle = createDatabase('postgres://nobody@127.0.0.1:1/none', 2);
    try {
      expect(POOL_CONNECTION_TIMEOUT_MS).toBe(5_000);
      expect(
        (handle.pool as unknown as { options: { connectionTimeoutMillis?: number } }).options
          .connectionTimeoutMillis,
      ).toBe(POOL_CONNECTION_TIMEOUT_MS);
    } finally {
      await handle.pool.end();
    }
  });
});
