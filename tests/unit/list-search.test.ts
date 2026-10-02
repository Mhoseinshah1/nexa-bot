import { describe, expect, it } from 'vitest';
import {
  LIST_SEARCH_MAX_LENGTH,
  classifyListSearch,
  customerListQuerySchema,
  listSearchQuerySchema,
  orderListQuerySchema,
  paymentListQuerySchema,
  serviceListQuerySchema,
} from '@nexa/contracts';

/**
 * The one search box (spec §10): what a string IS is decided by shape alone, and the
 * shapes must not overlap — a digit string read as text would turn an exact, indexed
 * Telegram id lookup into a name prefix scan, and a uuid read as text would match
 * nothing at all.
 */
describe('classifyListSearch', () => {
  it('reads digits as an EXACT Telegram id', () => {
    expect(classifyListSearch('  123456789 ')).toEqual({ kind: 'TELEGRAM_ID', value: '123456789' });
  });

  it('does not read a zero-led or over-long digit string as a Telegram id', () => {
    // `telegramUserIdSchema` is the definition: no leading zero, at most 19 digits.
    expect(classifyListSearch('0123')?.kind).toBe('TEXT');
    expect(classifyListSearch('1'.repeat(20))?.kind).toBe('TEXT');
  });

  it('reads an internal id as a lower-cased UUID', () => {
    const id = '0199A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B';
    expect(classifyListSearch(id)).toEqual({ kind: 'UUID', value: id.toLowerCase() });
  });

  it('reads a leading @ as a username, stripped and case-folded', () => {
    expect(classifyListSearch('@Ali_Reza')).toEqual({ kind: 'USERNAME', value: 'ali_reza' });
  });

  it('reads a bare @ as text, never as an empty username prefix that matches everyone', () => {
    expect(classifyListSearch('@')).toEqual({ kind: 'TEXT', value: '@', folded: '@' });
  });

  it('keeps the typed text for exact matches and a folded copy for prefixes', () => {
    expect(classifyListSearch('Ref-ABC')).toEqual({
      kind: 'TEXT',
      value: 'Ref-ABC',
      folded: 'ref-abc',
    });
    expect(classifyListSearch('سرویس ویژه')?.kind).toBe('TEXT');
  });

  it('answers null for whitespace — no search, not a search that matched nothing', () => {
    expect(classifyListSearch('   ')).toBeNull();
  });
});

describe('the q parameter', () => {
  it('is trimmed, non-empty and bounded', () => {
    expect(listSearchQuerySchema.parse('  ali ')).toBe('ali');
    expect(listSearchQuerySchema.safeParse('   ').success).toBe(false);
    expect(listSearchQuerySchema.safeParse('x'.repeat(LIST_SEARCH_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('is accepted by every searchable list and nothing else changes', () => {
    for (const schema of [
      customerListQuerySchema,
      orderListQuerySchema,
      paymentListQuerySchema,
      serviceListQuerySchema,
    ]) {
      expect(schema.parse({ q: ' 42 ' })).toMatchObject({ q: '42' });
      expect(schema.safeParse({ q: '' }).success).toBe(false);
    }
  });
});
