import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * R12 F2 item 8: `check-boundaries` fails a NEW migration that builds an index on a large
 * table without CONCURRENTLY, or adds a CHECK / FOREIGN KEY constraint there without NOT
 * VALID — unless the statement is annotated `-- nexa:blocking-ddl-ok <reason>`.
 */
describe('the blocking-DDL migration rule', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexa-ddl-'));
    writeFileSync(join(dir, 'tables.txt'), '# a comment\norders\naudit_logs\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (files: Record<string, string>, baseline = '10') => {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    return spawnSync(
      process.execPath,
      [
        'scripts/check-migration-ddl.mjs',
        '--dir',
        dir,
        '--baseline',
        baseline,
        '--tables',
        join(dir, 'tables.txt'),
      ],
      { encoding: 'utf8' },
    );
  };

  it('fails a plain CREATE INDEX on a large table, and passes CONCURRENTLY or a small table', () => {
    const bad = run({
      '0011_x.sql':
        'CREATE INDEX "orders_x_idx" ON "orders" USING btree ("tenant_id");--> statement-breakpoint\n',
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('0011_x.sql: CREATE INDEX on the large table orders');
    rmSync(join(dir, '0011_x.sql'));
    const good = run({
      '0012_y.sql':
        'CREATE UNIQUE INDEX "panels_x" ON "panels" ("id");\nCREATE INDEX CONCURRENTLY "o" ON orders (id);\n',
    });
    expect(good.status).toBe(0);
  });

  it('fails a validated-at-once constraint on a large table, and passes NOT VALID', () => {
    const bad = run({
      '0011_c.sql':
        'ALTER TABLE "audit_logs" ADD CONSTRAINT "a_check" CHECK (result IS NOT NULL);\n' +
        'ALTER TABLE orders ADD CONSTRAINT o_fk FOREIGN KEY (customer_id) REFERENCES customers(id);\n',
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('large table audit_logs without NOT VALID');
    expect(bad.stdout).toContain('large table orders without NOT VALID');
    rmSync(join(dir, '0011_c.sql'));
    expect(
      run({
        '0012_d.sql':
          'ALTER TABLE "orders" ADD CONSTRAINT "o_check" CHECK (x > 0) NOT VALID;\n' +
          'ALTER TABLE "orders" VALIDATE CONSTRAINT "o_check";\n',
      }).status,
    ).toBe(0);
  });

  it('passes an annotated statement, and ignores everything up to the baseline', () => {
    expect(
      run({
        '0011_a.sql':
          '-- nexa:blocking-ddl-ok orders has 40 rows on every installation this ships to\n' +
          'CREATE INDEX "orders_y_idx" ON "orders" ("id");\n',
        '0005_old.sql': 'CREATE INDEX "orders_old" ON "orders" ("id");\n',
      }).status,
    ).toBe(0);
    // An annotation without a reason is no annotation.
    expect(
      run({ '0013_b.sql': '-- nexa:blocking-ddl-ok\nCREATE INDEX "o2" ON "orders" ("id");\n' })
        .status,
    ).toBe(1);
  });

  it('holds on the real tree, and check-boundaries runs it', () => {
    const real = spawnSync(process.execPath, ['scripts/check-migration-ddl.mjs'], {
      encoding: 'utf8',
    });
    expect(real.status, real.stdout).toBe(0);
    // The rule is not vacuous: the whole history, unbaselined, has many such statements.
    const all = spawnSync(
      process.execPath,
      ['scripts/check-migration-ddl.mjs', '--baseline', '0'],
      {
        encoding: 'utf8',
      },
    );
    expect(all.status).toBe(1);
    expect(
      spawnSync('grep', ['-c', 'check-migration-ddl.mjs', 'scripts/check-boundaries.sh'])
        .stdout.toString()
        .trim(),
    ).not.toBe('0');
  });
});
