import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureOnlineIndexes,
  ONLINE_INDEXES,
} from '../../apps/api/src/infrastructure/persistence/online-indexes';
import { createDatabase } from '../../apps/api/src/infrastructure/persistence/database';
import { createTestContext, tenantA, testConfig, type TestContext } from './harness';

/**
 * The indexes built outside the migrator.
 *
 * `botctl update` migrates while the OUTGOING release is still serving, so an
 * ordinary `CREATE INDEX` in a migration takes a SHARE lock on a live table and
 * blocks every operator write to it for the length of the build. Drizzle runs
 * every migration inside one transaction and PostgreSQL refuses a concurrent
 * build there, so these are applied afterwards, on their own connection.
 *
 * Everything below drives the real `ensureOnlineIndexes` against a real
 * PostgreSQL. There is nothing to test about this in the abstract: the whole
 * question is what locks the server takes.
 */
describe('the online index build', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const state = async (name: string): Promise<'MISSING' | 'VALID' | 'INVALID'> =>
    ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = $1 AND n.nspname = ANY (current_schemas(false))`,
        [name],
      );
      const row = rows[0];
      if (row === undefined) return 'MISSING';
      return row.valid ? 'VALID' : 'INVALID';
    });

  const definitionOf = async (name: string): Promise<string> =>
    ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
        [name],
      );
      return rows[0]?.indexdef ?? '';
    });

  /** Panels, straight into the table: this is about DDL, not the service. */
  const bulkPanels = async (count: number): Promise<void> => {
    await ctx.container.database.withClient(async (client) => {
      await client.query(
        `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
         SELECT gen_random_uuid(), $1::uuid, 'idx-' || lpad(g::text, 7, '0'),
                'marzban', 'https://panel.example.test', 'ACTIVE'
           FROM generate_series(1, $2::int) AS g`,
        [tenantA.tenantId, count],
      );
    });
  };

  it('leaves every declared index present and valid after migrating', async () => {
    // The harness migrated through the real `runMigrations`, which is the only
    // thing that applies these. An index removed from the list, or one whose
    // build silently failed, is a sequential scan per page with nothing saying
    // so — `pnpm db:check` cannot see these, so this is the check that does.
    expect(ONLINE_INDEXES.length).toBeGreaterThan(0);
    for (const index of ONLINE_INDEXES) {
      expect(await state(index.name), `${index.name} is not usable`).toBe('VALID');
    }
    // And the retired one is gone: 0026 drops it, and it is no longer in the
    // schema file either.
    expect(await state('panels_tenant_page_idx')).toBe('MISSING');
  });

  /**
   * Every declared index matches what the DATABASE actually has.
   *
   * Not just its name, and not just `indisvalid`. Two ways this bites:
   *
   * `panels_tenant_created_page_idx` is partial on `status <> 'ARCHIVED'`, so
   * the archive browser added beside it matched no index at all and paged by
   * sequential scan. A typo in the new predicate — `<>` where `=` was meant —
   * leaves an index that is present and VALID and serves nothing.
   *
   * And `CREATE INDEX CONCURRENTLY IF NOT EXISTS` matches on NAME. Editing a
   * definition in `ONLINE_INDEXES` therefore changes nothing on an installation
   * that already has the old index: the build is skipped, the planner keeps
   * using the old shape, and every other assertion in this file passes. That
   * was found by mutating the archived predicate in the source and watching a
   * predicate-only assertion stay green, because it was reading the database
   * rather than comparing the two.
   *
   * So this compares DECLARED against ACTUAL — the WHOLE shape, not a part of
   * it. The first version of this assertion computed `declared` and then used
   * it only inside `predicateOf(declared)`, checking the columns with an
   * order-insensitive `toContain` over three hard-coded names. Reordering the
   * keyset to `(created_at, id, tenant_id)` — which destroys the index, since
   * the leading column would no longer be the one every query filters on —
   * left it green. Its own docblock claimed otherwise, and the mutation that
   * was run against it happened to be a predicate typo, the one dimension it
   * did cover.
   */
  it('has an index in the database matching every declared definition', async () => {
    for (const index of ONLINE_INDEXES) {
      const actual = await definitionOf(index.name);
      expect(actual, `${index.name} is missing`).not.toBe('');

      // The declared text is everything after `CREATE INDEX CONCURRENTLY <name>`,
      // so normalising whitespace and quoting is enough to compare the shape.
      // PostgreSQL re-renders a predicate — parenthesised, with an explicit
      // `::text` cast — so the comparison is of shape, not of spelling.
      const normalise = (text: string) =>
        text
          .replace(/"/g, '')
          .replace(/'/g, '')
          .replace(/::text/g, '')
          .replace(/[()]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      const declared = normalise(index.definition);
      // `indexdef` is a full statement; the declaration is everything from `ON`
      // onwards. Strip the prefix and the schema qualification so what remains
      // is the same clause in the same order: method, columns, predicate.
      const built = normalise(actual)
        .replace(new RegExp(`^create index ${index.name} `), '')
        .replace(/public\./g, '')
        .replace(/,\s+/g, ',');
      expect(built, `${index.name} shape`).toBe(declared);

      // And the predicate again on its own, so a failure of the line above says
      // WHICH half moved rather than printing two long strings side by side.
      const predicateOf = (text: string) => {
        const where = / where (.*)$/.exec(text);
        return where === null ? null : where[1];
      };
      expect(predicateOf(built), `${index.name} predicate`).toBe(predicateOf(declared));
    }

    // And the two panel indexes are complementary rather than duplicates: one
    // serves the working fleet, the other the archive.
    const live = await definitionOf('panels_tenant_created_page_idx');
    const archived = await definitionOf('panels_tenant_archived_page_idx');
    expect(live).toContain("status <> 'ARCHIVED'");
    expect(archived).toContain("status = 'ARCHIVED'");
  });

  it('is a no-op when the indexes are already valid', async () => {
    // Run on every migration, so a second `botctl update` that changes nothing
    // must not rebuild anything.
    const before = await Promise.all(ONLINE_INDEXES.map((index) => definitionOf(index.name)));
    expect(await ensureOnlineIndexes(ctx.container.database)).toEqual([]);
    expect(await Promise.all(ONLINE_INDEXES.map((index) => definitionOf(index.name)))).toEqual(
      before,
    );
  });

  it('rebuilds an index a cancelled build left invalid', async () => {
    // What a `CREATE INDEX CONCURRENTLY` killed part way through leaves: the
    // name exists, `indisvalid` is false, the planner ignores it — and
    // `CREATE INDEX CONCURRENTLY IF NOT EXISTS` sees the name and does nothing.
    // Without recovery the installation keeps the broken index for ever.
    const index = ONLINE_INDEXES[0]!;
    const expected = await definitionOf(index.name);
    await bulkPanels(3);
    await ctx.container.database.withClient(async (client) => {
      await client.query(`DROP INDEX "${index.name}"`);
      // A failed concurrent build, produced without superuser: a UNIQUE index
      // over a column that is not unique fails and leaves the invalid index
      // behind, which is exactly the state under test.
      await expect(
        client.query(
          `CREATE UNIQUE INDEX CONCURRENTLY "${index.name}" ON panels USING btree (tenant_id)`,
        ),
      ).rejects.toThrow();
    });
    expect(await state(index.name)).toBe('INVALID');

    expect(await ensureOnlineIndexes(ctx.container.database)).toEqual([index.name]);
    expect(await state(index.name)).toBe('VALID');
    // Rebuilt to the RIGHT definition, not merely made valid.
    expect(await definitionOf(index.name)).toBe(expected);
  });

  it('is safe when two migrators run at once', async () => {
    // `botctl update` retries are meant to be safe, and two migrators is what
    // a retry started before the first finished looks like. `IF NOT EXISTS`
    // resolves at statement start, so both builders proceed and the loser gets
    // a duplicate name — reported, before this, as a failed migration run on a
    // database whose migrations had all applied.
    const index = ONLINE_INDEXES[0]!;
    await bulkPanels(2_000);
    await ctx.container.database.withClient((client) => client.query(`DROP INDEX "${index.name}"`));

    const first = createDatabase(testConfig().DATABASE_URL, 2);
    const second = createDatabase(testConfig().DATABASE_URL, 2);
    try {
      const outcomes = await Promise.allSettled([
        ensureOnlineIndexes(first),
        ensureOnlineIndexes(second),
      ]);
      for (const [i, outcome] of outcomes.entries()) {
        expect(
          outcome.status,
          `migrator ${i}: ${outcome.status === 'rejected' ? String(outcome.reason) : ''}`,
        ).toBe('fulfilled');
      }
    } finally {
      await first.close();
      await second.close();
    }
    expect(await state(index.name)).toBe('VALID');
  });

  it('does not put an operator write behind the build', async () => {
    // The finding. An ordinary `CREATE INDEX` needs a SHARE lock, which
    // conflicts with the ROW EXCLUSIVE every insert and update holds — and a
    // DDL statement waiting for its lock sits at the head of the queue, so
    // every write that arrives AFTER it waits too, whether or not it conflicts
    // with anything already granted. Migrations run while the outgoing release
    // is still serving, so that queue is an operator's panel edits.
    //
    // `CREATE INDEX CONCURRENTLY` takes SHARE UPDATE EXCLUSIVE, which does not
    // conflict with ROW EXCLUSIVE, so it never joins that queue.
    //
    // Deterministic rather than timed: an open write transaction is what the
    // builder meets, and the assertion is about lock compatibility, not about
    // whether a race was won.
    const index = ONLINE_INDEXES[0]!;
    await bulkPanels(200);
    await ctx.container.database.withClient((client) => client.query(`DROP INDEX "${index.name}"`));

    // The builder gets its own handle with no timeouts, which is what
    // `runMigrations` gives it: a concurrent build on a large table
    // legitimately outlasts any bound the application uses for its own
    // queries, and a lock_timeout here would hide the very queue under test.
    const builder = createDatabase(testConfig().DATABASE_URL, 2);
    const holder = await ctx.container.database.pool.connect();
    try {
      // An ordinary operator write, transaction left open: ROW EXCLUSIVE.
      await holder.query('BEGIN');
      await holder.query(`UPDATE panels SET updated_at = now() WHERE tenant_id = $1::uuid`, [
        tenantA.tenantId,
      ]);

      const building = ensureOnlineIndexes(builder);
      // Wait until the builder has actually asked the server for its lock, so
      // the write below is not simply racing ahead of it.
      await waitForBuilderLock();

      let blocked: unknown = null;
      try {
        await ctx.container.database.withClient(async (client) => {
          // Short, and load-bearing: under a queued SHARE request this write
          // does not merely take longer, it waits for the whole build.
          await client.query(`SET lock_timeout = '2s'`);
          await client.query(
            `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
             VALUES (gen_random_uuid(), $1::uuid, 'written-during-the-build',
                     'marzban', 'https://panel.example.test', 'ACTIVE')`,
            [tenantA.tenantId],
          );
        });
      } catch (error) {
        blocked = error;
      }

      await holder.query('COMMIT');
      await building;
      expect(blocked, 'an operator write waited for the index build').toBeNull();
      expect(await state(index.name)).toBe('VALID');
    } finally {
      holder.release();
      await builder.close();
    }
  });

  /** Waits for a `panels` lock in one of the two modes an index build takes. */
  async function waitForBuilderLock(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const seen = await ctx.container.database.withClient(async (client) => {
        const { rows } = await client.query<{ mode: string }>(
          `SELECT l.mode
             FROM pg_locks l
             JOIN pg_class c ON c.oid = l.relation
            WHERE c.relname = 'panels'
              AND l.mode IN ('ShareLock', 'ShareUpdateExclusiveLock')`,
        );
        return rows.length > 0;
      });
      if (seen) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the index build never asked for a lock on panels');
  }
});
