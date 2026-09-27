import { Redis } from 'ioredis';
import type {
  InteractionCounter,
  InteractionTally,
} from '../../modules/commerce/customers/application/anti-spam.service.js';

/**
 * The anti-spam counter (WP20, brief §3.4) on Redis, as one atomic script.
 *
 * Per (tenant, bot, Telegram user), a sorted set of the `update_id`s seen in the rolling
 * window, scored by arrival time. The script:
 *
 * 1. marks the `update_id` as seen (SET NX, a short TTL). If it was already seen, this is a
 *    redelivery and is not counted again (brief §3.4: deduplicate FIRST);
 * 2. drops members older than the window;
 * 3. adds this one when it is new;
 * 4. returns the set's size.
 *
 * One EVAL, so two interactions arriving together are counted as two, in some order, and
 * exactly one of them is the 21st. No database row is written per message.
 *
 * Its own connection, configured to FAIL rather than wait: the shared client queues commands
 * for ever while disconnected (`maxRetriesPerRequest: null`), and a webhook turn must never
 * wait on a counter. Offline queue off, a short command timeout, one retry at most: a Redis
 * that does not answer quickly is UNAVAILABLE, and anti-spam fails open.
 */
const SCRIPT = `
local fresh = redis.call('SET', KEYS[2], '1', 'NX', 'PX', ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
if fresh then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) + 1000)
local count = redis.call('ZCARD', KEYS[1])
if fresh then return {count, 0} end
return {count, 1}
`;

/** How long an `update_id` is remembered as seen: well past Telegram's redelivery window. */
const SEEN_TTL_MS = 10 * 60 * 1000;

/** A command that has not answered in this long is treated as UNAVAILABLE. */
const COMMAND_TIMEOUT_MS = 250;

export class RedisInteractionCounter implements InteractionCounter {
  private readonly client: Redis;

  constructor(
    url: string,
    private readonly prefix = 'nexa:antispam',
  ) {
    this.client = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: 1_000,
      lazyConnect: false,
    });
    // An unlistened 'error' event crashes the process; the failure is reported per call.
    this.client.on('error', () => undefined);
  }

  async tally(input: {
    readonly tenantId: string;
    readonly botInstanceId: string;
    readonly telegramUserId: string;
    readonly updateId: string;
    readonly nowMs: number;
    readonly windowMs: number;
  }): Promise<InteractionTally> {
    const scope = `${this.prefix}:${input.tenantId}:${input.botInstanceId}:${input.telegramUserId}`;
    /*
     * With the offline queue off, a command issued while the connection is still being
     * made fails at once — which would make every turn right after a start (or a reconnect)
     * read as "Redis is down" and record an outage that never happened. So a connection on
     * its way is waited for, as long as one command would be and no longer.
     */
    if (!(await this.ready())) return { state: 'UNAVAILABLE' };
    try {
      const [count, duplicate] = (await this.client.eval(
        SCRIPT,
        2,
        `${scope}:window`,
        `${scope}:seen:${input.updateId}`,
        String(input.nowMs),
        String(input.windowMs),
        input.updateId,
        String(SEEN_TTL_MS),
      )) as [number, number];
      return { state: 'COUNTED', count: Number(count), duplicate: Number(duplicate) === 1 };
    } catch {
      return { state: 'UNAVAILABLE' };
    }
  }

  private async ready(): Promise<boolean> {
    if (this.client.status === 'ready') return true;
    if (this.client.status === 'end') return false;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.client.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, COMMAND_TIMEOUT_MS);
      this.client.once('ready', done);
    });
    // Re-read after the wait: the status is the client's, and it has moved meanwhile.
    return (this.client.status as string) === 'ready';
  }

  async close(): Promise<void> {
    this.client.disconnect();
  }
}
