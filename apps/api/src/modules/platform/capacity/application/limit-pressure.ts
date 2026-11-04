import {
  CAPACITY_BOT_LIMIT_PRESSURE_CODE,
  opsAggregationKey,
  type CapacityResource,
  type Clock,
} from '@nexa/contracts';
import type { OwnerOpsLog } from './ports.js';

/** The window a bot's limit hits are counted in. */
export const LIMIT_PRESSURE_WINDOW_MS = 5 * 60_000;
/** Hits within the window that make it "keeps hitting", not "once touched". */
export const LIMIT_PRESSURE_THRESHOLD = 50;
/** After telling the owner, this process stays quiet about the same bot and limit this long. */
export const LIMIT_PRESSURE_QUIET_MS = 15 * 60_000;

/**
 * "This bot keeps reaching its limit", told to the OWNER — the installation's operations
 * group, never the hosted bot's own — and rate-limited three ways: a bot must reach the
 * limit `LIMIT_PRESSURE_THRESHOLD` times within `LIMIT_PRESSURE_WINDOW_MS`; after one alert
 * this process says nothing more about that bot and limit for `LIMIT_PRESSURE_QUIET_MS`;
 * and the event's dedupe key is windowed (`opsAggregationKey`), so every replica together
 * makes one group message per bot and limit per aggregation window, with a counter.
 *
 * `hit` never throws and never waits on the database: the caller is a customer's turn.
 */
export class LimitPressureReporter {
  private readonly windows = new Map<string, { start: number; hits: number }>();
  private readonly quietUntil = new Map<string, number>();

  constructor(
    private readonly deps: {
      readonly clock: Clock;
      readonly ownerOpsLog: OwnerOpsLog;
      readonly displayNameOf?: (tenantId: string) => string | null;
      readonly onFailure?: (error: unknown) => void;
    },
  ) {}

  /** One time a bot reached a limit. Answers whether this hit raised the alert. */
  hit(tenantId: string, resource: CapacityResource): boolean {
    const now = this.deps.clock.now().getTime();
    const key = `${tenantId}:${resource}`;
    let window = this.windows.get(key);
    if (window === undefined || now - window.start >= LIMIT_PRESSURE_WINDOW_MS) {
      window = { start: now, hits: 0 };
      this.windows.set(key, window);
    }
    window.hits += 1;
    if (window.hits < LIMIT_PRESSURE_THRESHOLD) return false;
    if ((this.quietUntil.get(key) ?? 0) > now) return false;
    this.quietUntil.set(key, now + LIMIT_PRESSURE_QUIET_MS);
    const hits = window.hits;
    const name = this.deps.displayNameOf?.(tenantId) ?? null;
    void this.deps.ownerOpsLog
      .record({
        code: CAPACITY_BOT_LIMIT_PRESSURE_CODE,
        severity: 'WARN',
        message:
          `ربات ${name ?? tenantId} مدام به سقف «${resource}» می‌رسد (${String(hits)} بار در ` +
          `${String(LIMIT_PRESSURE_WINDOW_MS / 60_000)} دقیقه). مشتریانش کندتر پاسخ می‌گیرند؛ ` +
          'چیزی از دست نرفته است.',
        dedupeKey: opsAggregationKey(
          `${CAPACITY_BOT_LIMIT_PRESSURE_CODE}:${tenantId}:${resource}`,
          this.deps.clock.now(),
        ),
        context: { tenantId, resource, hits, windowMs: LIMIT_PRESSURE_WINDOW_MS },
      })
      .catch((error: unknown) => this.deps.onFailure?.(error));
    return true;
  }
}
