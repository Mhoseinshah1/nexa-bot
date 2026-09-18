import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admins as adminsTable } from '../../apps/api/src/infrastructure/persistence/schema';
import { provisionInstallation } from '../../apps/api/src/provision-installation.cli';
import { createTestContext, resetDatabase, testConfig, type TestContext } from './harness';

/**
 * The compiled bootstrap CLI, driven through a real pseudo-terminal.
 *
 * This exists because of a specific failure on a real Ubuntu 24.04 staging
 * host. The installer got all the way through — packages, PostgreSQL, Redis,
 * migrations, the tenant, the whole stack healthy, the API ready — and the
 * bootstrap CLI created the first owner and printed:
 *
 *     Owner "mamad" created for tenant "nexa" (...)
 *
 * and then never exited. Minutes later `docker ps` still showed
 * `nexa-api-run-… Up (unhealthy)` running `node dist/bootstrap-owner.cli.js`.
 * `docker compose run --rm` cannot return until its container's process does,
 * so the install stopped one step before writing the release manifest, and
 * `botctl version` reported "no current release is recorded" for good.
 *
 * `TerminalReader.attach()` resumed stdin and `close()` never paused it.
 * Dropping the `data` listeners does not stop a stream that was explicitly
 * resumed: it stays in flowing mode with its handle referenced and the event
 * loop never empties.
 *
 * A fake stdin asserting that `pause()` was called would not have caught this —
 * the fake would have been written against the same misunderstanding. So this
 * launches the ACTUAL compiled CLI down a pseudo-terminal, answers its
 * questions, and requires the process to end. The proof of exit is the exit
 * event itself; the timeout is only how the failure is reported.
 */
describe('the bootstrap CLI on a terminal', () => {
  let ctx: TestContext;
  const config = testConfig();
  const cli = join(__dirname, '../../apps/api/dist/bootstrap-owner.cli.js');

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await resetDatabase(ctx.container.database.db);
    await provisionInstallation(config.DATABASE_URL, {
      slug: 'nexa',
      displayName: 'Nexa',
      locale: 'fa',
      timezone: 'Asia/Tehran',
      calendar: 'jalali',
      currency: 'IRT',
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** An answer, and the prompt it is an answer to. */
  interface Answer {
    readonly after: string;
    readonly send: string;
  }

  interface Run {
    readonly output: string;
    readonly code: number | null;
    readonly exited: boolean;
  }

  /**
   * Runs the CLI with a pseudo-terminal for stdin, exactly as
   * `docker compose run` without `-T` gives it one.
   *
   * `script -qec` is the PTY: without it the child sees a pipe, takes the
   * buffered path, and the terminal reader this test exists for never runs at
   * all — the test would pass against the broken code.
   */
  const runOnATerminal = (answers: readonly Answer[], budgetMs = 60_000): Promise<Run> =>
    new Promise<Run>((resolve) => {
      const child = spawn('script', ['-qec', `node ${cli}`, '/dev/null'], {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          LOG_LEVEL: 'error',
          DATABASE_URL: config.DATABASE_URL,
          REDIS_URL: config.REDIS_URL,
          SECRETS_KEK: config.SECRETS_KEK,
          SECRETS_KEK_ID: config.SECRETS_KEK_ID,
          AUTH_MODE: 'password',
          // The runner's own topology is not this CLI's; left inherited, the
          // child dies at config validation and every assertion below is about
          // a process that never reached a prompt.
          DEPLOYMENT_TOPOLOGY: 'direct',
          TRUSTED_PROXY_IPS: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      // Answered as each prompt ARRIVES, the way a person does. Writing all
      // four up front would have the terminal's line discipline echo them
      // before the CLI has switched the password prompt out of echo — so the
      // password would appear in the transcript through the test's own doing,
      // and "the password was not echoed" could not be asserted at all.
      let next = 0;
      const feed = (): void => {
        while (next < answers.length && output.includes(answers[next]!.after)) {
          child.stdin.write(`${answers[next]!.send}\n`);
          next += 1;
        }
      };
      const observe = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        feed();
      };
      child.stdout.on('data', observe);
      child.stderr.on('data', observe);

      // The failure path, not the proof. Nothing waits for this timer when the
      // process ends on its own — `close` settles first and clears it.
      const giveUp = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ output, code: null, exited: false });
      }, budgetMs);

      child.on('close', (code) => {
        clearTimeout(giveUp);
        resolve({ output, code, exited: true });
      });
    });

  const owner = (
    username: string,
    displayName: string,
    password: string,
    telegramId = '123456789',
  ): Answer[] => [
    { after: 'Owner username: ', send: username },
    { after: 'Display name: ', send: displayName },
    // Asked BEFORE the password, so a mistyped id is refused before a
    // credential has been typed blind, twice.
    { after: 'Owner Telegram numeric ID: ', send: telegramId },
    { after: 'Password: ', send: password },
    { after: 'Confirm password: ', send: password },
  ];

  /**
   * The CLI driven down a PIPE, the way an unattended install drives it: no
   * terminal, the password on stdin, everything else as arguments.
   */
  const runOnAPipe = (
    args: readonly string[],
    stdinText: string,
    budgetMs = 60_000,
  ): Promise<Run> =>
    new Promise<Run>((resolve) => {
      const child = spawn('node', [cli, ...args], {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          LOG_LEVEL: 'error',
          DATABASE_URL: config.DATABASE_URL,
          REDIS_URL: config.REDIS_URL,
          SECRETS_KEK: config.SECRETS_KEK,
          SECRETS_KEK_ID: config.SECRETS_KEK_ID,
          AUTH_MODE: 'password',
          DEPLOYMENT_TOPOLOGY: 'direct',
          TRUSTED_PROXY_IPS: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stdin.end(stdinText);
      const giveUp = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ output, code: null, exited: false });
      }, budgetMs);
      child.on('close', (code) => {
        clearTimeout(giveUp);
        resolve({ output, code, exited: true });
      });
    });

  const adminRows = async () => ctx.container.database.db.select().from(adminsTable);

  it('creates the owner and then exits', async () => {
    const run = await runOnATerminal(owner('mamad', 'Mamad Owner', 'correcthorsebattery'));

    // The staging host got this far too. Creating the owner was never the
    // problem; the process outliving it was.
    expect(run.output).toContain('Owner "mamad" created');
    const rows = await adminRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('mamad');
    // Bound in the same transaction, from the answer the operator typed: an
    // owner with no binding has no supported way into the bot.
    expect(rows[0]?.telegramUserId).toBe('123456789');
    expect(run.output).toContain('bound to Telegram id 123456789');
    expect(run.output, 'the owner was not told to /start the bot').toContain('send /start once');

    expect(
      run.exited,
      'the CLI created the owner and never exited — `docker compose run --rm` would still be waiting',
    ).toBe(true);
    expect(run.code).toBe(0);
  }, 90_000);

  it('exits after refusing, too', async () => {
    // The same liveness question on the failure path. The refusal arrives after
    // the answers have been read and the reader closed, so a held-open stdin
    // hangs here just as surely — and this is the shape a rerun of the
    // installer would have taken.
    await runOnATerminal(owner('mamad', 'Mamad Owner', 'correcthorsebattery'));

    const again = await runOnATerminal(owner('someone', 'Someone Else', 'correcthorsebattery'));
    expect(again.output).toContain('bootstrap.already_completed');
    // The operator-facing form of a NexaError: its code and its message, not a
    // stack.
    expect(again.output).toContain('Bootstrap creates the FIRST one only');
    expect(again.exited, 'a refused bootstrap never exited').toBe(true);
    expect(again.code).not.toBe(0);
    // The fence held: still one owner.
    expect(await adminRows()).toHaveLength(1);
  }, 120_000);

  it('refuses a Telegram id that is not a numeric id, before the password is asked for', async () => {
    // A username, an @handle, a signed number, a value with a space: each is
    // refused with the schema's own sentence, and the password prompt is never
    // reached — so nothing is typed blind for an owner that will not be created.
    for (const bad of ['mamad', '@mamad', '-5', '12 34', '0123']) {
      const run = await runOnATerminal(owner('mamad', 'Mamad Owner', 'correcthorsebattery', bad));
      expect(run.output, `"${bad}" was not refused`).toContain(
        'The owner Telegram id must be a positive Telegram numeric id.',
      );
      expect(run.output, `"${bad}" reached the password prompt`).not.toContain('Password: ');
      expect(run.exited, `"${bad}" left the CLI running`).toBe(true);
      expect(run.code).not.toBe(0);
    }
    expect(await adminRows()).toHaveLength(0);
  }, 180_000);

  it('refuses, off a terminal, to run without --telegram-id, before reading stdin', async () => {
    // The unattended install: the password on a pipe and the id as an argument.
    // With no argument the id cannot be read from the pipe — the password line
    // would be taken as the id — so it is refused before a byte is read, and
    // the refusal names the flag.
    const refused = await runOnAPipe(
      ['--username', 'mamad', '--display-name', 'Mamad Owner'],
      'correcthorsebattery\n',
    );
    expect(refused.output).toContain('--telegram-id');
    expect(refused.output).toContain('Nothing was created.');
    expect(refused.output, 'the refusal printed a stack trace').not.toContain(
      'at Object.<anonymous>',
    );
    expect(refused.exited).toBe(true);
    expect(refused.code).not.toBe(0);
    expect(await adminRows()).toHaveLength(0);

    // And with the argument, the same pipe creates the owner, bound.
    const created = await runOnAPipe(
      ['--username', 'mamad', '--display-name', 'Mamad Owner', '--telegram-id', '4242'],
      'correcthorsebattery\n',
    );
    expect(created.output).toContain('Owner "mamad" created');
    expect(created.code).toBe(0);
    const rows = await adminRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.telegramUserId).toBe('4242');
  }, 120_000);

  it('answers a short password with one sentence and no stack trace', async () => {
    // The first staging attempt used fewer than twelve characters and got a
    // ZodError stack trace with `Too small: expected string to have >=12
    // characters` in it.
    // No confirmation entry: the password is refused before it is asked for.
    const run = await runOnATerminal(owner('mamad', 'Mamad Owner', 'short').slice(0, 4));

    expect(run.output).toContain('The owner password must be at least 12 characters long.');
    expect(run.output, 'the internal Zod wording reached the operator').not.toContain('Too small');
    expect(run.output, 'a short password printed a stack trace').not.toContain(
      'at Object.<anonymous>',
    );
    expect(run.output, 'the rejected password was echoed back').not.toContain('short');
    expect(run.exited, 'a rejected password left the CLI running').toBe(true);
    expect(run.code).not.toBe(0);
    expect(await adminRows()).toHaveLength(0);
  }, 90_000);
});
