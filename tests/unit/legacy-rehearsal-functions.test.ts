import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

describe('classify_apply_verdict: an import that left work undone never passes', () => {
  const run = (verdict: string) =>
    bash(`${lift('classify_apply_verdict')}\nclassify_apply_verdict "$1"`, [verdict]).stdout.trim();

  it('passes only COMPLETED', () => {
    expect(run('COMPLETED')).toBe('pass');
  });

  it('fails COMPLETED_WITH_FAILURES (money, a trial or a service left undone)', () => {
    expect(run('COMPLETED_WITH_FAILURES')).toBe('fail');
  });

  it('marks an importer without P6 pending, and anything unknown or absent a failure', () => {
    expect(run('COMPLETED_ADOPTION_PENDING_P6')).toBe('pending');
    expect(run('absent')).toBe('fail');
    expect(run('COMPLETED_SOMEHOW')).toBe('fail');
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

describe('mysql8_server_version_ok: --legacy-engine mysql8 is MySQL 8.0, never MariaDB', () => {
  const ok = (version: string) =>
    bash(
      `${lift('mysql8_server_version_ok')}\nmysql8_server_version_ok "$1" && echo yes || echo no`,
      [version],
    ).stdout.trim();

  it('accepts MySQL 8.0 builds', () => {
    expect(ok('/usr/sbin/mysqld  Ver 8.0.46-0ubuntu0.24.04.4 for Linux on x86_64 ((Ubuntu))')).toBe(
      'yes',
    );
    expect(ok('mysqld  Ver 8.0.36 for Linux on x86_64 (MySQL Community Server - GPL)')).toBe('yes');
  });

  it("refuses MariaDB's mysqld symlink and any other major", () => {
    expect(
      ok(
        'mysqld  Ver 10.11.14-MariaDB-0ubuntu0.24.04.1 for debian-linux-gnu on x86_64 (Ubuntu 24.04)',
      ),
    ).toBe('no');
    expect(ok('mysqld  Ver 5.7.44 for Linux on x86_64')).toBe('no');
    expect(ok('mysqld  Ver 8.4.2 for Linux on x86_64')).toBe('no');
    expect(ok('')).toBe('no');
  });
});

describe('inspect_legacy: the archive inspector gates the load (WP-D1b)', () => {
  const INSPECT = join(ROOT, 'scripts/legacy-archive-inspect.mjs');
  const FIXTURE_ZIP = join(ROOT, 'tests/fixtures/legacy/archive/backup_2026-01-01.zip');
  const SYNTHETIC = join(ROOT, 'tests/fixtures/legacy/synthetic-legacy.sql');

  function inspect(vars: Record<string, string>, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-inspect-'));
    const assign = Object.entries({
      OUT: dir,
      MDB_RUN: join(dir, 'run'),
      ARCHIVE_INSPECT: INSPECT,
      REPORT_CHECK: CHECKER,
      LEGACY_ARCHIVE: '',
      LEGACY_ARCHIVE_PASSWORD_ENV: '',
      LEGACY_ENGINE: 'mariadb',
      EVIDENCE_CLASS: 'synthetic',
      LEGACY_SCHEMA: 'oldbot',
      ...vars,
    })
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join('\n');
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\n${assign}\nmkdir -p "$OUT/snapshots" "$MDB_RUN"\n${lift('die', 'json_get', 'inspect_legacy')}\ninspect_legacy\necho "LOAD=$LEGACY_LOAD_FILE"`,
      ],
      { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env } },
    );
    return { ...result, dir };
  }

  it('decrypts the zip into the private run directory, never into --out, and records both hashes', () => {
    const r = inspect(
      {
        LEGACY_INPUT: FIXTURE_ZIP,
        LEGACY_ARCHIVE: FIXTURE_ZIP,
        LEGACY_ARCHIVE_PASSWORD_ENV: 'LEGACY_ZIP_PASSWORD',
      },
      { LEGACY_ZIP_PASSWORD: 'nexa-synthetic-archive-test-only' },
    );
    expect(r.status).toBe(0);
    const load = /LOAD=(.*)/u.exec(r.stdout)?.[1] ?? '';
    expect(load.startsWith(join(r.dir, 'run', 'inspect'))).toBe(true);
    expect(readFileSync(load).equals(readFileSync(SYNTHETIC))).toBe(true);
    expect(readFileSync(join(r.dir, 'snapshots/legacy-archive.sha256'), 'utf8').trim()).toBe(
      createHash('sha256').update(readFileSync(FIXTURE_ZIP)).digest('hex'),
    );
    expect(readFileSync(join(r.dir, 'snapshots/legacy-dump.sha256'), 'utf8').trim()).toBe(
      createHash('sha256').update(readFileSync(SYNTHETIC)).digest('hex'),
    );
  });

  it('refuses a utf8mb4_0900 dump on mariadb with the precise blocker, before any load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-0900-'));
    const dump = join(dir, 'mysql8.sql');
    writeFileSync(
      dump,
      readFileSync(SYNTHETIC, 'utf8').replaceAll(
        'COLLATE=utf8mb4_bin',
        'COLLATE=utf8mb4_0900_ai_ci',
      ),
    );
    const r = inspect({ LEGACY_INPUT: dump });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BLOCKED by the archive inspector: COLLATION_REQUIRES_MYSQL8');
    expect(r.stdout).not.toContain('LOAD=');
    // The same dump is accepted for the engine it needs.
    expect(inspect({ LEGACY_INPUT: dump, LEGACY_ENGINE: 'mysql8' }).status).toBe(0);
  });

  it('refuses a dump that selects another database than --legacy-schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-use-'));
    const dump = join(dir, 'use.sql');
    writeFileSync(
      dump,
      readFileSync(SYNTHETIC, 'utf8').replace('DROP TABLE', 'USE `mirza`;\nDROP TABLE'),
    );
    const r = inspect({ LEGACY_INPUT: dump });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pass --legacy-schema mirza');
  });
});
