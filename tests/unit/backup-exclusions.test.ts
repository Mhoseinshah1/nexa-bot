import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_TABLE_DATA_EXCLUSIONS,
  excludeTableDataArgs,
  manifestExclusions,
} from '../../apps/api/src/modules/platform/backup/infrastructure/backup-exclusions';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';

/**
 * v0.9.7 PR-2: what a backup leaves out, and where it verifies.
 *
 * The list is CLOSED and held here by name: a table joins it only with a reason a restorer can
 * read, and the tables whose rows are work, dedupe, money or evidence can never be on it.
 * `tests/integration/backup.test.ts` restores a real archive and compares the catalogs.
 */

const SCHEMA = readFileSync(
  join(__dirname, '../../apps/api/src/infrastructure/persistence/schema.ts'),
  'utf8',
);

describe('the backup table-data exclusions', () => {
  it('are exactly the closed list, each with a reason', () => {
    expect(BACKUP_TABLE_DATA_EXCLUSIONS.map((entry) => entry.table)).toEqual([
      'admin_login_throttle',
      'panel_probe_claims',
    ]);
    for (const entry of BACKUP_TABLE_DATA_EXCLUSIONS) {
      expect(entry.reason.length, entry.table).toBeGreaterThan(40);
      // A real table of this schema, by its declared name.
      expect(SCHEMA, `${entry.table} is not a table`).toMatch(
        new RegExp(`pgTable\\(\\s*'${entry.table}',`),
      );
    }
  });

  it('never name a table whose rows are work, dedupe, money or evidence', () => {
    const listed = new Set(BACKUP_TABLE_DATA_EXCLUSIONS.map((entry) => entry.table));
    for (const table of [
      // ADR-0025's own example: looks like a cache, stops a duplicated effect.
      'processed_messages',
      // Unpublished messages are work; job and importer keys are re-run safety.
      'outbox_messages',
      'request_idempotency',
      // The dispatcher's invariant (a finished intent has its attempt) and its guard.
      'notification_delivery_attempts',
      'notification_released_claims',
      'notifications',
      'customer_notifications',
      'audit_logs',
      'operational_events',
      'wallet_entries',
      'payments',
      'orders',
      'refunds',
      'services',
      'payment_receipts',
      'panel_probe_budgets',
      'miniapp_sessions',
      'admin_sessions',
      'aggregate_sequences',
    ]) {
      expect(listed.has(table), `${table} must never lose its data in a backup`).toBe(false);
    }
  });

  it('become one schema-qualified --exclude-table-data each, and the manifest names each one', () => {
    expect(excludeTableDataArgs()).toEqual([
      '--exclude-table-data=public.admin_login_throttle',
      '--exclude-table-data=public.panel_probe_claims',
    ]);
    expect(manifestExclusions().map((entry) => entry.object)).toEqual([
      'table data: public.admin_login_throttle',
      'table data: public.panel_probe_claims',
    ]);
  });
});

describe('the PostgreSQL tools with fake binaries', () => {
  let dir: string;
  let log: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-pgtools-'));
    log = join(dir, 'calls.log');
    // Every tool records its own name, the server it was pointed at and its argv.
    const record = `printf '%s %s:%s %s\\n' "$(basename "$0")" "$PGHOST" "$PGPORT" "$*" >> "${log}"`;
    const tool = async (name: string, body: string) => {
      await writeFile(join(dir, name), `#!/bin/bash\n${record}\n${body}\n`);
      await chmod(join(dir, name), 0o755);
    };
    await tool(
      'pg_dump',
      'if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.1"; exit 0; fi\n' +
        'while [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then printf PGDMP > "$2"; fi; shift; done',
    );
    await tool('pg_restore', 'exit 0');
    // The emptiness check and the table count read a number; the migration probe a word.
    await tool('psql', 'case "$*" in *to_regclass*) echo ABSENT ;; *count*) echo 0 ;; esac');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tools = (verifyServer?: { host: string; port: string }) =>
    new PostgresDatabaseTools({
      databaseUrl: 'postgres://nexa:secret@live-db:5432/nexa',
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
      binDir: dir,
      migratorEntrypoint: '/nonexistent',
      lowPriorityPrefix: [],
      verifyServer,
    });

  const calls = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const [tool = '', server = '', ...args] = line.split(' ');
        return { tool, server, args: args.join(' ') };
      });

  it('dumps every table schema and leaves out only the listed data, and says so', async () => {
    const outcome = await tools().dump(join(dir, 'out.dump'), { uncompressed: true });
    expect(outcome.exclusions).toEqual(manifestExclusions());
    const dump = (await calls()).find(
      (call) => call.tool === 'pg_dump' && call.args !== '--version',
    );
    expect(dump?.server).toBe('live-db:5432');
    for (const arg of excludeTableDataArgs()) expect(dump?.args).toContain(arg);
    // Never a whole table and never a schema filter: the restored schema is complete.
    expect(dump?.args).not.toMatch(/--exclude-table[= ]/);
    expect(dump?.args).not.toMatch(/--exclude-schema|--schema|--table[= ]|-T |-t |-N |-n /);
    expect(dump?.args.match(/--exclude-table-data=/g)?.length).toBe(
      BACKUP_TABLE_DATA_EXCLUSIONS.length,
    );
  });

  it('verifies on the dedicated server when one is named, and only the verification moves', async () => {
    const dedicated = tools({ host: 'backup-verify', port: '5432' });
    expect(dedicated.verifiesOnDedicatedServer).toBe(true);
    const outcome = await dedicated.verifyRestore(join(dir, 'x.dump'));
    expect(outcome.ok).toBe(true);
    const verify = await calls();
    expect(verify.map((call) => call.tool)).toEqual(expect.arrayContaining(['psql', 'pg_restore']));
    for (const call of verify)
      expect(call.server, `${call.tool} ${call.args}`).toBe('backup-verify:5432');
    // CREATE and DROP of the scratch database both happened there.
    expect(verify.some((call) => /CREATE DATABASE "nexa_verify_/.test(call.args))).toBe(true);
    expect(verify.some((call) => /DROP DATABASE IF EXISTS "nexa_verify_/.test(call.args))).toBe(
      true,
    );

    // The dump, the operator's restore and a recovery's candidate stay on the live server.
    await rm(log, { force: true });
    await dedicated.dump(join(dir, 'out.dump'));
    await dedicated.createDatabase('nexa_candidate_x');
    for (const call of await calls()) expect(call.server, call.tool).toBe('live-db:5432');
  });

  it('verifies on the live server when none is named, as before', async () => {
    const live = tools();
    expect(live.verifiesOnDedicatedServer).toBe(false);
    await live.verifyRestore(join(dir, 'x.dump'));
    for (const call of await calls()) expect(call.server).toBe('live-db:5432');
  });
});
