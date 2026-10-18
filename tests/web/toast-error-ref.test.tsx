import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ApiError } from '../../apps/web/src/api/client';
import { t } from '../../apps/web/src/i18n/web.fa';
import { ToastProvider, useToast, type ToastOptions } from '../../apps/web/src/ui/kit';

/**
 * A danger toast built from an API error carries that error, so the toast draws the code and
 * correlation id under its Persian sentence exactly as a banner does (`ErrorRef`). Without
 * it, a refusal that only ever reached a toast left support with a sentence and nothing to
 * find in the log.
 */

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_SRC = join(REPO_ROOT, 'apps/web/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') || name.endsWith('.ts') ? [path] : [];
  });
}

/** Every `notify(…)` / `toast(…)` call, its argument read to the balancing parenthesis. */
function toastCalls(): { file: string; line: number; call: string }[] {
  const found: { file: string; line: number; call: string }[] = [];
  for (const path of sources(WEB_SRC)) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/\b(?:notify|toast)\(/g)) {
      let index = match.index + match[0].length;
      let depth = 1;
      while (depth > 0 && index < text.length) {
        if (text[index] === '(') depth += 1;
        else if (text[index] === ')') depth -= 1;
        index += 1;
      }
      found.push({
        file: relative(REPO_ROOT, path),
        line: text.slice(0, match.index).split('\n').length,
        call: text.slice(match.index, index).replace(/\s+/g, ' '),
      });
    }
  }
  return found;
}

const isDanger = (call: string) => /'danger'/.test(call);
const passesError = (call: string) => /[{,]\s*error(?:\s*[,}]|\s*:)/.test(call);

/**
 * Danger toasts that are NOT built from an API error, each with the reason. A new entry
 * needs the same justification: a danger toast inside an `onError` belongs nowhere here.
 */
const NOT_FROM_AN_API_ERROR: Readonly<Record<string, { count: number; reason: string }>> = {
  'apps/web/src/ui/kit.tsx': { count: 2, reason: 'the browser refused the clipboard' },
  'apps/web/src/pages/panels.tsx': {
    count: 3,
    reason: 'a form check that refuses before any request is sent',
  },
  'apps/web/src/pages/service-refund-requests.tsx': {
    count: 1,
    reason: 'a FAILED state read from a successful answer',
  },
  'apps/web/src/pages/fx-section.tsx': {
    count: 1,
    reason: 'a FAILED outcome read from a successful answer',
  },
};

describe('danger toasts carry the API error they were built from', () => {
  it('passes the error wherever the message is derived from one', () => {
    const offenders = toastCalls()
      .filter(({ call }) => isDanger(call))
      .filter(({ call }) => /\((?:error|err|cause|failure)(?:\.\w+)?\)/.test(call))
      .filter(({ call }) => !passesError(call))
      .map(({ file, line, call }) => `${file}:${String(line)} ${call}`);
    expect(offenders).toEqual([]);
  });

  it('leaves out the error only where no API error exists, each listed with its reason', () => {
    const without = new Map<string, number>();
    for (const { file, call } of toastCalls()) {
      if (isDanger(call) && !passesError(call)) without.set(file, (without.get(file) ?? 0) + 1);
    }
    expect(Object.fromEntries(without)).toEqual(
      Object.fromEntries(
        Object.entries(NOT_FROM_AN_API_ERROR).map(([file, { count }]) => [file, count]),
      ),
    );
  });

  it('finds the call sites it guards (the scan is not reading nothing)', () => {
    const withError = toastCalls().filter(({ call }) => isDanger(call) && passesError(call));
    expect(withError.length).toBeGreaterThanOrEqual(26);
    expect(withError.some(({ file }) => file.endsWith('pages/business-chats.tsx'))).toBe(true);
  });
});

function Trigger({ toast }: { toast: ToastOptions }) {
  const notify = useToast();
  return (
    <button type="button" onClick={() => notify(toast)}>
      go
    </button>
  );
}

function shown(toast: ToastOptions): HTMLElement {
  render(
    <ToastProvider>
      <Trigger toast={toast} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'go' }));
  const found = document.querySelector('.toast');
  expect(found).not.toBeNull();
  return found as HTMLElement;
}

describe('a toast with an error', () => {
  it('draws the sentence, then the code and correlation id under it', () => {
    const error = new ApiError(409, 'business_chat.stale', 'raw server words', undefined, {
      kind: 'conflict',
      correlationId: 'corr-42',
    });
    const toast = shown({ tone: 'danger', message: 'جمله', error });
    expect(toast.firstChild?.textContent).toBe('جمله');
    const reference = toast.querySelector('.err-ref');
    expect(reference).not.toBeNull();
    const scoped = within(reference as HTMLElement);
    expect(scoped.getByText(t('web.err_ref_code'))).toBeTruthy();
    expect(scoped.getByText('business_chat.stale').getAttribute('dir')).toBe('ltr');
    expect(scoped.getByText(t('web.err_ref_correlation'))).toBeTruthy();
    expect(scoped.getByText('corr-42').getAttribute('dir')).toBe('ltr');
    expect(toast.textContent).not.toContain('raw server words');
  });

  it('draws the code alone when the answer carried no correlation id', () => {
    const toast = shown({
      tone: 'danger',
      message: 'جمله',
      error: new ApiError(500, 'internal', 'x'),
    });
    expect(toast.querySelector('.err-ref')?.textContent).toContain('internal');
    expect(toast.textContent).not.toContain(t('web.err_ref_correlation'));
  });

  it('draws no reference without an error', () => {
    expect(shown({ tone: 'danger', message: 'a' }).querySelector('.err-ref')).toBeNull();
  });

  it('draws no reference for an error that is not an API error', () => {
    const toast = shown({ tone: 'danger', message: 'b', error: new TypeError('offline') });
    expect(toast.querySelector('.err-ref')).toBeNull();
  });
});
