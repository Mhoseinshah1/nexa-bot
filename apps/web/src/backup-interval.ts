import { BACKUP_INTERVAL_MINUTES_MAX, BACKUP_INTERVAL_MINUTES_MIN } from '@nexa/contracts';

/**
 * The automatic backup interval as an operator edits it (spec §13.2): a number and a
 * unit, or one of a handful of presets — never raw milliseconds, and never raw minutes
 * unless minutes is the unit they chose.
 *
 * Stored as whole MINUTES in `backup.interval_minutes`; the bounds are the registry's
 * (`BACKUP_INTERVAL_MINUTES_MIN/MAX`, fifteen minutes to thirty days), so this editor and
 * the server refuse the same values. The server is the authority; this is a courtesy that
 * says why before a round trip does.
 */

export const BACKUP_INTERVAL_UNITS = ['minute', 'hour', 'day'] as const;
export type BackupIntervalUnit = (typeof BACKUP_INTERVAL_UNITS)[number];

export const MINUTES_PER_UNIT: Readonly<Record<BackupIntervalUnit, number>> = {
  minute: 1,
  hour: 60,
  day: 24 * 60,
};

/** The owner's presets: 1, 3, 6, 12 and 24 hours. Anything else is the custom choice. */
export const BACKUP_INTERVAL_PRESETS = [
  { id: '1h', minutes: 60 },
  { id: '3h', minutes: 3 * 60 },
  { id: '6h', minutes: 6 * 60 },
  { id: '12h', minutes: 12 * 60 },
  { id: '24h', minutes: 24 * 60 },
] as const;
export type BackupIntervalPreset = (typeof BACKUP_INTERVAL_PRESETS)[number]['id'];
export type BackupIntervalChoice = BackupIntervalPreset | 'custom';

/** The preset a stored interval is, or `custom`. */
export function presetOf(minutes: number): BackupIntervalChoice {
  return BACKUP_INTERVAL_PRESETS.find((preset) => preset.minutes === minutes)?.id ?? 'custom';
}

export function presetMinutes(preset: BackupIntervalPreset): number {
  return BACKUP_INTERVAL_PRESETS.find((candidate) => candidate.id === preset)?.minutes ?? 60;
}

/** A whole number of minutes, in the largest unit it is a whole number of. */
export function splitInterval(minutes: number): {
  readonly value: number;
  readonly unit: BackupIntervalUnit;
} {
  if (minutes % MINUTES_PER_UNIT.day === 0) {
    return { value: minutes / MINUTES_PER_UNIT.day, unit: 'day' };
  }
  if (minutes % MINUTES_PER_UNIT.hour === 0) {
    return { value: minutes / MINUTES_PER_UNIT.hour, unit: 'hour' };
  }
  return { value: minutes, unit: 'minute' };
}

export type IntervalProblem = 'invalid' | 'too_short' | 'too_long';

/**
 * A typed value and unit, as minutes — or why not. Persian digits are read too, because
 * that is what a Persian keyboard types.
 */
export function intervalMinutes(
  raw: string,
  unit: BackupIntervalUnit,
):
  | { readonly ok: true; readonly minutes: number }
  | { readonly ok: false; readonly problem: IntervalProblem } {
  const normalised = raw
    .trim()
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
  if (!/^\d{1,6}$/.test(normalised)) return { ok: false, problem: 'invalid' };
  const minutes = Number(normalised) * MINUTES_PER_UNIT[unit];
  if (minutes < BACKUP_INTERVAL_MINUTES_MIN) return { ok: false, problem: 'too_short' };
  if (minutes > BACKUP_INTERVAL_MINUTES_MAX) return { ok: false, problem: 'too_long' };
  return { ok: true, minutes };
}
