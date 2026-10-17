import { describe, expect, it } from 'vitest';
import { jalaliDatesIn } from '../../apps/web/src/pages/editor-layout';
import { formatDateFieldValue } from '../../apps/web/src/ui/date-field';

describe('an audience summary line, as the campaign and broadcast pages draw it', () => {
  it('shows every Gregorian day as the Jalali day the date field shows, and nothing else', () => {
    const line = 'عضویت از 2026-03-21 تا 2026-03-30';
    const shown = jalaliDatesIn(line);
    expect(shown).toBe(
      `عضویت از ${formatDateFieldValue('date', '2026-03-21') ?? ''} تا ${
        formatDateFieldValue('date', '2026-03-30') ?? ''
      }`,
    );
    expect(shown).not.toMatch(/2026/u);
    // A line without a day, or an id, is left exactly as it is.
    expect(jalaliDatesIn('برچسب: vip')).toBe('برچسب: vip');
    expect(jalaliDatesIn('019250ab-cdef-7012-8345-6789abcdef01')).toBe(
      '019250ab-cdef-7012-8345-6789abcdef01',
    );
  });
});
