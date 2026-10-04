import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Functions of `scripts/legacy-rehearsal.sh` lifted out and RUN, with no database: the
 * parts of the harness whose failure would turn a broken rehearsal into a green one.
 */
const ROOT = join(__dirname, '../..');
const SCRIPT = readFileSync(join(ROOT, 'scripts/legacy-rehearsal.sh'), 'utf8');
const SCHEMA = join(ROOT, 'docs/legacy-migration/final-report.schema.json');
const CHECKER = join(ROOT, 'scripts/legacy-rehearsal-report-check.mjs');

function lift(...names: string[]): string {
  return names
    .map((name) => {
      const found = new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm').exec(SCRIPT)?.[0];
      if (found === undefined) throw new Error(`scripts/legacy-rehearsal.sh defines no ${name}()`);
      return found;
    })
    .join('\n');
}

function bash(body: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-fn-'));
  const file = join(dir, 'harness.sh');
  writeFileSync(file, `set -euo pipefail\n${body}\n`);
  return spawnSync('bash', [file, ...args], { encoding: 'utf8', cwd: dir });
}

describe('report_schema_verdict: only a clean, zero-exit validation is valid', () => {
  const run = (schema: string, report: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-report-'));
    const out = join(dir, 'violations.txt');
    const result = bash(
      `REPORT_CHECK=${JSON.stringify(CHECKER)}\n${lift('report_schema_verdict')}\nreport_schema_verdict "$1" "$2" "$3"`,
      [schema, report, out],
    );
    return {
      verdict: result.stdout.trim(),
      detail: existsSync(out) ? readFileSync(out, 'utf8') : '',
    };
  };
  const dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-docs-'));

  it('calls a validator CRASH on an unsupported schema keyword invalid, with its stderr kept', () => {
    const schema = join(dir, 'bad-schema.json');
    writeFileSync(schema, JSON.stringify({ type: 'object', minProperties: 1 }));
    const report = join(dir, 'empty.json');
    writeFileSync(report, '{}');
    const { verdict, detail } = run(schema, report);
    expect(verdict).toMatch(/^invalid \(exit [1-9]/u);
    expect(detail).toContain('not supported');
  });

  it('calls a report that is not JSON invalid', () => {
    const report = join(dir, 'not-json.json');
    writeFileSync(report, 'report: oops\n');
    expect(run(SCHEMA, report).verdict).toMatch(/^invalid \(exit [1-9]/u);
  });

  it('calls a checker that dies SILENTLY invalid: the exit code decides, not the output', () => {
    const silent = join(dir, 'silent-crash.mjs');
    writeFileSync(silent, 'process.exit(7);\n');
    const out = join(dir, 'silent.txt');
    const result = bash(
      `REPORT_CHECK=${JSON.stringify(silent)}\n${lift('report_schema_verdict')}\nreport_schema_verdict "$1" "$2" "$3"`,
      [SCHEMA, join(dir, 'whatever.json'), out],
    );
    expect(result.stdout.trim()).toBe('invalid (exit 7)');
  });

  it('calls a report with violations invalid even though the checker exits for them', () => {
    const report = join(dir, 'violating.json');
    writeFileSync(report, '{}');
    expect(run(SCHEMA, report).verdict).toMatch(/^invalid/u);
  });
});

describe('progress_stopped: the interrupt proof cannot pass on missing progress', () => {
  const run = (before: string, after: string) =>
    bash(`${lift('progress_stopped')}\nprogress_stopped "$1" "$2"`, [before, after]).stdout.trim();

  it('is stopped only when both readings exist and agree', () => {
    expect(run('10/2026-10-04 07:22:58+00', '10/2026-10-04 07:22:58+00')).toBe('stopped');
    expect(run('10/2026-10-04 07:22:58+00', '12/2026-10-04 07:23:01+00')).toBe('still-writing');
  });

  it('refuses a NULL or absent reading', () => {
    expect(run('10/NULL', '10/NULL')).toBe('no-progress-recorded');
    expect(run('', '')).toBe('no-progress-recorded');
  });
});

describe('a stage killed by INT/TERM takes its whole process tree with it', () => {
  it('kills the grandchild a stage started when the harness is terminated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-kill-'));
    const pidFile = join(dir, 'grandchild.pid');
    const body = [
      `OUT=${JSON.stringify(dir)}`,
      'mkdir -p "$OUT/logs"',
      lift(
        'log',
        'die',
        'loadavg',
        'record_duration',
        'run_stage',
        'kill_stage_group',
        'on_signal',
      ),
      'STAGE_PGID=""',
      'trap on_signal INT TERM',
      // A stage whose real work is a grandchild, the shape of `importer` (subshells, then node).
      `tree() { ( sleep 300 & echo $! > ${JSON.stringify(pidFile)}; wait ) ; }`,
      'run_stage 1 sleepy tree',
    ].join('\n');
    const file = join(dir, 'harness.sh');
    writeFileSync(file, `set -euo pipefail\n${body}\n`);
    const child = spawn('bash', [file], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !existsSync(pidFile); i += 1)
      await new Promise((r) => setTimeout(r, 50));
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    let alive = true;
    for (let i = 0; i < 40 && alive; i += 1) {
      try {
        process.kill(grandchild, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(grandchild, 'SIGKILL');
    expect(alive, 'the stage left its grandchild running').toBe(false);
  }, 20_000);
});
