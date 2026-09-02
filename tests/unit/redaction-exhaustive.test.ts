import { describe, expect, it } from 'vitest';
import { redactSecretText } from '../../apps/api/src/infrastructure/redaction';

/**
 * The redactor, checked by CONSTRUCTION rather than by example.
 *
 * This file exists because case-by-case tests kept passing while the function
 * was wrong. Four consecutive review rounds found a labelled secret that
 * survived — a JSON-quoted value, a single-quoted one, a scheme the list did
 * not name, a value longer than the bound — and each time the fix came with a
 * test for exactly that case and no more, so the next shape went unnoticed
 * until somebody thought of it.
 *
 * Thinking of them one at a time is the thing that does not work. So the cases
 * below are the CROSS PRODUCT of the ways a secret is labelled, quoted,
 * prefixed and surrounded, and the assertion is the same for all of them: the
 * secret does not appear in the output. A gap now has to be a gap in the
 * dimensions rather than in somebody's imagination.
 */

/** A distinctive secret, so a survival is unambiguous in the assertion. */
const SECRET = 'sk-live-ZQ7hV2pR8nX4mK6tW9bY3cF5';

const NAMES = [
  'token',
  'Token',
  'TOKEN',
  'access_token',
  'accessToken',
  'api_key',
  'api-key',
  'apiKey',
  'X-Api-Key',
  'password',
  'passwd',
  'secret',
  'client_secret',
  'authorization',
  'Authorization',
  'Proxy-Authorization',
  'X-Auth-Token',
  'credential',
  'privateKey',
  'signature',
  'cookie',
  'session',
];

/** How the name and value are joined, as a wire format actually writes them. */
const SEPARATORS = ['=', ': ', ':', ' = ', '="', ': "', "='", ": '"];

/**
 * What may sit between the separator and the secret.
 *
 * The last three are schemes NO list in this codebase names, and they are the
 * point. The first version of this file used only schemes the labelled rule
 * already knew, so deleting the credential-header rule entirely left every one
 * of its thousand cases green — the file had reproduced, in its own choice of
 * dimensions, exactly the blind spot it was written to remove. The set of
 * authorization schemes is open; a test that only tries the closed part of it
 * proves nothing about the rule that exists for the rest.
 */
const PREFIXES = [
  '',
  'Bearer ',
  'Basic ',
  'Digest ',
  'Token ',
  'SSWS ',
  'NTLM ',
  'DPoP ',
  'GoogleLogin ',
  'AWS4-HMAC-SHA256 ',
  'SomeSchemeNobodyListed ',
];

describe('every labelled shape of a secret is redacted', () => {
  const built: string[] = [];
  for (const name of NAMES) {
    for (const separator of SEPARATORS) {
      for (const prefix of PREFIXES) {
        const closing = separator.endsWith('"') ? '"' : separator.endsWith("'") ? "'" : '';
        built.push(`${name}${separator}${prefix}${SECRET}${closing}`);
      }
    }
  }

  it('covers a meaningful number of shapes', () => {
    // If a refactor collapses the tables, the sweep below would still pass
    // while checking almost nothing.
    expect(built.length).toBeGreaterThan(500);
  });

  it('leaves the secret in none of them, bare', () => {
    const survived = built.filter((line) => redactSecretText(line).includes(SECRET));
    expect(survived, `${survived.length} shapes leaked; first: ${survived[0]}`).toEqual([]);
  });

  it('leaves the secret in none of them, inside a sentence', () => {
    const survived = built.filter((line) =>
      redactSecretText(`the panel refused the request: ${line} — retrying in 30s`).includes(SECRET),
    );
    expect(survived, `${survived.length} shapes leaked; first: ${survived[0]}`).toEqual([]);
  });

  it('leaves the secret in none of them, inside a JSON body', () => {
    const survived = built.filter((line) =>
      redactSecretText(`{"error":"unauthorized","detail":"${line}"}`).includes(SECRET),
    );
    expect(survived, `${survived.length} shapes leaked; first: ${survived[0]}`).toEqual([]);
  });

  it('leaves the secret in none of them, when a second secret follows on the line', () => {
    // The rule matched once per line at one point, so the first secret was
    // redacted and everything after it survived.
    const survived = built.filter((line) =>
      redactSecretText(`${line} and password=${SECRET}`).includes(SECRET),
    );
    expect(survived, `${survived.length} shapes leaked; first: ${survived[0]}`).toEqual([]);
  });

  it('leaves the secret out of a parameterised credential', () => {
    // One header value split by commas and quotes — the characters a
    // token-shaped matcher stops at.
    for (const name of ['Authorization', 'Proxy-Authorization']) {
      const digest = `${name}: Digest username="Mufasa", realm="example", response="${SECRET}"`;
      expect(redactSecretText(digest)).not.toContain(SECRET);
    }
  });

  it('leaves the secret in none of them, when the value is long', () => {
    // A value beyond the internal bound matched nothing at all and was
    // returned untouched.
    const long = SECRET + 'x'.repeat(5_000);
    const survived = NAMES.filter((name) => redactSecretText(`${name}="${long}"`).includes(SECRET));
    expect(survived, `${survived.length} names leaked`).toEqual([]);
  });
});

/**
 * The other half of the rule, and the half a redactor most easily breaks:
 * ordinary operator text has to survive. A function that returns `[redacted]`
 * for everything passes every test above.
 */
describe('ordinary operational text is left alone', () => {
  const untouched = [
    'chat not found (400) after 2 attempts against chat -100999',
    'author: alice reported it',
    'Token expired at 2026-09-02T00:00:00Z',
    'token expired for tenant 019abc',
    'Basic auth failed for user alice',
    'Digest mismatch: recomputed 9f8e',
    'Negotiate handshake failed, falling back',
    'Mutual TLS is not configured for this panel',
    'session ended normally',
    'signature verification skipped: no signing key configured',
    'Too Many Requests: retry after 30',
    'the panel returned 502 Bad Gateway',
  ];

  it.each(untouched)('leaves %j unchanged', (line) => {
    expect(redactSecretText(line)).toBe(line);
  });
});
