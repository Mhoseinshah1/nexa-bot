import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The rehearsal harness's refusals (`scripts/legacy-rehearsal.sh`, Item 11).
 *
 * The harness restores customer data, starts a database and renames databases, so the
 * part that must never regress is what it REFUSES to point at. Every guard runs before
 * anything is touched, which is what lets this run them for real — `--check-only` stops
 * after the guards, and a refusal exits before any tool is looked up — with no
 * PostgreSQL, MariaDB or importer present.
 */
const SCRIPT = join(__dirname, '../../scripts/legacy-rehearsal.sh');

let dir: string;
let dump: string;
let fixtureDump: string;
let panelMap: string;
let nexaEnv: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-guards-'));
  dump = join(dir, 'legacy.sql');
  writeFileSync(dump, '-- a dump\n');
  mkdirSync(join(dir, 'tests/fixtures/legacy'), { recursive: true });
  fixtureDump = join(dir, 'tests/fixtures/legacy/synthetic.sql');
  writeFileSync(fixtureDump, '-- synthetic\n');
  panelMap = join(dir, 'panel-map.json');
  writeFileSync(panelMap, '{}\n');
  nexaEnv = join(dir, 'nexa.env');
  writeFileSync(nexaEnv, 'REDIS_URL=redis://127.0.0.1:6379\n');
});

function run(
  overrides: Record<string, string | null>,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  const base: Record<string, string | null> = {
    '--evidence-class': 'staging',
    '--legacy-dump': dump,
    '--tenant': 'nexa',
    '--panel-map': panelMap,
    '--nexa-env': nexaEnv,
    '--pg-url': 'postgres://nexa:nexa@127.0.0.1:5432',
    '--out': join(dir, `out-${Math.random().toString(16).slice(2)}`),
    '--fresh-migrate': '',
    ...overrides,
  };
  const args: string[] = [];
  for (const [flag, value] of Object.entries(base)) {
    if (value === null) continue;
    args.push(flag);
    if (value !== '') args.push(value);
  }
  const result = spawnSync('bash', [SCRIPT, ...args, ...extra], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('legacy-rehearsal.sh guards', () => {
  it('passes its guards for an isolated, loopback, explicitly-classed run', () => {
    const { status, output } = run({}, ['--check-only']);
    expect(output).toContain('guards passed');
    expect(status).toBe(0);
  });

  it('labels a synthetic run as never being evidence', () => {
    const { status, output } = run(
      { '--evidence-class': 'synthetic', '--legacy-dump': fixtureDump },
      ['--check-only'],
    );
    expect(status).toBe(0);
    expect(output).toContain('NOT legacy evidence');
  });

  it('refuses to run without an evidence class', () => {
    const { status, output } = run({ '--evidence-class': null }, ['--check-only']);
    expect(status).toBe(1);
    expect(output).toContain('--evidence-class is required');
  });

  it('refuses to call a fixture dump staging evidence', () => {
    const { status, output } = run({ '--legacy-dump': fixtureDump }, ['--check-only']);
    expect(status).toBe(1);
    expect(output).toContain('SYNTHETIC data');
  });

  it("refuses a deployment's own database service name", () => {
    const { status, output } = run({ '--pg-url': 'postgres://nexa:x@postgres:5432' }, [
      '--check-only',
    ]);
    expect(status).toBe(1);
    expect(output).toContain("deployment's own service name");
    // Not merely "not loopback": allowing the host by name must not open it either.
    const allowed = run({ '--pg-url': 'postgres://nexa:x@postgres:5432' }, [
      '--check-only',
      '--allow-pg-host',
      'postgres',
    ]);
    expect(allowed.status).toBe(1);
    expect(allowed.output).toContain("deployment's own service name");
  });

  it('refuses a non-loopback server unless that exact host is allowed', () => {
    const remote = { '--pg-url': 'postgres://nexa:x@10.0.0.7:5432' };
    const refused = run(remote, ['--check-only']);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('not loopback');
    expect(run(remote, ['--check-only', '--allow-pg-host', '10.0.0.8']).status).toBe(1);
    expect(run(remote, ['--check-only', '--allow-pg-host', '10.0.0.7']).status).toBe(0);
  });

  it('refuses a server URL that names a database', () => {
    const { status, output } = run({ '--pg-url': 'postgres://nexa:x@127.0.0.1:5432/nexa' }, [
      '--check-only',
    ]);
    expect(status).toBe(1);
    expect(output).toContain('no database path');
  });

  it('refuses any importer argument that names production', () => {
    const { status, output } = run({}, ['--check-only', '--importer-arg', '--allow-PRODUCTION']);
    expect(status).toBe(1);
    expect(output).toContain('never passes the P7 production guard');
  });

  it('refuses to run in a production environment', () => {
    const { status, output } = run({}, ['--check-only'], { NODE_ENV: 'production' });
    expect(status).toBe(1);
    expect(output).toContain('NODE_ENV=production');
  });

  it('refuses both and neither of the two NEXA sources', () => {
    expect(run({ '--nexa-archive': dump }, ['--check-only']).output).toContain('not both');
    expect(run({ '--fresh-migrate': null }, ['--check-only']).output).toContain(
      '--nexa-archive PATH',
    );
  });

  it('stands up fake panels for a synthetic run only, and never beside a real panel map', () => {
    const staging = run({ '--panel-map': null }, ['--check-only', '--synthetic-panels']);
    expect(staging.status).toBe(1);
    expect(staging.output).toContain('synthetic only');
    const both = run({ '--evidence-class': 'synthetic', '--legacy-dump': fixtureDump }, [
      '--check-only',
      '--synthetic-panels',
    ]);
    expect(both.status).toBe(1);
    expect(both.output).toContain('do not also pass --panel-map');
    const ok = run(
      { '--evidence-class': 'synthetic', '--legacy-dump': fixtureDump, '--panel-map': null },
      ['--check-only', '--synthetic-panels'],
    );
    expect(ok.status).toBe(0);
  });

  it("refuses P7's own production override as an importer argument", () => {
    const { status, output } = run({}, [
      '--check-only',
      '--importer-arg',
      '--allow-production-target',
    ]);
    expect(status).toBe(1);
    expect(output).toContain('never passes the P7 production guard');
  });

  it('refuses an output directory that already exists', () => {
    const { status, output } = run({ '--out': dir }, ['--check-only']);
    expect(status).toBe(1);
    expect(output).toContain('already exists');
  });

  it('fails precisely, before touching anything, when the P7 CLI is absent', () => {
    const out = join(dir, 'out-no-cli');
    const { status, output } = run({ '--out': out }, [], {
      LEGACY_IMPORT_CLI: join(dir, 'no-such-legacy-import.cli.js'),
    });
    expect(status).toBe(1);
    expect(output).toContain('the P7 importer CLI is not at');
    expect(output).toContain('wp4/p7-importer');
  });
});
