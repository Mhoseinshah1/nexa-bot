import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_REQUIRED_COLUMNS } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { REQUIRED_COLUMNS } from '../../scripts/legacy-archive-inspect.mjs';

/**
 * WP-D1a — `scripts/legacy-archive-inspect.mjs`, run as the operator runs it.
 *
 * The AES fixtures under tests/fixtures/legacy/archive/ were written by PHP's libzip
 * (`make-fixtures.php`), MirzaBot's own encoder, with a TEST-ONLY password — so the
 * decoder is checked against an encoder this repository did not write. MirzaBot's real
 * hardcoded password is not in this repository.
 */
const ROOT = join(__dirname, '../..');
const TOOL = join(ROOT, 'scripts/legacy-archive-inspect.mjs');
const FIXTURES = join(ROOT, 'tests/fixtures/legacy/archive');
const SYNTHETIC_SQL = join(ROOT, 'tests/fixtures/legacy/synthetic-legacy.sql');
const PASSWORD = 'nexa-synthetic-archive-test-only';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexa-archive-inspect-'));
});

interface Report {
  verdict: 'ACCEPTED' | 'BLOCKED';
  blockers: { code: string; detail: string }[];
  warnings: string[];
  archive: { sha256: string; container: string; name: string };
  zip: null | { entry: string; method: string; encryption: string; authenticated: boolean | null };
  dump: null | {
    sha256: string;
    format: string | null;
    synthetic: boolean;
    engine: string;
    serverVersion: string | null;
    complete: boolean | null;
    tables: string[];
    requiredTables: Record<string, { present: boolean; missingColumns: string[] }>;
    collations: string[];
    requiresMysql8: boolean;
    storedObjects: Record<string, number>;
    selectsDatabase: string[];
    insertStatements: Record<string, number>;
  };
  extracted: string | null;
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  let report: Report | null;
  try {
    report = JSON.parse(result.stdout) as Report;
  } catch {
    report = null;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

const withPassword = (archive: string, extra: string[] = []) =>
  run(['--archive', archive, '--password-env', 'LEGACY_ZIP_PASSWORD', ...extra], {
    LEGACY_ZIP_PASSWORD: PASSWORD,
  });

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const codes = (r: Report | null) => (r?.blockers ?? []).map((b) => b.code);

/** A file under the scratch dir with this content. */
function file(name: string, content: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const MIRZA_TABLES = `
CREATE TABLE \`user\` (
  \`id\` varchar(500) NOT NULL,
  \`limit_usertest\` varchar(32) DEFAULT NULL,
  \`Balance\` varchar(64) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=COLLATION_HERE;
INSERT INTO \`user\` VALUES ('1','1','0');
CREATE TABLE \`invoice\` (
  \`id_invoice\` varchar(200) NOT NULL,
  \`id_user\` varchar(200) DEFAULT NULL,
  \`username\` varchar(200) DEFAULT NULL,
  \`Status\` varchar(200) DEFAULT NULL,
  \`is_test\` varchar(200) DEFAULT NULL,
  \`code_panel\` varchar(200) DEFAULT NULL,
  \`code_product\` varchar(200) DEFAULT NULL,
  \`Volume\` varchar(200) DEFAULT NULL,
  \`Service_time\` varchar(200) DEFAULT NULL,
  \`time_unit\` varchar(200) DEFAULT NULL,
  \`is_custom\` varchar(200) DEFAULT NULL,
  \`price_product\` varchar(200) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=COLLATION_HERE;
INSERT INTO \`invoice\` VALUES ('a COLLATE=utf8mb4_0900_ai_ci inside DATA is never read','1','u','active','0','p','x','1','1','d','0','1');
CREATE TABLE \`product\` (
  \`id\` int NOT NULL,
  \`code_product\` varchar(200) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=COLLATION_HERE;
`;

function mysqldump(collation: string, server = '8.0.36-0ubuntu0.22.04.1', complete = true): string {
  return [
    `-- MySQL dump 10.13  Distrib ${server.split('-')[0]}, for Linux (x86_64)`,
    '--',
    '-- Host: localhost    Database: mirza',
    '-- ------------------------------------------------------',
    `-- Server version\t${server}`,
    '/*!40101 SET NAMES utf8mb4 */;',
    MIRZA_TABLES.replaceAll('COLLATION_HERE', collation),
    complete ? '-- Dump completed on 2026-01-01  0:00:01' : 'INSERT INTO `product` VALUES (1,',
    '',
  ].join('\n');
}

function pdoDump(collation: string, complete = true): string {
  return [
    'SET NAMES utf8mb4;',
    'SET FOREIGN_KEY_CHECKS=0;',
    "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';",
    '',
    MIRZA_TABLES.replaceAll('COLLATION_HERE', collation),
    complete ? 'SET FOREIGN_KEY_CHECKS=1;' : '',
    '',
  ].join('\n');
}

describe('the committed fixtures are what make-fixtures.php wrote', () => {
  // Pinned, so a fixture swapped for one this repository's own code wrote is visible in
  // review. Regenerating them (random AES salts) changes these values deliberately.
  const PINNED: Record<string, string> = {
    'backup_2026-01-01.zip': '6b90365bbd8ae0379464a8832a42c087389403cee78fd36bf30dfc4910d5b58c',
    'backup_2026-01-02.zip': '5597a035ac5158deb50645f929a05633df96972b61bd3e7b6aea702eb917e7f0',
    'backup_2026-01-03.zip': '5e4a21de412c49226b91461e1e3d993d07a758642224b06f5eb35c751457c028',
    'two-entries.zip': '5d768560cc6ce41fa266e20a76d99ced506368b3fce41b785f24331fed355519',
    'wrong-entry-name.zip': '49a623c3bb4c6ad622741cdcb32d695150980ffe72484c050b513c592530954a',
    'zipcrypto.zip': '0304b4b89127960dc1f296059efda061cc0271e14b159357930d2478fcaef2cf',
    'aes128.zip': '4799ea91a72ccd58964b6bcabf49cde75648e173c80254bd68f277eae49ce3bb',
  };

  it('pins every zip in the fixture directory', () => {
    const zips = readdirSync(FIXTURES).filter((f) => f.endsWith('.zip'));
    expect(zips.sort()).toEqual(Object.keys(PINNED).sort());
    for (const [name, hash] of Object.entries(PINNED)) {
      expect(sha256(readFileSync(join(FIXTURES, name))), name).toBe(hash);
    }
  });

  it('never carries the MirzaBot hardcoded password: only the test-only one', () => {
    const generator = readFileSync(join(FIXTURES, 'make-fixtures.php'), 'utf8');
    expect(generator).toContain(`const TEST_ONLY_PASSWORD = '${PASSWORD}';`);
    // The docblock's illustration, and the one call — with the test-only constant.
    expect(generator.match(/setEncryptionName\([^)]*\)/gu)).toEqual([
      "setEncryptionName('backup_Y-m-d.sql', ZipArchive::EM_AES_256, <password>)",
      'setEncryptionName($name, $encryption, TEST_ONLY_PASSWORD)',
    ]);
  });
});

describe('the required tables mirror the importer', () => {
  it('equals LEGACY_REQUIRED_COLUMNS exactly', () => {
    expect(REQUIRED_COLUMNS).toEqual(LEGACY_REQUIRED_COLUMNS);
  });
});

describe('AES-256 zip (the evidenced MirzaBot shape)', () => {
  it('decrypts, authenticates and hashes the deflated entry: the inner dump IS the synthetic fixture', () => {
    const { status, report } = withPassword(join(FIXTURES, 'backup_2026-01-01.zip'));
    expect(status).toBe(0);
    expect(report?.verdict).toBe('ACCEPTED');
    expect(report?.zip).toMatchObject({
      entry: 'backup_2026-01-01.sql',
      method: 'deflate',
      encryption: 'AES-256 AE-2',
      authenticated: true,
    });
    expect(report?.archive.sha256).toBe(
      sha256(readFileSync(join(FIXTURES, 'backup_2026-01-01.zip'))),
    );
    expect(report?.dump?.sha256).toBe(sha256(readFileSync(SYNTHETIC_SQL)));
    expect(report?.dump?.format).toBe('synthetic-fixture');
    expect(report?.dump?.synthetic).toBe(true);
    expect(Object.values(report?.dump?.requiredTables ?? {})).toEqual([
      { present: true, missingColumns: [] },
      { present: true, missingColumns: [] },
      { present: true, missingColumns: [] },
    ]);
  });

  it('decrypts a STORED AES entry too, and an unencrypted one', () => {
    for (const name of ['backup_2026-01-02.zip', 'backup_2026-01-03.zip']) {
      const { status, report } = withPassword(join(FIXTURES, name));
      expect(status, name).toBe(0);
      expect(report?.dump?.sha256, name).toBe(sha256(readFileSync(SYNTHETIC_SQL)));
    }
    expect(withPassword(join(FIXTURES, 'backup_2026-01-02.zip')).report?.zip?.method).toBe('store');
    expect(withPassword(join(FIXTURES, 'backup_2026-01-03.zip')).report?.zip?.encryption).toBe(
      'none',
    );
  });

  it('extracts to a 0600 file in a 0700 directory, byte for byte', () => {
    const out = join(dir, 'extract-ok');
    const { status, report } = withPassword(join(FIXTURES, 'backup_2026-01-01.zip'), [
      '--out',
      out,
      '--extract',
    ]);
    expect(status).toBe(0);
    const extracted = join(out, 'backup_2026-01-01.sql');
    expect(report?.extracted).toBe(extracted);
    expect(readFileSync(extracted).equals(readFileSync(SYNTHETIC_SQL))).toBe(true);
    expect(statSync(extracted).mode & 0o777).toBe(0o600);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(out, 'archive.json'), 'utf8'))).toEqual(report);
  });

  it('refuses the wrong password, and needs one for an encrypted entry', () => {
    const wrong = run(
      ['--archive', join(FIXTURES, 'backup_2026-01-01.zip'), '--password-env', 'P'],
      { P: 'not-the-password' },
    );
    expect(wrong.status).toBe(2);
    expect(codes(wrong.report)).toEqual(['WRONG_PASSWORD']);
    expect(wrong.stdout).not.toContain('not-the-password');
    const none = run(['--archive', join(FIXTURES, 'backup_2026-01-01.zip')]);
    expect(none.status).toBe(2);
    expect(codes(none.report)).toEqual(['PASSWORD_REQUIRED']);
  });

  it('refuses a damaged ciphertext by its HMAC, and leaves no extracted file behind', () => {
    const bytes = Buffer.from(readFileSync(join(FIXTURES, 'backup_2026-01-02.zip')));
    // Inside the stored entry's ciphertext (well past the 30-byte header, salt and
    // verifier): the inflate cannot fail on stored data, so only the HMAC can catch it.
    bytes[400] = (bytes[400] ?? 0) ^ 0x01;
    const damaged = file('backup_2026-01-09.zip', bytes);
    const out = join(dir, 'extract-damaged');
    const { status, report } = withPassword(damaged, ['--out', out, '--extract']);
    expect(status).toBe(2);
    expect(codes(report)).toEqual(['AUTHENTICATION_FAILED']);
    expect(report?.extracted).toBeNull();
    expect(readdirSync(out)).toEqual(['archive.json']);
  });

  it('refuses a truncated archive and a file that is not a zip at all', () => {
    const bytes = readFileSync(join(FIXTURES, 'backup_2026-01-01.zip'));
    const truncated = file('backup_2026-01-08.zip', bytes.subarray(0, bytes.length - 40));
    expect(codes(withPassword(truncated).report)).toEqual(['ZIP_TRUNCATED']);
    const notZip = file('backup_2026-01-07.zip', 'PK\u0003\u0004 but nothing else');
    expect(codes(withPassword(notZip).report)).toEqual(['ZIP_TRUNCATED']);
  });

  it.each([
    ['two-entries.zip', 'ZIP_ENTRY_COUNT'],
    ['wrong-entry-name.zip', 'ZIP_ENTRY_NAME'],
    ['zipcrypto.zip', 'ZIP_ENCRYPTION_UNSUPPORTED'],
    ['aes128.zip', 'ZIP_ENCRYPTION_UNSUPPORTED'],
  ])('refuses %s (%s): not a shape MirzaBot produces', (name, code) => {
    const { status, report } = withPassword(join(FIXTURES, name));
    expect(status).toBe(2);
    expect(codes(report)).toEqual([code]);
    expect(report?.dump).toBeNull();
  });
});

describe('the password travels only through the environment', () => {
  it('refuses --password and --password=…, before reading anything', () => {
    for (const args of [['--password', PASSWORD], [`--password=${PASSWORD}`]]) {
      const result = run(['--archive', join(FIXTURES, 'backup_2026-01-01.zip'), ...args]);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('never accepted on the command line');
      expect(result.stdout).toBe('');
    }
  });

  it('refuses a password that ALSO appears on argv, without repeating it', () => {
    const result = run(
      [
        '--archive',
        join(FIXTURES, 'backup_2026-01-01.zip'),
        '--password-env',
        'P',
        '--out',
        PASSWORD,
      ],
      { P: PASSWORD },
    );
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('also appears on the command line');
    expect(result.stderr).not.toContain(PASSWORD);
  });

  it('refuses an unset or empty variable precisely', () => {
    const result = run([
      '--archive',
      join(FIXTURES, 'backup_2026-01-01.zip'),
      '--password-env',
      'NOPE',
    ]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('NOPE: that environment variable is not set or is empty');
  });

  it('never prints the password, accepted or not', () => {
    const ok = withPassword(join(FIXTURES, 'backup_2026-01-01.zip'), ['--out', join(dir, 'pw')]);
    expect(ok.stdout + ok.stderr).not.toContain(PASSWORD);
    expect(readFileSync(join(dir, 'pw', 'archive.json'), 'utf8')).not.toContain(PASSWORD);
  });
});

describe('plain and gzipped dumps', () => {
  it('reads a MySQL 8 mysqldump: header, server version, engine, collations, completeness', () => {
    const path = file('mysql8.sql', mysqldump('utf8mb4_0900_ai_ci'));
    const { status, report } = run(['--archive', path]);
    expect(status).toBe(0);
    expect(report?.dump).toMatchObject({
      format: 'mysqldump',
      serverVersion: '8.0.36-0ubuntu0.22.04.1',
      engine: 'mysql',
      complete: true,
      synthetic: false,
      collations: ['utf8mb4_0900_ai_ci'],
      requiresMysql8: true,
      insertStatements: { invoice: 1, user: 1 },
    });
    // The archive of a plain dump IS the dump.
    expect(report?.dump?.sha256).toBe(report?.archive.sha256);
  });

  it('never scans row data: a COLLATE inside an INSERT is not a collation', () => {
    const path = file('mariadb.sql', mysqldump('utf8mb4_general_ci', '10.11.14-MariaDB'));
    expect(run(['--archive', path]).report?.dump?.collations).toEqual(['utf8mb4_general_ci']);
  });

  it('reads MirzaBot PDO-fallback output by its exact header and end marker', () => {
    const { status, report } = run(['--archive', file('pdo.sql', pdoDump('utf8mb4_0900_ai_ci'))]);
    expect(status).toBe(0);
    expect(report?.dump).toMatchObject({
      format: 'mirza-pdo-fallback',
      serverVersion: null,
      engine: 'mysql',
      complete: true,
    });
  });

  it('hashes the DECOMPRESSED dump of a .sql.gz', () => {
    const sql = mysqldump('utf8mb4_general_ci', '10.11.14-MariaDB');
    const path = file('dump.sql.gz', gzipSync(sql));
    const { status, report } = run(['--archive', path]);
    expect(status).toBe(0);
    expect(report?.archive.container).toBe('gzip');
    expect(report?.dump?.sha256).toBe(sha256(sql));
    expect(report?.archive.sha256).not.toBe(report?.dump?.sha256);
  });

  it('refuses a truncated dump of either writer', () => {
    expect(
      codes(run(['--archive', file('cut.sql', mysqldump('x_ci', '8.0.36', false))]).report),
    ).toContain('DUMP_INCOMPLETE');
    expect(codes(run(['--archive', file('cutpdo.sql', pdoDump('x_ci', false))]).report)).toContain(
      'DUMP_INCOMPLETE',
    );
  });

  it('refuses an unrecognised header, a missing table and a missing required column', () => {
    expect(codes(run(['--archive', file('odd.sql', 'CREATE TABLE x (a int);\n')]).report)).toEqual(
      expect.arrayContaining(['DUMP_HEADER_UNRECOGNISED', 'REQUIRED_TABLE_MISSING']),
    );
    const noBalance = mysqldump('utf8mb4_general_ci', '10.11.14-MariaDB').replace(
      '  `Balance` varchar(64) DEFAULT NULL,\n',
      '',
    );
    const r = run(['--archive', file('nobalance.sql', noBalance)]).report;
    expect(codes(r)).toEqual(['REQUIRED_COLUMN_MISSING']);
    expect(r?.blockers[0]?.detail).toContain('`Balance`');
  });

  it('refuses stored programs and DEFINER clauses: MirzaBot has none', () => {
    const view = mysqldump('utf8mb4_general_ci', '10.11.14-MariaDB').replace(
      '-- Dump completed',
      '/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */\n/*!50001 VIEW `v` AS select 1 */;\n-- Dump completed',
    );
    const r = run(['--archive', file('view.sql', view)]).report;
    expect(codes(r)).toEqual(['STORED_OBJECTS_PRESENT']);
    expect(r?.dump?.storedObjects).toEqual({ VIEW: 1 });
  });

  it('reports a USE statement, and refuses two', () => {
    const one = mysqldump('utf8mb4_general_ci', '10.11.14-MariaDB').replace(
      '/*!40101',
      'USE `mirza`;\n/*!40101',
    );
    expect(run(['--archive', file('use.sql', one)]).report?.dump?.selectsDatabase).toEqual([
      'mirza',
    ]);
    const two = one.replace('/*!40101', 'USE `other`;\n/*!40101');
    expect(codes(run(['--archive', file('use2.sql', two)]).report)).toEqual(['MULTIPLE_DATABASES']);
  });

  it('refuses a file whose name does not match its content', () => {
    const path = file('dump.zip', mysqldump('utf8mb4_general_ci', '10.11.14-MariaDB'));
    expect(codes(run(['--archive', path]).report)).toEqual(['EXTENSION_MISMATCH']);
  });
});

describe('--engine: the collation decides the engine; nothing is rewritten', () => {
  it('refuses a utf8mb4_0900 dump on MariaDB, precisely, and accepts it on MySQL 8', () => {
    const path = file('m8.sql', mysqldump('utf8mb4_0900_ai_ci'));
    const maria = run(['--archive', path, '--engine', 'mariadb']);
    expect(maria.status).toBe(2);
    expect(codes(maria.report)).toEqual(['COLLATION_REQUIRES_MYSQL8']);
    expect(maria.report?.blockers[0]?.detail).toContain('never rewrite the collation');
    expect(run(['--archive', path, '--engine', 'mysql8']).status).toBe(0);
  });

  it('refuses a MySQL 8 server dump on MariaDB even with portable collations', () => {
    const path = file('m8gen.sql', mysqldump('utf8mb4_general_ci'));
    expect(codes(run(['--archive', path, '--engine', 'mariadb']).report)).toEqual([
      'ENGINE_MISMATCH',
    ]);
  });

  it('refuses a MariaDB dump on MySQL 8', () => {
    const path = file('mdb.sql', mysqldump('utf8mb4_general_ci', '10.11.14-MariaDB'));
    expect(run(['--archive', path, '--engine', 'mariadb']).status).toBe(0);
    expect(codes(run(['--archive', path, '--engine', 'mysql8']).report)).toEqual([
      'ENGINE_MISMATCH',
    ]);
  });
});

describe('--require-class', () => {
  it('refuses the synthetic fixture as staging, wherever it was copied to', () => {
    const copy = join(dir, 'backup_2026-02-02.zip');
    copyFileSync(join(FIXTURES, 'backup_2026-01-01.zip'), copy);
    const { status, report } = withPassword(copy, ['--require-class', 'staging']);
    expect(status).toBe(2);
    expect(codes(report)).toEqual(['SYNTHETIC_AS_STAGING']);
    expect(withPassword(copy, ['--require-class', 'synthetic']).status).toBe(0);
  });

  it('refuses a real-looking dump as synthetic', () => {
    const path = file('real.sql', mysqldump('utf8mb4_general_ci', '10.11.14-MariaDB'));
    expect(codes(run(['--archive', path, '--require-class', 'synthetic']).report)).toEqual([
      'NOT_SYNTHETIC',
    ]);
  });
});

describe('usage', () => {
  it('refuses an existing --out, an unknown flag, and --extract without --out', () => {
    const archive = join(FIXTURES, 'backup_2026-01-03.zip');
    expect(run(['--archive', archive, '--out', dir]).status).toBe(64);
    expect(run(['--archive', archive, '--bogus']).status).toBe(64);
    expect(run(['--archive', archive, '--extract']).status).toBe(64);
    expect(existsSync(join(dir, 'archive.json'))).toBe(false);
  });
});
