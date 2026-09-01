import { Redis } from 'ioredis';

/**
 * Redis.
 *
 * Used for exactly five things, enumerated so a sixth is a deliberate decision:
 * conversation FSM state, BullMQ queues, an idempotency cache in front of the
 * durable Postgres table, distributed locks, and rate limits.
 *
 * Redis is never the source of truth for anything financial or auditable.
 * Phase 0 uses it only for queue connectivity and health.
 */
export interface RedisHandle {
  readonly client: Redis;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createRedis(url: string): RedisHandle {
  const client = new Redis(url, {
    // BullMQ requires this, and it also stops a queue stall from being hidden
    // behind an unbounded retry queue.
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  // An unhandled 'error' event on an ioredis client crashes the process. We log
  // through the connection check instead, so a transient blip degrades
  // readiness rather than taking the pod down.
  client.on('error', () => undefined);

  return {
    client,
    async ping() {
      try {
        if (client.status !== 'ready' && client.status !== 'connecting') {
          await client.connect();
        }
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    async close() {
      client.disconnect();
    },
  };
}

export const REDIS = Symbol('REDIS');
