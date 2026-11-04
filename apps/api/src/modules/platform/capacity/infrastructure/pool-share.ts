import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { DbShare } from '../application/bot-turn-guard.js';

/**
 * Phase 6A PR-2: a bot's SHARE of a process's PostgreSQL pool.
 *
 * Work started inside `run(key, limit, fn)` carries its bot in an `AsyncLocalStorage`
 * context. Every checkout from the wrapped pool — a drizzle query (`pool.query`, which
 * checks out through `connect`) or a transaction (`pool.connect`) — first takes one of the
 * bot's `limit` permits, FIFO, and gives it back when the client is released. So one bot's
 * flood of turns holds at most `limit` of the pool's connections and every other bot still
 * finds one free.
 *
 * RE-ENTRANT PER TURN. Code in this repository sometimes checks out a second connection
 * while it holds one (a read outside the transaction it is in). A turn that already holds
 * a permit therefore never waits for another: its nested checkouts ride on the permit it
 * has. Without that, `limit` turns each holding one connection and each asking for a second
 * would wait on each other for ever. The share is a bound on TURNS inside the database at
 * once, which is what a pool share means for a webhook whose turns are sequential.
 *
 * Bounded wait: a permit not granted within `maxWaitMs` fails the checkout the way the
 * pool's own `connectionTimeoutMillis` does, so a turn behind its own bot's backlog fails
 * like any exhausted pool rather than hanging.
 *
 * Outside a `run` context (Web Admin requests, the worker's lanes, migrations) nothing
 * changes: the checkout goes straight to the pool.
 */
interface ShareContext {
  readonly key: string;
  readonly limit: number;
  readonly onWait: () => void;
  /** Clients this turn holds now. */
  clients: number;
  /** Whether the turn holds one of its bot's permits. */
  hasPermit: boolean;
  /** The permit being taken, shared by the turn's concurrent checkouts. */
  permit: Promise<void> | null;
}

interface KeyState {
  held: number;
  readonly waiters: Array<() => void>;
}

export class PoolShare implements DbShare {
  private readonly storage = new AsyncLocalStorage<ShareContext>();
  private readonly keys = new Map<string, KeyState>();

  constructor(private readonly options: { readonly maxWaitMs: number }) {}

  run<T>(key: string, limit: number, fn: () => Promise<T>, onWait: () => void): Promise<T> {
    return this.storage.run({ key, limit, onWait, clients: 0, hasPermit: false, permit: null }, fn);
  }

  /** What a key holds now: for tests and metrics. */
  snapshot(key: string): { readonly held: number; readonly waiting: number } {
    const state = this.keys.get(key);
    return { held: state?.held ?? 0, waiting: state?.waiters.length ?? 0 };
  }

  /**
   * Wraps `pool.connect` in place. Idempotent. Every checkout path of `pg.Pool` goes
   * through `connect` (`query` calls it with a callback), so this is the one chokepoint.
   */
  install(pool: Pool): void {
    const marked = pool as Pool & { __nexaPoolShare?: true };
    if (marked.__nexaPoolShare === true) return;
    marked.__nexaPoolShare = true;
    const original = pool.connect.bind(pool) as (
      callback?: (error: Error | undefined, client?: PoolClient, done?: () => void) => void,
    ) => Promise<PoolClient> | undefined;
    const wrapped = (
      callback?: (error: Error | undefined, client?: PoolClient, done?: () => void) => void,
    ): Promise<PoolClient> | undefined => {
      const context = this.storage.getStore();
      if (context === undefined || !Number.isFinite(context.limit)) {
        return callback === undefined ? original() : original(callback);
      }
      const acquired = this.checkout(context, () => original() as Promise<PoolClient>);
      if (callback === undefined) return acquired;
      acquired.then(
        (client) => callback(undefined, client, () => client.release()),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
      );
      return undefined;
    };
    (pool as unknown as { connect: typeof wrapped }).connect = wrapped;
  }

  private async checkout(
    context: ShareContext,
    connect: () => Promise<PoolClient>,
  ): Promise<PoolClient> {
    // A loop, not an `if`: the permit this checkout waited on can be given back by a sibling
    // checkout of the same turn before this one resumes.
    while (!context.hasPermit) {
      if (context.permit === null) {
        context.permit = this.acquire(context).then(() => {
          context.hasPermit = true;
        });
      }
      const pending = context.permit;
      try {
        await pending;
      } catch (error) {
        if (context.permit === pending) context.permit = null;
        throw error;
      }
      if (context.permit === pending) context.permit = null;
    }
    context.clients += 1;
    let client: PoolClient;
    try {
      client = await connect();
    } catch (error) {
      this.releaseClient(context);
      throw error;
    }
    const release = client.release.bind(client);
    let released = false;
    client.release = ((destroy?: boolean | Error) => {
      if (!released) {
        released = true;
        this.releaseClient(context);
      }
      return release(destroy);
    }) as PoolClient['release'];
    return client;
  }

  private releaseClient(context: ShareContext): void {
    context.clients -= 1;
    if (context.clients > 0 || !context.hasPermit) return;
    // The turn holds nothing now: its permit goes to the next of its bot's turns.
    context.hasPermit = false;
    const state = this.keys.get(context.key);
    if (state === undefined) return;
    state.held -= 1;
    const next = state.waiters.shift();
    if (next !== undefined) {
      state.held += 1;
      next();
    }
    if (state.held === 0 && state.waiters.length === 0) this.keys.delete(context.key);
  }

  private acquire(context: ShareContext): Promise<void> {
    let state = this.keys.get(context.key);
    if (state === undefined) {
      state = { held: 0, waiters: [] };
      this.keys.set(context.key, state);
    }
    if (state.held < context.limit) {
      state.held += 1;
      return Promise.resolve();
    }
    context.onWait();
    const lane = state;
    return new Promise<void>((resolve, reject) => {
      const admit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const at = lane.waiters.indexOf(admit);
        if (at >= 0) lane.waiters.splice(at, 1);
        reject(new Error('timeout exceeded when trying to connect (bot database share)'));
      }, this.options.maxWaitMs);
      timer.unref?.();
      lane.waiters.push(admit);
    });
  }
}
