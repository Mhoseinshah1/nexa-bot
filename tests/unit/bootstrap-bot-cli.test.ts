import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, tokenFromFile } from '../../apps/api/src/bootstrap-bot.cli';

/**
 * The half of the bootstrap CLI that decides where a bot token comes from.
 *
 * `main` needs a database and a terminal and is exercised by the deployment
 * smoke test. These two functions are the ones carrying a security rule, and
 * they are exported so the rule can be held to rather than described:
 *
 *   - a token never arrives through argv, and a flag that would put one there
 *     is REFUSED rather than ignored;
 *   - a flag with no value is an error, not the same as an absent flag.
 */
describe('bootstrap-bot CLI arguments', () => {
  it('reads the flags an installer passes', () => {
    const args = parseArgs([
      '--public-base-url',
      'https://bot.example.com',
      '--bot-token-file',
      '/run/secrets/token',
      '--tenant',
      'acme',
    ]);
    expect(args).toEqual({
      status: false,
      publicBaseUrl: 'https://bot.example.com',
      tokenFile: '/run/secrets/token',
      tenantSlug: 'acme',
    });
  });

  it('refuses a token on the command line, in either spelling', () => {
    // Refused, not ignored. Using it would put a bearer credential in `ps` and
    // in shell history; ignoring it would leave an operator believing a token
    // they supplied had been used.
    expect(() => parseArgs(['--bot-token', '8123456789:AAH'])).toThrowError(/never taken/);
    expect(() => parseArgs(['--bot-token=8123456789:AAH'])).toThrowError(/never taken/);
  });

  it('refuses a flag with no value rather than treating it as absent', () => {
    // `--tenant` followed by nothing used to fall through to the primary
    // tenant, so an operator aiming at one tenant configured another and was
    // told it had worked. Same shape, same refusal.
    expect(() => parseArgs(['--tenant'])).toThrowError(/--tenant needs a value/);
    expect(() => parseArgs(['--bot-token-file', '--status'])).toThrowError(
      /--bot-token-file needs a value/,
    );
  });

  it('reads --status without needing anything else', () => {
    expect(parseArgs(['--status', '--public-base-url', 'https://bot.example.com']).status).toBe(
      true,
    );
  });
});

describe('bootstrap-bot CLI token file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexa-bot-token-'));

  it('strips the trailing newline an editor adds, and nothing else', () => {
    const path = join(dir, 'token');
    writeFileSync(path, '8123456789:AAH-secret\n');
    expect(tokenFromFile(path)).toBe('8123456789:AAH-secret');

    // Interior and leading whitespace is left alone: the service's shape check
    // refuses it with a reason, which is more useful than a reader silently
    // "fixing" a file whose content the operator can see is wrong.
    const padded = join(dir, 'padded');
    writeFileSync(padded, ' 8123456789:AAH secret\n');
    expect(tokenFromFile(padded)).toBe(' 8123456789:AAH secret');
  });

  it('handles a CRLF file', () => {
    const path = join(dir, 'crlf');
    writeFileSync(path, '8123456789:AAH-secret\r\n');
    expect(tokenFromFile(path)).toBe('8123456789:AAH-secret');
  });

  it('refuses an empty file instead of sending an empty token to Telegram', () => {
    const path = join(dir, 'empty');
    writeFileSync(path, '\n');
    expect(() => tokenFromFile(path)).toThrowError(/is empty/);
  });
});
