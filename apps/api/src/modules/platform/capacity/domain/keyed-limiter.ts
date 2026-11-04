/**
 * Phase 6A PR-2: at most N of one bot's tasks at once, the rest waiting IN THAT BOT'S QUEUE.
 *
 * One key per bot (its tenant). A task under the key's limit runs at once; one over it waits
 * in the key's own FIFO queue, so a bot flooding the installation waits behind ITSELF and
 * never behind, or in front of, another bot. The limit is read per call, so an owner's
 * change applies to the next task without a restart; `Infinity` is «نامحدود».
 *
 * A wait is bounded twice — by the queue's length and by time — because the caller is a
 * Telegram webhook request that Telegram times out. Past either bound the task is REFUSED
 * with `LimiterDeferral` before it started: the webhook answers a retryable non-2xx with
 * nothing written, and Telegram delivers the update again later. Slower, never lost.
 *
 * Process-local by design: the API is one process (deploy/compose.yml), and a second
 * replica during a rolling update only doubles the bound for those seconds.
 */

export type LimiterOutcome = 'IMMEDIATE' | 'WAITED';

/** Thrown when a task was not started: its key's queue is full or its wait ran out. */
export class LimiterDeferral extends Error {
  constructor(
    readonly key: string,
    readonly reason: 'QUEUE_FULL' | 'WAIT_EXPIRED',
  ) {
    super(`the queue of ${key} is ${reason === 'QUEUE_FULL' ? 'full' : 'too slow'}`);
    this.name = 'LimiterDeferral';
  }
}

export interface KeyedLimiterOptions {
  /** How many tasks of one key may wait at once. */
  readonly maxQueuedPerKey: number;
  /** How long one task may wait for its turn, in ms. */
  readonly maxWaitMs: number;
  /** Timers, injectable so a test controls time. */
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

interface Waiter {
  readonly admit: () => void;
  readonly limit: number;
}

interface Lane {
  active: number;
  readonly queue: Waiter[];
}

export class KeyedConcurrencyLimiter {
  private readonly lanes = new Map<string, Lane>();
  private readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };

  constructor(private readonly options: KeyedLimiterOptions) {
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return { cancel: () => clearTimeout(handle) };
      });
  }

  /**
   * Runs `task` once the key has a free slot. Resolves with the task's result and whether it
   * had to wait; rejects with `LimiterDeferral` when it never started.
   */
  async run<T>(
    key: string,
    limit: number,
    task: () => Promise<T>,
  ): Promise<{ readonly result: T; readonly outcome: LimiterOutcome }> {
    const lane = this.laneOf(key);
    let outcome: LimiterOutcome = 'IMMEDIATE';
    if (lane.active >= limit) {
      if (lane.queue.length >= this.options.maxQueuedPerKey) {
        this.dropIfIdle(key, lane);
        throw new LimiterDeferral(key, 'QUEUE_FULL');
      }
      await this.waitForTurn(key, lane, limit);
      outcome = 'WAITED';
    } else {
      lane.active += 1;
    }
    try {
      return { result: await task(), outcome };
    } finally {
      lane.active -= 1;
      this.admitNext(lane);
      this.dropIfIdle(key, lane);
    }
  }

  /** What a key holds now: for metrics and tests. */
  snapshot(key: string): { readonly active: number; readonly queued: number } {
    const lane = this.lanes.get(key);
    return { active: lane?.active ?? 0, queued: lane?.queue.length ?? 0 };
  }

  private waitForTurn(key: string, lane: Lane, limit: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter: Waiter = {
        limit,
        admit: () => {
          if (settled) return;
          settled = true;
          timer.cancel();
          // The slot is taken by the one admitting, before it returns: no gap another
          // caller could slip into.
          lane.active += 1;
          resolve();
        },
      };
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        const at = lane.queue.indexOf(waiter);
        if (at >= 0) lane.queue.splice(at, 1);
        this.dropIfIdle(key, lane);
        reject(new LimiterDeferral(key, 'WAIT_EXPIRED'));
      }, this.options.maxWaitMs);
      lane.queue.push(waiter);
    });
  }

  /** First in, first out: the oldest waiter goes next while its limit allows. */
  private admitNext(lane: Lane): void {
    while (lane.queue.length > 0) {
      const next = lane.queue[0] as Waiter;
      if (lane.active >= next.limit) return;
      lane.queue.shift();
      next.admit();
    }
  }

  private laneOf(key: string): Lane {
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = { active: 0, queue: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  private dropIfIdle(key: string, lane: Lane): void {
    if (lane.active === 0 && lane.queue.length === 0) this.lanes.delete(key);
  }
}
