import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  suppliedToken,
  tokenForRun,
  tokenFromFile,
} from '../../apps/api/src/bootstrap-bot.cli';

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
      tokenStdin: false,
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

  it('refuses two token sources rather than picking one', () => {
    // Not a preference to resolve: a caller passing both does not know where its
    // own credential is coming from.
    expect(() => parseArgs(['--bot-token-file', '/x', '--bot-token-stdin'])).toThrowError(
      /either --bot-token-file or --bot-token-stdin/,
    );
  });

  it('reads the stdin flag the installer uses', () => {
    // The installer streams the token rather than mounting the file: the image
    // runs as `node` (uid 1000), and the token file the documented flow creates
    // is root-owned 0600, so a bind mount is unreadable inside the container.
    const args = parseArgs(['--bot-token-stdin', '--public-base-url', 'https://bot.example.com']);
    expect(args.tokenStdin).toBe(true);
    expect(args.tokenFile).toBeNull();
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    /*
     * The same rule as the missing-value check above, and the same failure. That
     * one exists because `--tenant` with nothing after it fell through to the
     * primary tenant; `--tenent reseller` did exactly that and was NOT caught,
     * because the parser took the flags it recognised and ignored the rest. The
     * run then reconciled the primary tenant's bot and printed success.
     */
    expect(() => parseArgs(['--tenent', 'reseller'])).toThrowError(/Unrecognised argument/);
    expect(() => parseArgs(['--status', '--dry-run'])).toThrowError(/--dry-run/);
  });

  it('refuses a positional value, which no flag here takes', () => {
    // Either a flag's value orphaned by a typo, or a misunderstanding of the
    // command. Both are better said out loud than acted on.
    expect(() => parseArgs(['reseller'])).toThrowError(/Unrecognised argument "reseller"/);
    expect(() => parseArgs(['--public-base-url', 'https://bot.example.com', 'extra'])).toThrowError(
      /Unrecognised argument "extra"/,
    );
  });

  it('accepts every flag it does take, in combination', () => {
    // The other half: a refusal that refuses too much is the same defect from
    // the other side, and an over-eager unknown-argument check is the obvious
    // way to get there.
    expect(() =>
      parseArgs([
        '--status',
        '--public-base-url',
        'https://bot.example.com',
        '--tenant',
        'acme',
        '--bot-token-stdin',
      ]),
    ).not.toThrow();
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

describe('bootstrap-bot CLI token source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexa-bot-source-'));
  const args = (over: Partial<Parameters<typeof suppliedToken>[0]>) =>
    ({
      status: false,
      publicBaseUrl: 'https://bot.example.com',
      tokenFile: null,
      tokenStdin: false,
      tenantSlug: null,
      ...over,
    }) as Parameters<typeof suppliedToken>[0];

  it('reads a supplied file, and reports none when nothing was supplied', async () => {
    const path = join(dir, 'supplied');
    writeFileSync(path, '8123456789:AAH-secret\n');
    await expect(suppliedToken(args({ tokenFile: path }))).resolves.toBe('8123456789:AAH-secret');
    await expect(suppliedToken(args({}))).resolves.toBeNull();
  });
});

describe('bootstrap-bot CLI token decision', () => {
  const prompted = '9999999999:from-the-prompt';
  const supplied = '8123456789:from-the-operator';

  it('never prompts when a token was supplied, whatever the state', async () => {
    /*
     * The rule a mutation pass found untested, and the defect it hides is the
     * one Codex reported: the CLI used to discard an explicitly supplied token
     * whenever a bot already existed, so a file naming a DIFFERENT bot never
     * reached the refusal written to catch it and the installer printed success
     * having changed nothing.
     */
    for (const state of ['none', 'incomplete', 'ready', 'unavailable'] as const) {
      let asked = 0;
      const token = await tokenForRun(supplied, state, async () => {
        asked += 1;
        return prompted;
      });
      expect(token, `state ${state} did not use the supplied token`).toBe(supplied);
      expect(asked, `state ${state} asked for a token that was supplied`).toBe(0);
    }
  });

  it('prompts ONLY on a fresh installation when nothing was supplied', async () => {
    // ADR-0029 decision 3: a rerun reconciles and must not so much as ask.
    let asked = 0;
    const ask = async () => {
      asked += 1;
      return prompted;
    };

    await expect(tokenForRun(null, 'none', ask)).resolves.toBe(prompted);
    expect(asked).toBe(1);

    for (const state of ['incomplete', 'ready', 'unavailable'] as const) {
      await expect(tokenForRun(null, state, ask), `state ${state}`).resolves.toBeNull();
    }
    expect(asked, 'a rerun asked for a token').toBe(1);
  });
});
