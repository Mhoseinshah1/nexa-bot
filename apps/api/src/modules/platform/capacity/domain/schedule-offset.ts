import { createHash } from 'node:crypto';
import type { CapacityTier } from '@nexa/contracts';

/**
 * Phase 6A PR-2: each bot's scheduled work at its own minute, so fifty bots never all fire
 * at once.
 *
 * A bot's nightly report and its reminder sweeps run at the time the schedule names PLUS an
 * offset derived from the bot's tenant id: a
 * SHA-256 of `<purpose>:<tenantId>`, reduced into `[0, spreadMs)` and floored to a whole
 * second. Stable — the same bot gets the same offset on every process, every restart and
 * every release — and different per purpose, so one bot's report and its sweep do not share
 * a slot either.
 *
 * The owner's own bot (the installation tier) keeps the time it was configured with: the
 * offset is 0, and the hosted bots are spread after it.
 *
 * A hash spreads; it does not assign. Two of fifty bots can share a minute (the test pins
 * how many at most for a realistic set); none of them shares it by construction.
 */
export function scheduleOffsetMs(
  tenantId: string,
  purpose: string,
  spreadMs: number,
  tier: CapacityTier = 'HOSTED',
): number {
  if (tier === 'INSTALLATION' || spreadMs < 1_000) return 0;
  const digest = createHash('sha256').update(`${purpose}:${tenantId}`).digest();
  // 48 bits: far more than any spread, and exact in a double.
  const value = digest.readUIntBE(0, 6);
  const seconds = Math.floor(spreadMs / 1_000);
  return (value % seconds) * 1_000;
}

/**
 * The purposes an offset is taken for. One list, so two callers cannot collide by typo.
 * The FX refresh, the retention sweeps and the backup are installation-wide today (one pass
 * for the whole database, not one per bot), so they have no per-bot time to shift; a lane
 * that becomes per-bot takes its purpose here.
 */
export const SCHEDULE_PURPOSES = {
  nightlyReport: 'nightly-report',
  customerReminders: 'customer-reminders',
} as const;

/** How far the hosted bots' nightly reports are spread after the configured time. */
export const NIGHTLY_REPORT_SPREAD_MS = 60 * 60_000;

/**
 * Whether an interval-based sweep of a bot is due now, phase-shifted by its offset: the
 * sweep runs once per `intervalMs`, in the slot that starts `offset` into each interval.
 * `lastRunAt` null is due. Pure.
 */
export function phasedSweepDue(
  nowMs: number,
  lastRunAtMs: number | null,
  intervalMs: number,
  offsetMs: number,
): boolean {
  if (lastRunAtMs === null) return true;
  const slotOf = (at: number): number => Math.floor((at - offsetMs) / intervalMs);
  return slotOf(nowMs) > slotOf(lastRunAtMs);
}
