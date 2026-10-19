import { describe, expect, it } from 'vitest';
import { formatRelative, formatTimestamp } from '../../apps/web/src/format';
import { SHOT_NOW } from './shots/fixture.ts';

const NOW = Date.parse(SHOT_NOW);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe('formatRelative (frozen shot clock)', () => {
  it('reads minutes, hours and days in Persian digits', () => {
    expect(formatRelative(ago(30_000), NOW)).toBe('همین حالا');
    expect(formatRelative(ago(5 * MIN), NOW)).toBe('۵ دقیقه پیش');
    expect(formatRelative(ago(3 * 60 * MIN), NOW)).toBe('۳ ساعت پیش');
    expect(formatRelative(ago(5 * 24 * 60 * MIN), NOW)).toBe('۵ روز پیش');
  });

  it('falls back to the absolute time past a month, in the future, or unparseable', () => {
    const old = ago(45 * 24 * 60 * MIN);
    expect(formatRelative(old, NOW)).toBe(formatTimestamp(old));
    const future = new Date(NOW + MIN).toISOString();
    expect(formatRelative(future, NOW)).toBe(formatTimestamp(future));
    expect(formatRelative('garbage', NOW)).toBe('garbage');
  });
});
