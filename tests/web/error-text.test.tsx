import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as contracts from '@nexa/contracts';
import { ApiError } from '../../apps/web/src/api/client';
import { ERROR_TEXT, errorIssues, errorText, fieldText } from '../../apps/web/src/error-text';
import { WEB_FA, t, type WebKey } from '../../apps/web/src/i18n/web.fa';
import { messageFor } from '../../apps/web/src/pages/settings';
import { ApiErrorReport } from '../../apps/web/src/ui/technical-details';

/** A sentence a person reads in English: three Latin words in a row. */
const ENGLISH_SENTENCE = /[A-Za-z]{2,}[\s,.:;]+[A-Za-z]{2,}[\s,.:;]+[A-Za-z]{2,}/u;
const PERSIAN = /[؀-ۿ]/u;

/** Every value of every `*_ERROR_CODES` export, found at run time — not from the type union. */
function catalogueCodes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [name, value] of Object.entries(contracts)) {
    if (!name.endsWith('_ERROR_CODES')) continue;
    const codes = Array.isArray(value) ? value : Object.values(value as object);
    for (const code of codes) {
      if (typeof code !== 'string') continue;
      found.set(code, [...(found.get(code) ?? []), name]);
    }
  }
  return found;
}

describe('ERROR_TEXT covers every contract error code', () => {
  const codes = catalogueCodes();
  const table = ERROR_TEXT as Readonly<Record<string, WebKey>>;

  it('walks a real set of catalogues', () => {
    // A guard against a broken import making the walk vacuous.
    expect(codes.size).toBeGreaterThan(400);
    expect(codes.has('commerce.order_not_found')).toBe(true);
    expect(codes.has('qr.text_empty')).toBe(true);
  });

  it('maps every catalogued code', () => {
    const missing = [...codes.keys()].filter((code) => table[code] === undefined);
    expect(missing).toEqual([]);
  });

  it('maps the four codes the HTTP layer itself produces', () => {
    for (const code of ['request.invalid', 'http.error', 'internal.unhandled', 'unknown']) {
      expect(table[code]).toBeDefined();
    }
  });

  it('maps every code to a key that exists in WEB_FA and is Persian', () => {
    const catalogue = WEB_FA as Readonly<Record<string, string>>;
    const broken = Object.entries(table).filter(
      ([, key]) => catalogue[key] === undefined || !PERSIAN.test(catalogue[key] ?? ''),
    );
    expect(broken).toEqual([]);
  });

  it('never says a code in English', () => {
    const english = Object.entries(table).filter(([, key]) =>
      ENGLISH_SENTENCE.test(t(key).replace(/https?:\/\/\S*|BotFather|API|HTTPS|QR/gu, '')),
    );
    expect(english).toEqual([]);
  });
});

describe('errorText', () => {
  const english = (status: number, code: string) =>
    new ApiError(status, code, 'The request payload is invalid and this is English.', undefined, {
      kind: 'VALIDATION',
      correlationId: 'corr-1',
    });

  it('says a mapped code by its own sentence', () => {
    expect(errorText(english(404, 'commerce.order_not_found'))).toBe(
      t('web.err_commerce_order_not_found'),
    );
  });

  it('prefers a page override', () => {
    expect(
      errorText(english(404, 'commerce.order_not_found'), {
        overrides: { 'commerce.order_not_found': 'web.conflict' },
      }),
    ).toBe(t('web.conflict'));
  });

  it.each([
    [400, 'request.invalid', 'web.err_request_invalid'],
    [400, 'some.unmapped_code', 'web.err_status_400'],
    [403, 'some.unmapped_code', 'web.no_permission'],
    [404, 'some.unmapped_code', 'web.err_status_404'],
    [409, 'some.unmapped_code', 'web.err_status_409'],
    [412, 'some.unmapped_code', 'web.err_status_412'],
    [429, 'some.unmapped_code', 'web.err_status_429'],
    [500, 'internal.unhandled', 'web.err_internal_unhandled'],
    [503, 'some.unmapped_code', 'web.err_status_5xx'],
    [418, 'some.unmapped_code', 'web.rejected'],
    [404, 'http.error', 'web.err_status_404'],
    [502, 'unknown', 'web.err_status_5xx'],
  ] as const)('%i %s → %s, never the server message', (status, code, key) => {
    const text = errorText(english(status, code));
    expect(text).toBe(t(key));
    expect(text).not.toMatch(ENGLISH_SENTENCE);
  });

  it('settings.messageFor never returns the server message', () => {
    for (const [status, code] of [
      [400, 'request.invalid'],
      [422, 'nothing.mapped'],
      [500, 'internal.unhandled'],
    ] as const) {
      const text = messageFor(english(status, code));
      expect(text).toMatch(PERSIAN);
      expect(text).not.toMatch(ENGLISH_SENTENCE);
    }
  });

  it('the client fallback carries no sentence to show', async () => {
    const response = new Response('<html>Bad Gateway</html>', { status: 502 });
    const fetched = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal('fetch', fetched);
    const { fetchSettings } = await import('../../apps/web/src/api/client');
    const error = await fetchSettings().catch((caught: unknown) => caught);
    vi.unstubAllGlobals();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('unknown');
    expect(errorText(error)).toBe(t('web.err_status_5xx'));
  });
});

describe('errorIssues', () => {
  const refused = (issues: unknown[]) =>
    new ApiError(400, 'request.invalid', 'The request payload is invalid.', { issues });

  it('says a refused amount as a Persian rule, never zod English', () => {
    const [issue] = errorIssues(
      refused([
        { path: 'amountMinor', message: 'expected a positive whole number of minor units' },
      ]),
    );
    expect(issue?.text).toBe('مبلغ باید یک عدد صحیح بزرگ‌تر از صفر باشد.');
    expect(issue?.raw).toBe('amountMinor: expected a positive whole number of minor units');
  });

  it('names a known field and falls back to a generic sentence for an unknown one', () => {
    const issues = errorIssues(
      refused([
        { path: 'items.2.reason', message: 'Required' },
        { path: 'zzz.0', message: 'Expected number, received string' },
      ]),
    );
    expect(issues[0]?.text).toBe(t('web.err_field_invalid').replace('{field}', 'دلیل'));
    expect(issues[1]?.text).toBe(t('web.err_field_unknown'));
  });

  it('takes a page field label before the shared one', () => {
    expect(fieldText('value.0', { value: 'web.err_field_handle' })).toContain('شناسهٔ کانال');
  });

  it('says template issues by kind and keeps the token', () => {
    const [issue] = errorIssues(
      refused([{ kind: 'UNKNOWN_PLACEHOLDER', token: 'nme', detail: '{nme} is not declared.' }]),
    );
    expect(issue?.text).toBe(t('web.template_issue_unknown'));
    expect(issue?.token).toBe('nme');
  });

  it('keeps a setting schema string only as raw', () => {
    const [issue] = errorIssues(refused(['Expected number, received string']));
    expect(issue?.text).toBe(t('web.err_issue_generic'));
    expect(issue?.raw).toBe('Expected number, received string');
  });
});

describe('ApiErrorReport', () => {
  it('shows Persian, the code and correlation id ltr, and the English only under technical details', () => {
    const error = new ApiError(
      400,
      'request.invalid',
      'The request payload is invalid.',
      { issues: [{ path: 'amountMinor', message: 'expected a positive whole number' }] },
      { kind: 'VALIDATION', correlationId: 'c0ffee-42' },
    );
    const { container } = render(<ApiErrorReport error={error} />);
    expect(screen.getByRole('alert')).toHaveTextContent(t('web.err_request_invalid'));
    expect(screen.getByText('مبلغ باید یک عدد صحیح بزرگ‌تر از صفر باشد.')).toBeInTheDocument();
    const correlation = screen.getByText('c0ffee-42');
    expect(correlation).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('request.invalid')).toHaveAttribute('dir', 'ltr');
    const raw = screen.getByText('amountMinor: expected a positive whole number');
    expect(raw.closest('details')).not.toBeNull();
    expect(container.textContent).not.toContain('The request payload is invalid.');
    // No Persian sentence sits inside an ltr / monospace element.
    for (const element of container.querySelectorAll('.ltr, .mono, [dir="ltr"]')) {
      expect(element.textContent ?? '').not.toMatch(PERSIAN);
    }
  });
});

/**
 * No page or kit component shows `.message` of an `Error` / `ApiError`.
 *
 * The server's message is English for a log; a page reaches a Persian sentence through
 * `errorText`. Matches the identifiers errors are held in (`error`, `err`, `cause`,
 * `caught`, `e`, `exception`, `save.error`, …).
 */
describe('no page renders an error message', () => {
  const ROOTS = ['apps/web/src/pages', 'apps/web/src/ui'];
  const READ = /\b(?:error|err|cause|caught|e|exception|failure)\.message\b|\.error\.message\b/u;
  /**
   * The ONE allowed read: the settings 409 guard. A change guard refuses a combination with a
   * sentence written in Persian for the operator; it is shown only when it IS Persian.
   */
  const ALLOWED = new Set([
    'apps/web/src/pages/settings.tsx:  if (guarded && PERSIAN_SCRIPT.test(error.message)) {',
    'apps/web/src/pages/settings.tsx:    return <Banner tone="danger">{error.message}</Banner>;',
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.tsx?$/u.test(path)) out.push(path);
    }
    return out;
  }

  it('finds no .message read outside the allow-list', () => {
    const offenders: string[] = [];
    const repo = join(import.meta.dirname, '../..');
    for (const root of ROOTS) {
      for (const absolute of walk(join(repo, root))) {
        const file = relative(repo, absolute);
        const lines = readFileSync(absolute, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          if (!READ.test(line)) continue;
          const entry = `${file}:${line}`;
          if (!ALLOWED.has(entry)) offenders.push(entry);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan sees a planted read', () => {
    expect(READ.test('return error instanceof Error ? error.message : String(error);')).toBe(true);
    expect(READ.test('{save.error instanceof ApiError ? save.error.message : x}')).toBe(true);
    expect(READ.test('{refusal.message}')).toBe(false);
  });
});
