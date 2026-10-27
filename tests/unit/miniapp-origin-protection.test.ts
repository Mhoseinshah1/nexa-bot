import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINIAPP_DOCUMENT_CSP } from '../../apps/api/src/surfaces/miniapp/static.controller';

/**
 * R11 A5 — Mini App origin protection (OQ-R11-A5-01).
 *
 * Secondary sources report that, from 2026-07-20, Telegram blocks Mini App methods
 * (`Telegram.WebApp.*`) called from a page on an origin other than the Mini App's own
 * registered domain. The official page was not reachable when this was written, so nothing
 * here encodes Telegram's exact rule. What it pins is the property this app already has and
 * every reading of that rule depends on: the Mini App is ONE origin. It embeds no other
 * page, navigates its own view nowhere else, and reaches the Telegram object only from its
 * own document. Anything leaving the app (a payment page, a `t.me` link) goes through
 * `openLink` / `openTelegramLink`, which hand the URL to Telegram instead of navigating the
 * Mini App's view.
 */
const SRC = join(__dirname, '../../apps/miniapp/src');

function sources(dir: string): { file: string; text: string }[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
}

describe('the Mini App stays a single origin', () => {
  const files = sources(SRC);

  it('reads at least the files it should', () => {
    expect(files.map((f) => f.file)).toContain('telegram.ts');
  });

  it('embeds no frame and navigates its own view nowhere', () => {
    const forbidden = [
      /<iframe/i,
      /<frame\b/i,
      /\blocation\.(href|assign|replace)\b/,
      /\blocation\s*=[^=]/,
      /document\.write/,
      /<a\b[^>]*\bhref=/i,
    ];
    for (const { file, text } of files) {
      for (const pattern of forbidden) {
        expect(text, `${file} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('opens a new window only as the outside-Telegram fallback in telegram.ts', () => {
    for (const { file, text } of files) {
      const count = (text.match(/window\.open\(/g) ?? []).length;
      expect(count, file).toBe(file === 'telegram.ts' ? 2 : 0);
    }
  });

  it('lets the document load scripts from itself and telegram.org only, and talk only to itself', () => {
    const directives = MINIAPP_DOCUMENT_CSP.split('; ');
    expect(directives).toContain("script-src 'self' https://telegram.org");
    expect(directives).toContain("connect-src 'self'");
    expect(MINIAPP_DOCUMENT_CSP).not.toMatch(/\b(frame-src|child-src)\b/);
  });
});
