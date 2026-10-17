import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as contracts from '@nexa/contracts';
import { ApiError } from '../../apps/web/src/api/client';
import {
  API_LOCAL_ERROR_TEXT,
  ERROR_TEXT,
  errorIssues,
  errorText,
  fieldText,
  hasErrorText,
} from '../../apps/web/src/error-text';
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

/**
 * C2: every code the API RAISES as a refusal (4xx) has a Persian sentence — not only the codes a
 * contracts catalogue declares. The API is read as text (the Web Admin may not import it):
 *
 * - every `errors.validation|notFound|conflict|permissionDenied|unauthenticated|
 *   preconditionFailed(<code>, …)` call, and every `new NexaError({ … code: <code> … })` whose
 *   `kind` is a 4xx kind (or is not a literal);
 * - `<code>` is resolved: a string literal is the code; each `NAME.PROP` inside it (a ternary
 *   names two) is looked up in `@nexa/contracts`, else in an object literal `const NAME = { PROP:
 *   '…' }` declared in the API (a local catalogue such as `SUPPORT_AI_ERROR_CODES`), following
 *   one `const NAME = OTHER_ERROR_CODES` alias;
 * - an argument that resolves to nothing must be on `DYNAMIC_RAISES`, each reviewed: a new
 *   unresolvable raise fails until somebody looks at what it can carry.
 *
 * Each resolved code must then have a sentence (`hasErrorText`).
 */
describe('every refusal code the API raises has Persian', () => {
  const repo = join(import.meta.dirname, '../..');
  const apiRoot = join(repo, 'apps/api/src');
  const RAISE =
    /errors\.(?:validation|notFound|conflict|permissionDenied|unauthenticated|preconditionFailed)\(\s*([^,]+?)\s*,/gu;
  const NEXA_ERROR = /new NexaError\(\{([^}]*)\}/gu;
  const REFUSAL_KINDS = new Set([
    'VALIDATION',
    'NOT_FOUND',
    'CONFLICT',
    'PERMISSION_DENIED',
    'UNAUTHENTICATED',
    'PRECONDITION_FAILED',
    'RATE_LIMITED',
  ]);
  /**
   * Raise sites whose code is a variable. Each was read: the variable is typed or assigned
   * from catalogued constants only, and those constants are walked by the catalogue test above.
   */
  const DYNAMIC_RAISES = new Set([
    // `stateRefusal` is typed as ORDER_STATE_INVALID | SERVICE_ACTION_NOT_ALLOWED.
    'apps/api/src/modules/commerce/provisioning/application/provisioning.service.ts: stateRefusal',
    // `refuse(code, …)`: every caller passes a COMMERCE_ERROR_CODES constant.
    'apps/api/src/modules/commerce/provisioning/application/provisioning.service.ts: code',
    // `code` is PANEL_TARGET_BLOCKED or PANEL_URL_INVALID, two lines above.
    'apps/api/src/modules/platform/panels/application/panel.service.ts: code',
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.ts$/u.test(path) && !/\.test\.ts$/u.test(path)) out.push(path);
    }
    return out;
  }

  /** Source with its comments removed: a raise inside prose is not a raise. */
  const uncommented = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
  const sources = new Map(
    walk(apiRoot).map((path) => [path, uncommented(readFileSync(path, 'utf8'))]),
  );
  const catalogues = contracts as unknown as Readonly<Record<string, unknown>>;

  function contractValue(name: string, prop: string): string | null {
    const table = catalogues[name];
    if (typeof table !== 'object' || table === null) return null;
    const value = (table as Record<string, unknown>)[prop];
    return typeof value === 'string' ? value : null;
  }

  function localValue(name: string, prop: string): string | null {
    for (const text of sources.values()) {
      const alias = new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*([A-Z_]+)\\s*;`, 'u').exec(text);
      if (alias?.[1] !== undefined) {
        const value = contractValue(alias[1], prop);
        if (value !== null) return value;
      }
      const object = new RegExp(`const ${name}\\s*=\\s*\\{([^}]*)\\}`, 'u').exec(text);
      if (object?.[1] === undefined) continue;
      const entry = new RegExp(`\\b${prop}:\\s*'([^']+)'`, 'u').exec(object[1]);
      if (entry?.[1] !== undefined) return entry[1];
    }
    return null;
  }

  /** The codes one raise argument can carry, or `null` when it names none. */
  function resolve(argument: string): string[] | null {
    const code = argument.trim();
    const literal = /^'([^']+)'$/u.exec(code);
    if (literal?.[1] !== undefined) return [literal[1]];
    const references = [...code.matchAll(/\b([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]*)\b/gu)];
    if (references.length === 0) return null;
    const found: string[] = [];
    for (const [, name, prop] of references) {
      const value = contractValue(name ?? '', prop ?? '') ?? localValue(name ?? '', prop ?? '');
      if (value === null) return null;
      found.push(value);
    }
    return found;
  }

  function raised(): { codes: Map<string, string>; unresolved: string[] } {
    const codes = new Map<string, string>();
    const unresolved: string[] = [];
    for (const [path, text] of sources) {
      const file = relative(repo, path);
      const argumentsOf = [...text.matchAll(RAISE)].map((match) => match[1] ?? '');
      for (const match of text.matchAll(NEXA_ERROR)) {
        const body = match[1] ?? '';
        const kind = /kind:\s*'([A-Z_]+)'/u.exec(body)?.[1];
        if (kind !== undefined && !REFUSAL_KINDS.has(kind)) continue;
        const code = /code:\s*([^,\n]+)/u.exec(body)?.[1];
        if (code !== undefined) argumentsOf.push(code);
      }
      for (const argument of argumentsOf) {
        const resolved = resolve(argument);
        if (resolved === null) {
          const entry = `${file}: ${argument.trim()}`;
          if (!DYNAMIC_RAISES.has(entry)) unresolved.push(entry);
          continue;
        }
        for (const code of resolved) codes.set(code, file);
      }
    }
    return { codes, unresolved };
  }

  const { codes, unresolved } = raised();

  it('walks a real set of raise sites, local catalogues included', () => {
    expect(codes.size).toBeGreaterThan(300);
    // Literals, contract constants and the API-local catalogues are all seen.
    expect(codes.has('platform.permission_denied')).toBe(true);
    expect(codes.has('commerce.order_not_found')).toBe(true);
    expect(codes.has('support_ai.version_conflict')).toBe(true);
    expect(codes.has('business_chats.not_in_state')).toBe(true);
    expect(codes.has('qr.margin_invalid')).toBe(true);
  });

  it('resolves every raise argument, or knows why it cannot', () => {
    expect(unresolved).toEqual([]);
  });

  it('has a Persian sentence for every raised code', () => {
    const missing = [...codes].filter(([code]) => !hasErrorText(code));
    expect(missing).toEqual([]);
  });

  it('says every API-local code in Persian, never English', () => {
    const catalogue = WEB_FA as Readonly<Record<string, string>>;
    for (const [code, key] of Object.entries(API_LOCAL_ERROR_TEXT)) {
      expect(codes.has(code), code).toBe(true);
      expect(catalogue[key] ?? '', code).toMatch(PERSIAN);
      expect(t(key), code).not.toMatch(ENGLISH_SENTENCE);
    }
  });

  it('the scan sees a planted raise of an untranslated code', () => {
    const planted = "throw errors.conflict('planted.nothing_says_this', 'English.');";
    const [match] = [...planted.matchAll(RAISE)];
    const resolved = resolve(match?.[1] ?? '');
    expect(resolved).toEqual(['planted.nothing_says_this']);
    expect(hasErrorText('planted.nothing_says_this')).toBe(false);
    expect(resolve('SUPPORT_AI_ERROR_CODES.TEST_TOO_SOON')).toEqual(['support_ai.test_too_soon']);
    expect(resolve('someVariable')).toBeNull();
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
 * C3 (W6 §4): a refusal said in a `Banner` carries its code and correlation id.
 *
 * "Says an error" is found, not listed: every `function name(x: unknown, …): string` in
 * `apps/web/src` whose body reads `ApiError` or calls another such function (to a fixpoint,
 * from `errorText` and `messageFor`) is an error-sentence function — `kitMessage`,
 * `ticketFault`, `bulkMessage`, … — so a page's new helper is covered the day it is written.
 * Every `<Banner …>…</Banner>` in a page or kit component that calls one must also hold an
 * `ErrorRef` (or be an `ApiErrorReport`, which draws one).
 */
describe('every error banner carries the reference', () => {
  const repo = join(import.meta.dirname, '../..');
  const ROOTS = ['apps/web/src/pages', 'apps/web/src/ui'];
  const BANNER = /<Banner\b[\s\S]*?<\/Banner>/gu;
  const REFERENCED = /\b(?:ErrorRef|ApiErrorReport)\b/u;

  function walkSource(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walkSource(path, out);
      else if (/\.tsx?$/u.test(path)) out.push(path);
    }
    return out;
  }

  const sources = walkSource(join(repo, 'apps/web/src')).map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }));

  /** The error-sentence functions, by name. */
  function sentenceFunctions(): Set<string> {
    const FUNCTION =
      /^(?:export )?function ([a-z]\w*)\(\w+: unknown[^)]*\):\s*string\b[^{]*\{\n([\s\S]*?)^\}/gmu;
    const bodies = new Map<string, string[]>();
    for (const { text } of sources) {
      for (const match of text.matchAll(FUNCTION)) {
        const name = match[1] ?? '';
        bodies.set(name, [...(bodies.get(name) ?? []), match[2] ?? '']);
      }
    }
    const names = new Set(['errorText', 'messageFor']);
    for (let grew = true; grew;) {
      grew = false;
      const calls = new RegExp(`\\bApiError\\b|\\b(?:${[...names].join('|')})\\(`, 'u');
      for (const [name, found] of bodies) {
        if (!names.has(name) && found.some((body) => calls.test(body))) {
          names.add(name);
          grew = true;
        }
      }
    }
    return names;
  }

  const names = sentenceFunctions();
  const SAYS_ERROR = new RegExp(`\\b(?:${[...names].join('|')})\\(`, 'u');

  /** The error banners in one source text that draw no reference, by line. */
  function unreferenced(text: string): number[] {
    const lines: number[] = [];
    for (const match of text.matchAll(BANNER)) {
      if (SAYS_ERROR.test(match[0]) && !REFERENCED.test(match[0])) {
        lines.push(text.slice(0, match.index).split('\n').length);
      }
    }
    return lines;
  }

  it('finds the pages’ own error-sentence helpers', () => {
    for (const name of ['kitMessage', 'ticketFault', 'bulkMessage', 'recoveryErrorText']) {
      expect(names.has(name), name).toBe(true);
    }
    expect(names.size).toBeGreaterThan(30);
  });

  it('finds no error banner without its code and correlation id', () => {
    const offenders: string[] = [];
    let banners = 0;
    for (const { path, text } of sources) {
      const file = relative(repo, path);
      if (!ROOTS.some((root) => file.startsWith(root))) continue;
      banners += [...text.matchAll(BANNER)].filter((match) => SAYS_ERROR.test(match[0])).length;
      for (const line of unreferenced(text)) offenders.push(`${file}:${line}`);
    }
    // A guard against a broken walk making the scan vacuous.
    expect(banners).toBeGreaterThan(140);
    expect(offenders).toEqual([]);
  });

  it('the scan sees a planted banner without a reference, and one with it', () => {
    const planted = [
      '{save.error !== null && <Banner tone="danger">{messageFor(save.error)}</Banner>}',
      '<Banner tone="danger">',
      '  {kitMessage(exporter.error)}',
      '</Banner>',
      '<Banner tone="danger">{messageFor(x)}<ErrorRef error={x} /></Banner>',
      '<Banner tone="ok">{t(\'web.saved\')}</Banner>',
    ].join('\n');
    expect(unreferenced(planted)).toEqual([1, 2]);
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
    'apps/web/src/pages/settings.tsx:  if (guarded && guardSentenceShown(settingKey, error.message)) {',
    'apps/web/src/pages/settings.tsx:        {error.message}',
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
