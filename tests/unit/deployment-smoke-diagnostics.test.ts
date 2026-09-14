import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The smoke test's failure path — the part that decides whether a CI failure is
 * READABLE.
 *
 * This exists because the Telegram bootstrap step failed in CI twice, and both
 * times the reason was thrown away. Each assertion said "(see
 * /tmp/tmp.XXXX/bootstrap-bot.log)", and the EXIT trap removes that directory
 * before anyone can read it. Two different defects therefore presented as the
 * same opaque line, and the second was diagnosed by reasoning about the image's
 * uid rather than by reading what the container said.
 *
 * `dump_log` is the fix, and it carries a rule of its own: it prints a log the
 * smoke test has NOT yet proved credential-free, because the outcome assertion
 * runs before the leak assertion. So it redacts. That rule is what is tested
 * here — by running the function, not by reading it.
 */
describe('the deployment smoke test dumps what it names', () => {
  const script = readFileSync(join(__dirname, '../../scripts/deployment-smoke.sh'), 'utf8');

  /** `dump_log` lifted out of the script and run for real, with no Docker. */
  const dumpLog = (contents: string, token: string | null): string => {
    const definition = /^dump_log\(\)\s*\{[\s\S]*?\n\}/m.exec(script)?.[0];
    expect(definition, 'scripts/deployment-smoke.sh no longer defines dump_log').toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'nexa-dump-log-'));
    const logPath = join(dir, 'bootstrap-bot.log');
    writeFileSync(logPath, contents);
    const harness = join(dir, 'harness.sh');
    writeFileSync(
      harness,
      `set -euo pipefail\n${token === null ? '' : `SMOKE_BOT_TOKEN=${JSON.stringify(token)}\n`}${definition}\ndump_log "$1"\n`,
    );
    return execFileSync('bash', [harness, logPath], { encoding: 'utf8' });
  };

  it('redacts the bot token out of a log it has not yet proved safe', () => {
    // The ordering that makes this load-bearing: the outcome assertion dumps
    // the log, and the assertion that the CLI never printed the token runs
    // AFTER it. Without the redaction, the diagnostic for one failure would
    // publish the credential the next assertion exists to catch.
    const token = '8123456789:AA-smoke-token-that-belongs-to-nobody';
    const output = dumpLog(
      `about to call getMe with ${token}\ntelegram.bootstrap_unreachable\n`,
      token,
    );
    expect(output).not.toContain(token);
    expect(output).toContain('<redacted>');
    // Redaction, not suppression: the rest of the log is why it is dumped.
    expect(output).toContain('telegram.bootstrap_unreachable');
  });

  it('prints the log when no token has been written yet', () => {
    // `dump_log` is reachable from the owner-terminal assertions, which run
    // before `SMOKE_BOT_TOKEN` exists. Under `set -u` an unset variable would
    // abort the failure path itself, turning a readable failure into a
    // different, less readable one.
    const output = dumpLog('bootstrap.already_completed\n', null);
    expect(output).toContain('bootstrap.already_completed');
  });

  it('says so when the log it was asked for does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-dump-log-'));
    const definition = /^dump_log\(\)\s*\{[\s\S]*?\n\}/m.exec(script)?.[0] ?? '';
    const harness = join(dir, 'harness.sh');
    writeFileSync(harness, `set -euo pipefail\n${definition}\ndump_log "$1"\n`);
    const output = execFileSync('bash', [harness, join(dir, 'absent.log')], { encoding: 'utf8' });
    expect(output).toContain('no such file');
  });

  it('never names a log file it does not also dump', () => {
    /*
     * The defect itself, as a rule: a failure message that tells a reader to
     * look at a path is useless when the path is inside the directory the EXIT
     * trap removes. The fix was to pass the file to `fail` instead, and this
     * keeps the old shape from coming back — including in a future step that
     * writes its own log.
     */
    const offenders = [...script.matchAll(/^\s*fail\s+"[^"]*\(see\b[^"]*"/gm)].map((m) => m[0]);
    expect(offenders, 'a failure names a log path instead of dumping it').toEqual([]);
  });
});
