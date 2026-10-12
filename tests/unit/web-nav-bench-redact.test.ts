import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { failureLine } from '../../scripts/perf/redact.mjs';

const BENCH = readFileSync(
  new URL('../../scripts/perf/web-nav-bench.mjs', import.meta.url),
  'utf8',
);

describe('web-nav-bench never puts the password into page source', () => {
  it('passes it as a CDP argument, not by template interpolation', () => {
    expect(BENCH).not.toMatch(/\$\{[^}]*NEXA_BENCH_PASSWORD/);
    expect(BENCH).toContain(
      'arguments: [{ value: o.username }, { value: process.env.NEXA_BENCH_PASSWORD }]',
    );
  });

  it('prints a failure through the redacting printer, never the error object', () => {
    expect(BENCH).toContain('console.error(failureLine(error, process.env.NEXA_BENCH_PASSWORD))');
    expect(BENCH).not.toMatch(/console\.error\(error\)/);
  });
});

describe('web-nav-bench prints a failure without the sign-in password', () => {
  const secret = 'bench-pass-not-real-42';

  it('replaces every occurrence of the password in the message', () => {
    const error = new Error(
      `Runtime.evaluate: failed in body: {"password":"${secret}"} and again ${secret}`,
    );
    const line = failureLine(error, secret);
    expect(line).not.toContain(secret);
    expect(line).toBe(
      'Error: Runtime.evaluate: failed in body: {"password":"[redacted]"} and again [redacted]',
    );
  });

  it('replaces the password as it reads inside JSON, too', () => {
    const quoted = 'pa"ss\\word';
    const line = failureLine(new Error(`body: ${JSON.stringify({ password: quoted })}`), quoted);
    expect(line).toBe('Error: body: {"password":"[redacted]"}');
  });

  it('prints only the name and message, never the stack or a cause', () => {
    const error = new TypeError('sign-in answered 401', { cause: { source: secret } });
    error.stack = `TypeError: ${secret}\n    at main`;
    expect(failureLine(error, secret)).toBe('TypeError: sign-in answered 401');
  });

  it('prints a thrown non-Error as text, redacted too', () => {
    expect(failureLine(`lost ${secret}`, secret)).toBe('Error: lost [redacted]');
    expect(failureLine('plain', undefined)).toBe('Error: plain');
  });
});
