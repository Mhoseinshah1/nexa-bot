import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A raw password-type input is a site login to the browser: it suggests saved logins under it
 * and offers «Update password?» after a save. Every secret field (API key, bot token, webhook
 * secret, panel or backup password, recovery key) goes through the kit's `SecretInput`.
 * Only a real login keeps the password type, with its proper `autocomplete`.
 */
const SRC = join(__dirname, '..', '..', 'apps', 'web', 'src');

/** The Web Admin sign-in, an admin changing their own password, a hosted-bot owner creating theirs. */
const REAL_LOGIN_FILES: readonly string[] = [
  'app.tsx',
  'pages/account.tsx',
  'pages/hosted-activate.tsx',
];

const PASSWORD_TYPE = /\btype\s*[=:]\s*\{?\s*['"]password['"]/u;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/u.test(path)) out.push(path);
  }
  return out;
}

/** A line that is only a comment does not render anything. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
    .join('\n');
}

describe('raw type="password" inputs in apps/web/src', () => {
  it('appear only in the real-login allowlist', () => {
    const offenders = sources(SRC)
      .map((file) => relative(SRC, file))
      .filter((file) => !REAL_LOGIN_FILES.includes(file))
      .filter((file) => PASSWORD_TYPE.test(code(readFileSync(join(SRC, file), 'utf8'))));
    expect(offenders, 'use SecretInput from ui/kit for a secret field').toEqual([]);
  });

  it('the allowlisted files keep a proper autocomplete on every password input', () => {
    for (const file of REAL_LOGIN_FILES) {
      const text = code(readFileSync(join(SRC, file), 'utf8'));
      const tags: string[] = [];
      for (const hit of text.matchAll(/type="password"/gu)) {
        const start = text.lastIndexOf('<input', hit.index);
        tags.push(text.slice(start, text.indexOf('/>', hit.index)));
      }
      expect(tags.length, file).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, file).toMatch(/autoComplete=(\{[^}]+\}|"(current|new)-password")/u);
      }
    }
  });
});
