import { describe, expect, it } from 'vitest';
import { VIEWS, isEnglishSentence } from '../../scripts/web-shots/sweep.mjs';

/** The decisions `pnpm web:sweep` makes without a browser (the approved Web Admin's gate). */
describe('the release sweep', () => {
  it('reads three Latin words in a row as an English sentence shown to an operator', () => {
    expect(isEnglishSentence('The request payload is invalid.')).toBe(true);
    expect(isEnglishSentence('Request failed with 500')).toBe(true);
  });

  it('does not read an identifier, a code or Persian text with a Latin name as a sentence', () => {
    expect(isEnglishSentence('panel.capability_unsupported')).toBe(false);
    expect(isEnglishSentence('سرویس nx_8f3a روی Germany-1')).toBe(false);
    expect(isEnglishSentence('v0.2.1')).toBe(false);
  });

  it('covers 1440 dark, 1440 light and 390 dark on a touch device', () => {
    expect(VIEWS.map((view) => view.name)).toEqual(['1440-dark', '1440-light', '390-dark']);
    expect(VIEWS[2]).toMatchObject({ width: 390, touch: true });
  });
});
