import { describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES } from '@nexa/contracts';
import {
  bufferWithin,
  decodeCopyLine,
  encodeCopyLine,
  SELF_REFERENCE_BUFFER_LIMITS,
} from '../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-copy';

/** Phase 6B PR-1: the tenant archive's row format and its fixed buffering bound. */
describe('tenant archive rows', () => {
  it('round-trips every value COPY text escapes, and NULL', () => {
    const row = ['a\tb', 'line\nnext', 'back\\slash', null, '', 'ف\r\v\f\b'];
    const line = encodeCopyLine(row);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).split('\t')).toHaveLength(row.length);
    expect(decodeCopyLine(line.slice(0, -1))).toEqual(row);
  });

  it('refuses an escape COPY never writes', () => {
    expect(() => decodeCopyLine('a\\qb')).toThrow();
  });

  it('bounds a self-referencing table by fixed limits, never the archive', () => {
    expect(SELF_REFERENCE_BUFFER_LIMITS.rows).toBeLessThanOrEqual(200_000);
    const buffer: (string | null)[][] = [];
    const state = { bytes: 0 };
    bufferWithin(buffer, [['x'], ['y']], state, 't', { rows: 2, bytes: 100 });
    expect(buffer).toHaveLength(2);
    expect(() => bufferWithin(buffer, [['z']], state, 't', { rows: 2, bytes: 100 })).toThrow(
      expect.objectContaining({ code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED }),
    );
    expect(() =>
      bufferWithin([], [['a'.repeat(101)]], { bytes: 0 }, 't', { rows: 10, bytes: 100 }),
    ).toThrow();
  });
});
