import { describe, expect, it } from 'vitest';
import {
  diskInsufficientReason,
  persianByteSize,
  persianGigabytes,
} from '../../apps/api/src/modules/platform/backup/application/backup-disk';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Round 8 B3 and B6: sizes the owner can read, in the unit a person would say. */
describe('backup disk text', () => {
  it('words the refusal exactly as the owner specified', () => {
    expect(diskInsufficientReason(Math.round(1.5 * GIB), 6 * GIB)).toBe(
      'فضای دیسک کافی نیست (آزاد: ۱٫۵ گیگابایت، لازم: ۶ گیگابایت)',
    );
  });

  it('rounds gigabytes to one decimal and drops a zero decimal', () => {
    expect(persianGigabytes(2 * GIB)).toBe('۲ گیگابایت');
    expect(persianGigabytes(2.44 * GIB)).toBe('۲٫۴ گیگابایت');
    expect(persianGigabytes(0)).toBe('۰ گیگابایت');
  });

  it('steps down the unit so a small size is never «۰ گیگابایت»', () => {
    expect(persianByteSize(182 * MIB)).toBe('۱۸۲ مگابایت');
    expect(persianByteSize(900)).toBe('۹۰۰ بایت');
    expect(persianByteSize(0)).toBe('۰ بایت');
    expect(persianByteSize(3 * 1024)).toBe('۳ کیلوبایت');
    expect(persianByteSize(17.8 * GIB)).toBe('۱۷٫۸ گیگابایت');
  });
});
