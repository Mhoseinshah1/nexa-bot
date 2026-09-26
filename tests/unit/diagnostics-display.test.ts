import { describe, expect, it } from 'vitest';
import {
  LAST_ERROR_DISPLAY_MAX,
  displayableError,
} from '../../apps/api/src/modules/platform/system/application/diagnostics.service';

/**
 * WP16 D2: a consumer's stored error, as an operator may see it. A URL in it could be a
 * subscription link — a bearer capability — so every URL is replaced, and the text is
 * bounded.
 */
describe('displayableError', () => {
  it('replaces every URL, whatever its scheme, and keeps the rest', () => {
    expect(
      displayableError(
        'failed at https://sub.example/sub/abc?t=1 then http://10.0.0.1:2053/panel and vless://id@h:443',
      ),
    ).toBe('failed at [url] then [url] and [url]');
  });

  it('bounds the text', () => {
    const shown = displayableError('x'.repeat(LAST_ERROR_DISPLAY_MAX + 50)) ?? '';
    expect(shown.length).toBe(LAST_ERROR_DISPLAY_MAX + 1);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('passes null through', () => {
    expect(displayableError(null)).toBeNull();
  });
});
