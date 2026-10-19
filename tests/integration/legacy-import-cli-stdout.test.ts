import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_CONTAINER } from '../../apps/api/src/legacy-import.cli';
import { SECTION_TIMING_MESSAGE } from '../../apps/api/src/modules/platform/legacy-importer/application/section-timing';
import {
  MigrationRig,
  generateDataset,
  paymentRecords,
  rigExecutor,
  writeMigrationPackage,
} from '../support/legacy-migration-rig';
import { createTestContext, type TestContext } from './harness';

/**
 * Under `--format json` the legacy-import CLI's STDOUT is one JSON document — the rehearsal
 * (`scripts/legacy-rehearsal.sh`, `p7-resume`) and every operator script read it as the verdict.
 * A log line on stdout makes it unreadable: the per-section timing lines did exactly that to
 * the resume's report (CI, "cannot read verdict from c1-resume.json").
 *
 * So every container the CLI builds logs to stderr (`CLI_CONTAINER`), and this proves it on the
 * path that broke: an import interrupted mid-batch and then resumed, at LOG_LEVEL info, through
 * a container built with the CLI's own options. Nothing a log line wrote may reach fd 1 /
 * process.stdout, and the timing lines must still be written (to fd 2) — never dropped.
 */

/** Everything written to stdout and to stderr while `fn` runs, kept apart. */
async function captureStreams(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const text = (data: unknown): string =>
    typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
  const keep = (fd: unknown, data: unknown) => {
    if (fd === 1 || fd === process.stdout.fd) out.push(text(data));
    else if (fd === 2 || fd === process.stderr.fd) err.push(text(data));
  };
  const writeSync = fs.writeSync;
  const write = fs.write;
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  (fs as { writeSync: unknown }).writeSync = (fd: number, data: unknown) => {
    keep(fd, data);
    // Swallowed: the lines are the evidence, not the test's output.
    return typeof data === 'string'
      ? Buffer.byteLength(data)
      : Buffer.isBuffer(data)
        ? data.length
        : 0;
  };
  (fs as { write: unknown }).write = (fd: number, data: unknown, ...rest: unknown[]) => {
    keep(fd, data);
    const callback = rest.find((r) => typeof r === 'function') as
      ((e: null, n: number) => void) | undefined;
    callback?.(null, text(data).length);
  };
  process.stdout.write = ((data: unknown) => {
    keep(1, data);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((data: unknown) => {
    keep(2, data);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    (fs as { writeSync: unknown }).writeSync = writeSync;
    (fs as { write: unknown }).write = write;
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { out: out.join(''), err: err.join('') };
}

describe('legacy-import CLI: stdout is the document, log lines go to stderr', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lic-out-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lic-out-root-'));
    ctx = await createTestContext(
      {
        PANEL_HTTP_ALLOW_LOOPBACK: 'true',
        LEGACY_MIGRATION_ENABLED: 'true',
        LEGACY_MIGRATION_WORK_DIR: migrationRoot,
        BACKUP_WORK_DIR: work,
        // The CLI's default level: the timing lines are emitted.
        LOG_LEVEL: 'info',
      },
      CLI_CONTAINER,
    );
    rig = new MigrationRig(ctx, migrationRoot);
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  it('every container the CLI builds takes the CLI options', () => {
    const cli = readFileSync('apps/api/src/legacy-import.cli.ts', 'utf8');
    const calls = cli.match(/createContainer\(/gu)?.length ?? 0;
    expect(calls).toBeGreaterThan(0);
    expect(cli.match(/createContainer\([^;]*?CLI_CONTAINER,?\s*\)/gsu)?.length).toBe(calls);
    expect(CLI_CONTAINER.logTo).toBe('stderr');
  });

  it('an interrupted import and its resume write no log line to stdout, and keep the timing lines', async () => {
    const generated = generateDataset({ users: 600, invoices: 120 });
    const pkg = await writeMigrationPackage(join(work, 'stdout.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      history: { 'records/payments.jsonl': paymentRecords(generated.users) },
    });
    await rig.freshTenant(generated.liveAccounts);
    const executor = rigExecutor(ctx);
    const id = await rig.prepare(pkg, executor);
    const db = ctx.container.database.db;
    // A crash inside the customers phase (after its first committed batch), then the resume.
    await db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION lic_test_crash() RETURNS trigger AS $$
      BEGIN
        IF (SELECT count(*) FROM customers WHERE tenant_id = NEW.tenant_id) >= 250 THEN
          RAISE EXCEPTION 'lic test: simulated crash inside a customers batch';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS lic_test_crash ON customers;
      CREATE TRIGGER lic_test_crash BEFORE INSERT ON customers
        FOR EACH ROW EXECUTE FUNCTION lic_test_crash();`),
    );
    const interrupted = await captureStreams(async () => {
      try {
        await executor.tick();
      } finally {
        await db.execute(sql.raw('DROP TRIGGER IF EXISTS lic_test_crash ON customers'));
        await db.execute(sql.raw('DROP FUNCTION IF EXISTS lic_test_crash()'));
      }
    });
    expect((await rig.detail(id)).status).toBe('APPLYING');
    const resumed = await captureStreams(async () => {
      for (let i = 0; i < 4 && (await rig.detail(id)).status === 'APPLYING'; i += 1) {
        await executor.tick();
      }
    });
    expect(['COMPLETED', 'COMPLETED_WITH_DISCREPANCY']).toContain((await rig.detail(id)).status);

    for (const { out, err } of [interrupted, resumed]) {
      // Not one log line on stdout — no pino record, no timing line.
      expect(out).not.toMatch(/"level":/u);
      expect(out).not.toContain(SECTION_TIMING_MESSAGE);
      // The timing lines are kept: on stderr.
      expect(err).toContain(SECTION_TIMING_MESSAGE);
    }
    // The resume's own import sections were timed (and therefore logged) on stderr.
    expect(resumed.err).toMatch(/"section":"apply\.customers"/u);
    expect(resumed.err).toMatch(/"section":"apply\.services"/u);
  }, 600_000);
});
