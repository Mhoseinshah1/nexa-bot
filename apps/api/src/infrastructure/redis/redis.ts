import { Redis } from 'ioredis';

/**
 * Redis.
 *
 * Intended for exactly five things, enumerated so a sixth is a deliberate
 * decision: conversation FSM state, job queues, an idempotency cache in front
 * of the durable Postgres table, distributed locks, and rate limits.
 *
 * Through Phase 2 it does NONE of them. It is connected and health-checked and
 * nothing else — no queue library is installed, and the notification
 * dispatcher polls Postgres rather than consuming a queue (ADR-0018). Said
 * plainly because the list above reads like a description of what this does.
 *
 * Redis is never the source of truth for anything financial or auditable.
 */
export interface RedisHandle {
  readonly client: Redis;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createRedis(url: string): RedisHandle {
  const client = new Redis(url, {
    // A command that cannot reach Redis fails instead of queueing forever
    // behind an unbounded retry, so a stall surfaces as an error rather than
    // as unexplained slowness. It is also what a queue library would require
    // here, when one arrives.
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
