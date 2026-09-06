import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { match } from '../../apps/web/src/router';
import { resolve } from '../../apps/web/src/app';
import { PERMISSION_KEYS } from '@nexa/contracts';
import { renderPage, stubApi } from './harness';

/**
 * The router, at the boundary where a URL an operator can type meets code.
 *
 * `match` runs inside `resolve` during render, and there is no error boundary
 * above it. Anything it throws is not a bad page — it is the whole signed-in
 * admin gone, from one address bar.
 */
describe('route matching', () => {
  it('extracts a parameter and decodes it', () => {
    expect(match('/panels/:id', '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8')).toEqual({
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    });
    // A legitimately encoded value still arrives decoded.
    expect(match('/panels/:id', '/panels/a%20b')).toEqual({ id: 'a b' });
  });

  it('matches on segment COUNT, so a list never renders over a detail', () => {
    expect(match('/panels', '/panels/abc')).toBeNull();
    expect(match('/panels/:id', '/panels')).toBeNull();
  });

  /**
   * T19 — a malformed escape is an unmatched route, not a crash.
   *
   * `decodeURIComponent('%E0')` throws `URIError`: `%E0` introduces a
   * multi-byte UTF-8 sequence and the continuation bytes are missing. Every
   * shape below throws the same way, and each of them is a URL a person can
   * type or a link can carry.
   */
  it.each(['%E0', '%', '%zz', '%C3%28', '%F0%9F', 'a%2', '%E0%A4%A'])(
    'treats /panels/%s as unmatched rather than throwing',
    (bad) => {
      // The premise: this really is a value that throws.
      expect(() => decodeURIComponent(bad)).toThrow();
      expect(() => match('/panels/:id', `/panels/${bad}`)).not.toThrow();
      expect(match('/panels/:id', `/panels/${bad}`)).toBeNull();
    },
  );

  it('leaves a malformed literal segment alone rather than decoding it', () => {
    // The non-parameter branch compares raw text, so a malformed escape there
    // simply does not equal the pattern.
    expect(match('/panels', '/%E0')).toBeNull();
  });
});

describe('the shell, given a URL an operator typed', () => {
  it('serves the not-found page for a malformed panel id instead of crashing', () => {
    stubApi([]);
    const resolved = resolve(
      { path: '/panels/%E0', query: new URLSearchParams() },
      PERMISSION_KEYS,
    );
    const { container } = renderPage(resolved.element as ReactElement);

    // Something rendered at all — which is the finding. Before the fix this
    // threw out of `resolve` and took the admin down with it.
    expect(container.textContent).toBeTruthy();
    // And it is the 404, not a panel detail asking the API for '%E0'.
    expect(screen.queryByText('اعتبارنامه‌ها')).toBeNull();
  });
});
