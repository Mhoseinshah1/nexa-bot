import {
  REMINDER_BURST_CLEARED_CODE,
  REMINDER_BURST_CODE,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Round 4 PR-H (post-import safety): the ceiling on automatic reminders and the burst
 * alarm, for the customer notification lane's claim.
 *
 * ## Why only reminders
 *
 * The kinds quiet hours hold (`CUSTOMER_NOTIFICATION_QUIET_HOURS`) are the ones a sweep
 * raises with nobody acting — expiry, usage, wallet, pending payment and order, reseller
 * minimum — and so the only ones that can reach tens of thousands of imported customers at
 * once. Everything else is the answer to something a customer or an operator just did, and
 * a payment outcome that waited behind a ceiling would be a customer paying twice. So the
 * claim takes the immediate kinds first, exactly as it always has, and only the reminders
 * that follow are counted against `reminders.max_per_minute`.
 *
 * ## Why a row
 *
 * Two worker replicas are the normal case on every rolling update, and a ceiling each one
 * counted in memory would be twice the ceiling: `customer_notification_rate_windows` is
 * locked, read, and written in the same transaction as the claim it bounds.
 */

/** What the window row holds. Latest state only. */
export interface ReminderRateWindow {
  readonly minuteStartedAt: Date;
  readonly minuteClaimed: number;
  readonly hourStartedAt: Date;
  readonly hourFresh: number;
  readonly burstOpen: boolean;
}

/** The row, locked for the claim's transaction. */
export interface ReminderRateWindowStore {
  /**
   * The tenant's window row under `FOR UPDATE`, created empty (both windows starting at
   * `now`) the first time.
   */
  lock(scope: TenantContext, now: Date, tx: TransactionScope): Promise<ReminderRateWindow>;
  /** Writes the row back, inside the same transaction. */
  save(
    scope: TenantContext,
    window: ReminderRateWindow,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
}

export const REMINDER_RATE_MINUTE_MS = 60_000;
export const REMINDER_RATE_HOUR_MS = 3_600_000;

/** The one dedupe key of the installation's burst condition: there is one lane. */
export const REMINDER_BURST_DEDUPE_KEY = REMINDER_BURST_CODE;

/**
 * The window as it stands at `now`: a minute or an hour that has run its length starts
 * again at `now` with nothing counted. `endedHourFresh` is the count of the hour that has
 * just ended — what the alarm's recovery is decided from — or null when it has not ended.
 * Pure.
 */
export function rollReminderWindow(
  stored: ReminderRateWindow | null,
  now: Date,
): ReminderRateWindow & { readonly endedHourFresh: number | null } {
  if (stored === null) {
    return {
      minuteStartedAt: now,
      minuteClaimed: 0,
      hourStartedAt: now,
      hourFresh: 0,
      burstOpen: false,
      endedHourFresh: null,
    };
  }
  const minuteOver = now.getTime() - stored.minuteStartedAt.getTime() >= REMINDER_RATE_MINUTE_MS;
  const hourOver = now.getTime() - stored.hourStartedAt.getTime() >= REMINDER_RATE_HOUR_MS;
  return {
    minuteStartedAt: minuteOver ? now : stored.minuteStartedAt,
    minuteClaimed: minuteOver ? 0 : stored.minuteClaimed,
    hourStartedAt: hourOver ? now : stored.hourStartedAt,
    hourFresh: hourOver ? 0 : stored.hourFresh,
    burstOpen: stored.burstOpen,
    endedHourFresh: hourOver ? stored.hourFresh : null,
  };
}

/**
 * Whether a claimed reminder counts toward the burst alarm: raised within the hour before
 * `now`. A reminder quiet hours held overnight, or one a rate limit kept back for hours, is
 * a backlog leaving late, not a burst of new facts. Pure.
 */
export function reminderIsFresh(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() < REMINDER_RATE_HOUR_MS;
}

/** How many reminders this pass may claim: what the minute leaves, within the pass's room. */
export function reminderAllowance(
  window: Pick<ReminderRateWindow, 'minuteClaimed'>,
  perMinute: number,
  room: number,
): number {
  return Math.max(0, Math.min(room, perMinute - window.minuteClaimed));
}

/**
 * Whether the alarm opens, closes or stays as it is, after this pass's count. Pure.
 *
 * - OPEN when this hour's fresh reminders exceed the threshold and the condition is not
 *   already open: told once, never on every pass.
 * - CLOSE when the condition is open and an hour has ENDED at or below the threshold — the
 *   hour that has just ended, never a half-counted one.
 * - A threshold of zero is the alarm switched off: it never opens, and one already open
 *   is closed, so switching it off does not leave a condition nobody will ever resolve.
 */
export function decideReminderBurst(
  window: Pick<ReminderRateWindow, 'hourFresh' | 'burstOpen'> & {
    readonly endedHourFresh: number | null;
  },
  burstPerHour: number,
): 'OPEN' | 'CLOSE' | 'NONE' {
  if (burstPerHour <= 0) return window.burstOpen ? 'CLOSE' : 'NONE';
  if (!window.burstOpen) return window.hourFresh > burstPerHour ? 'OPEN' : 'NONE';
  if (window.endedHourFresh !== null && window.endedHourFresh <= burstPerHour) {
    // The ended hour was quiet — unless THIS hour has already gone past it again.
    return window.hourFresh > burstPerHour ? 'NONE' : 'CLOSE';
  }
  return 'NONE';
}

/** The alarm, as the operational event it records. */
export function reminderBurstEvent(
  decision: 'OPEN' | 'CLOSE',
  facts: { readonly hourFresh: number; readonly burstPerHour: number; readonly perMinute: number },
): OperationalEventInput {
  if (decision === 'OPEN') {
    return {
      code: REMINDER_BURST_CODE,
      severity: 'ERROR',
      message:
        'More automatic reminders were raised in one hour than an ordinary hour produces. ' +
        'They are still capped per minute; if this follows an import, switch the reminder ' +
        'feature flags off and check the import baseline before they go out.',
      dedupeKey: REMINDER_BURST_DEDUPE_KEY,
      context: {
        freshThisHour: facts.hourFresh,
        alarmPerHour: facts.burstPerHour,
        maxPerMinute: facts.perMinute,
      },
    };
  }
  return {
    code: REMINDER_BURST_CLEARED_CODE,
    severity: 'INFO',
    message: 'Automatic reminders are back below the burst threshold.',
    recoversCode: REMINDER_BURST_CODE,
    recoversDedupeKey: REMINDER_BURST_DEDUPE_KEY,
    context: { alarmPerHour: facts.burstPerHour },
  };
}

/** The dispatcher's dependency: the row, the two settings, and the recorder. */
export interface ReminderRateDeps {
  readonly windows: ReminderRateWindowStore;
  /** `reminders.max_per_minute` and `reminders.burst_alarm_per_hour`, read in the claim's transaction. */
  readonly limits: (
    scope: TenantContext,
    tx: TransactionScope,
  ) => Promise<{ readonly perMinute: number; readonly burstPerHour: number }>;
  readonly opsLog: OperationalEventRecorder;
}
