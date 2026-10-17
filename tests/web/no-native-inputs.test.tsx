import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEB_FA } from '../../apps/web/src/i18n/web.fa';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'apps/web/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Lines of code (comments left out: a comment may name what a component replaces). */
function codeLines(path: string): { line: number; text: string }[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}

function offenders(pattern: RegExp, allowed: readonly string[] = []): string[] {
  return sources(SRC)
    .filter((path) => !allowed.includes(relative(ROOT, path)))
    .flatMap((path) =>
      codeLines(path)
        .filter(({ text }) => pattern.test(text))
        .map(({ line, text }) => `${relative(ROOT, path)}:${line}: ${text.trim()}`),
    );
}

/**
 * The approved Web Admin's cross-page rules that a source scan can hold (W1.1, W1.2, W5). A
 * page that draws a browser's own date picker or «Choose File / No file chosen» shows the
 * operator English and a Gregorian calendar; the shared fields replace both.
 */
describe('the browser’s own date and file controls', () => {
  it('draws no native date, date-time or time input — the Jalali DateField instead', () => {
    expect(offenders(/type\s*[=:]\s*\{?\s*["'](date|datetime-local|time)["']/)).toEqual([]);
  });

  it('draws no native file input outside the Persian FilePicker', () => {
    expect(
      offenders(/type\s*[=:]\s*\{?\s*["']file["']/, ['apps/web/src/ui/file-picker.tsx']),
    ).toEqual([]);
  });
});

describe('the word «صافی» (W5)', () => {
  it('appears in no text of the Web Admin catalogue — it reads «فیلتر»', () => {
    const found = Object.entries(WEB_FA).filter(([, text]) => text.includes('صافی'));
    expect(found).toEqual([]);
  });
});
