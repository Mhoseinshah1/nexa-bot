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
let archive: string;
let fixtureArchive: string;
let panelMap: string;
let nexaEnv: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexa-rehearsal-guards-'));
  dump = join(dir, 'legacy.sql');
  writeFileSync(dump, '-- a dump\n');
  mkdirSync(join(dir, 'tests/fixtures/legacy'), { recursive: true });
  fixtureDump = join(dir, 'tests/fixtures/legacy/synthetic.sql');
  writeFileSync(fixtureDump, '-- synthetic\n');
  archive = join(dir, 'backup_2026-01-01.zip');
  writeFileSync(archive, 'PK\u0003\u0004');
  fixtureArchive = join(dir, 'tests/fixtures/legacy/backup_2026-01-01.zip');
  writeFileSync(fixtureArchive, 'PK\u0003\u0004');
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
    '--pg-url': 'postgres://nexa@127.0.0.1:5432',
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
    const { status, output } = run({ '--pg-url': 'postgres://nexa@postgres:5432' }, [
      '--check-only',
    ]);
    expect(status).toBe(1);
    expect(output).toContain("deployment's own service name");
    // Not merely "not loopback": allowing the host by name must not open it either.
    const allowed = run({ '--pg-url': 'postgres://nexa@postgres:5432' }, [
      '--check-only',
      '--allow-pg-host',
      'postgres',
    ]);
    expect(allowed.status).toBe(1);
    expect(allowed.output).toContain("deployment's own service name");
  });

  it('refuses a non-loopback server unless that exact host is allowed', () => {
    const remote = { '--pg-url': 'postgres://nexa@10.0.0.7:5432' };
    const refused = run(remote, ['--check-only']);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('not loopback');
    expect(run(remote, ['--check-only', '--allow-pg-host', '10.0.0.8']).status).toBe(1);
    expect(run(remote, ['--check-only', '--allow-pg-host', '10.0.0.7']).status).toBe(0);
  });

  it('refuses a password inside --pg-url: argv is world-readable; PGPASSWORD/PGPASSFILE carry it', () => {
    const { status, output } = run({ '--pg-url': 'postgres://nexa:secret@127.0.0.1:5432' }, [
      '--check-only',
    ]);
    expect(status).toBe(1);
    expect(output).toContain('PGPASSWORD');
    expect(output).not.toContain('secret');
  });

  it('refuses a server URL that names a database', () => {
    const { status, output } = run({ '--pg-url': 'postgres://nexa@127.0.0.1:5432/nexa' }, [
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

  describe('WP-D1b: the legacy archive and the legacy engine', () => {
    const zip = (extra: Record<string, string | null> = {}) => ({
      '--legacy-dump': null,
      '--legacy-archive': archive,
      ...extra,
    });

    it('takes a MirzaBot zip instead of a dump, with its password in the environment', () => {
      const { status, output } = run(
        zip(),
        ['--check-only', '--legacy-archive-password-env', 'LEGACY_ZIP_PASSWORD'],
        { LEGACY_ZIP_PASSWORD: 'zip-secret-for-the-test' },
      );
      expect(status).toBe(0);
      expect(output).toContain('--legacy-archive; inspected, then loaded into a throwaway mariadb');
      expect(output).not.toContain('zip-secret-for-the-test');
    });

    it('refuses both, and neither, of --legacy-dump and --legacy-archive', () => {
      const both = run({ '--legacy-archive': archive }, ['--check-only']);
      expect(both.status).toBe(1);
      expect(both.output).toContain('--legacy-dump OR --legacy-archive, not both');
      const neither = run({ '--legacy-dump': null }, ['--check-only']);
      expect(neither.status).toBe(1);
      expect(neither.output).toContain('--legacy-dump PATH or --legacy-archive PATH is required');
    });

    it('refuses a password on argv in any spelling, without echoing it', () => {
      for (const extra of [
        ['--legacy-archive-password', 'hunter2-argv'],
        ['--legacy-archive-password=hunter2-argv'],
        ['--password', 'hunter2-argv'],
      ]) {
        const { status, output } = run(zip(), ['--check-only', ...extra]);
        expect(status).toBe(1);
        expect(output).toContain('never accepted on the command line');
        expect(output).not.toContain('hunter2-argv');
      }
    });

    it('refuses an unset password variable, a malformed name, and one beside a plain dump', () => {
      const unset = run(zip(), ['--check-only', '--legacy-archive-password-env', 'NO_SUCH_VAR']);
      expect(unset.status).toBe(1);
      expect(unset.output).toContain('NO_SUCH_VAR: that environment variable is not set');
      const bad = run(zip(), ['--check-only', '--legacy-archive-password-env', 'lower-case']);
      expect(bad.status).toBe(1);
      expect(bad.output).toContain('must name an environment variable');
      const dumpToo = run({}, ['--check-only', '--legacy-archive-password-env', 'HOME']);
      expect(dumpToo.status).toBe(1);
      expect(dumpToo.output).toContain('a plain dump carries no password');
    });

    it('refuses to call a fixture ARCHIVE staging evidence', () => {
      const { status, output } = run(zip({ '--legacy-archive': fixtureArchive }), ['--check-only']);
      expect(status).toBe(1);
      expect(output).toContain('SYNTHETIC data');
      expect(
        run(zip({ '--legacy-archive': fixtureArchive, '--evidence-class': 'synthetic' }), [
          '--check-only',
        ]).status,
      ).toBe(0);
    });

    it('takes mariadb or mysql8 and nothing else; --mysql-bin-dir is for mysql8', () => {
      expect(run({}, ['--check-only', '--legacy-engine', 'mysql8']).status).toBe(0);
      const odd = run({}, ['--check-only', '--legacy-engine', 'mysql5']);
      expect(odd.status).toBe(1);
      expect(odd.output).toContain('--legacy-engine must be mariadb or mysql8');
      const binDir = run({}, ['--check-only', '--mysql-bin-dir', dir]);
      expect(binDir.status).toBe(1);
      expect(binDir.output).toContain('--mysql-bin-dir is for --legacy-engine mysql8');
    });
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
