import { describe, expect, it, vi } from 'vitest';
import {
  READ_SET_MAX_BATCH,
  defineLegacyReadSet,
  readLegacyReadSet,
  withBoundReadSetSession,
  type LegacyReadSetBatch,
} from '../../apps/api/src/modules/platform/legacy-importer/application/read-set';
import {
  LegacySourceRefused,
  type LegacySourceConnector,
  type LegacySourceSession,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import {
  readFromSession,
  readImportV1Identity,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  SYNTHETIC_UNCLASSIFIED_TABLE,
  buildSyntheticLegacyDataset,
  type SyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR1 — the versioned read set framework (`read-set.ts`). Every read set
 * here is a TEST definition over the SYNTHETIC fixture; none is a read set NEXA records
 * (`LEGACY_READ_SET_NAMES` does not name them, so `legacy_read_set_runs` would refuse it).
 */

const PROBE = defineLegacyReadSet({
  name: 'synthetic-probe',
  version: 1,
  tables: [
    {
      table: 'product',
      primaryKey: 'id',
      columns: ['id', 'code_product', 'name_product'],
      optionalColumns: ['agent', 'Location'],
    },
    { table: 'user', primaryKey: 'id', columns: ['id', 'Balance'] },
  ],
});

function connectorOf(dataset: SyntheticLegacyDataset = buildSyntheticLegacyDataset()) {
  return new FixtureLegacySourceConnector(dataset as never);
}

async function sessionOf(dataset?: SyntheticLegacyDataset) {
  return connectorOf(dataset).open();
}

async function readProbe(dataset?: SyntheticLegacyDataset) {
  return readLegacyReadSet(await sessionOf(dataset), PROBE);
}

function withRows(
  table: 'user' | 'product',
  index: number,
  column: string,
  value: string | null,
): SyntheticLegacyDataset {
  const dataset = buildSyntheticLegacyDataset();
  const rows = dataset.tables[table].map((r, i) => (i === index ? { ...r, [column]: value } : r));
  return { ...dataset, tables: { ...dataset.tables, [table]: rows } };
}

describe('the v1 identity a read set session recomputes', () => {
  it('is exactly what the import snapshot computes, without keeping a row', async () => {
    for (const dataset of [
      buildSyntheticLegacyDataset(),
      buildSyntheticLegacyDataset({ extraUsers: 250 }),
    ]) {
      const snapshot = await readFromSession('x', await sessionOf(dataset));
      const identity = await readImportV1Identity(await sessionOf(dataset));
      expect(identity.fingerprint).toBe(snapshot.fingerprint);
      expect(identity.schemaHash).toBe(snapshot.schemaHash);
      expect(identity.tables).toEqual(snapshot.tables);
      expect(identity.synthetic).toBe(true);
      expect(identity.engine).toBe('SYNTHETIC_FIXTURE');
    }
  });
});

describe('a read set definition', () => {
  it('is frozen and carries its versioned fingerprint name', () => {
    expect(PROBE.fingerprintVersion).toBe('legacy-read-set:synthetic-probe:v1');
    expect(Object.isFrozen(PROBE)).toBe(true);
    expect(Object.isFrozen(PROBE.tables[0]?.columns)).toBe(true);
  });

  it('refuses anything that would make the read unsafe or ambiguous', () => {
    const base = { table: 'product', primaryKey: 'id', columns: ['id', 'code_product'] };
    const bad: [string, Parameters<typeof defineLegacyReadSet>[0]][] = [
      [
        'unclassified table',
        { name: 'x', version: 1, tables: [{ ...base, table: SYNTHETIC_UNCLASSIFIED_TABLE }] },
      ],
      ['unknown table', { name: 'x', version: 1, tables: [{ ...base, table: 'setting' }] }],
      ['no table', { name: 'x', version: 1, tables: [] }],
      ['bad name', { name: 'X', version: 1, tables: [base] }],
      ['bad version', { name: 'x', version: 0, tables: [base] }],
      ['pk not read', { name: 'x', version: 1, tables: [{ ...base, columns: ['code_product'] }] }],
      [
        'duplicate column',
        { name: 'x', version: 1, tables: [{ ...base, optionalColumns: ['id'] }] },
      ],
      ['duplicate table', { name: 'x', version: 1, tables: [base, base] }],
      [
        'not an identifier',
        { name: 'x', version: 1, tables: [{ ...base, columns: ['id', 'a`b'] }] },
      ],
      ['injected table', { name: 'x', version: 1, tables: [{ ...base, table: 'user; DROP' }] }],
    ];
    for (const [why, input] of bad) expect(() => defineLegacyReadSet(input), why).toThrow();
  });
});

describe('a read set fingerprint', () => {
  it('is deterministic, versioned, and independent of the source row order', async () => {
    const a = await readProbe();
    const shuffled = buildSyntheticLegacyDataset();
    const b = await readProbe({
      ...shuffled,
      tables: {
        ...shuffled.tables,
        user: [...shuffled.tables.user].reverse(),
        product: [...shuffled.tables.product].reverse(),
      },
    });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.fingerprintVersion).toBe('legacy-read-set:synthetic-probe:v1');
    expect(a.tables['product']).toMatchObject({
      rows: 2,
      columns: ['id', 'code_product', 'name_product', 'agent'],
    });
    expect(a.tables['user']?.rows).toBe(11);
  });

  it('is its own value: never the v1 fingerprint, whatever it reads', async () => {
    const v1 = await readImportV1Identity(await sessionOf());
    const sameColumnsAsV1 = defineLegacyReadSet({
      name: 'v1-shaped',
      version: 1,
      tables: [{ table: 'product', primaryKey: 'id', columns: ['id', 'code_product', 'agent'] }],
    });
    const result = await readLegacyReadSet(await sessionOf(), sameColumnsAsV1);
    expect(result.tables['product']).toEqual(v1.tables.product);
    expect(result.fingerprint).not.toBe(v1.fingerprint);
  });

  it('changes when a read column changes, never when an unread one does', async () => {
    const base = (await readProbe()).fingerprint;
    for (const [table, column] of [
      ['product', 'name_product'],
      ['product', 'code_product'],
      ['product', 'agent'],
      ['user', 'Balance'],
    ] as const) {
      expect((await readProbe(withRows(table, 0, column, 'changed'))).fingerprint, column).not.toBe(
        base,
      );
    }
    for (const [table, column] of [
      ['product', 'price_product'],
      ['user', 'username'],
      ['user', 'number'],
    ] as const) {
      expect((await readProbe(withRows(table, 0, column, 'changed'))).fingerprint, column).toBe(
        base,
      );
    }
  });

  it("covers its tables' whole schema, but no other table's", async () => {
    const dataset = buildSyntheticLegacyDataset();
    const base = (await readProbe(dataset)).fingerprint;
    const retype = (table: string, column: string) => ({
      ...dataset,
      schema: dataset.schema.map((c) =>
        c.table === table && c.column === column ? { ...c, dataType: 'text' } : c,
      ),
    });
    // An unread column of a read table: the schema hash covers it, as v1's does.
    expect((await readProbe(retype('product', 'price_product'))).fingerprint).not.toBe(base);
    // A column of a table the read set does not read: no effect.
    expect((await readProbe(retype('invoice', 'Status'))).fingerprint).toBe(base);
    expect((await readProbe(retype(SYNTHETIC_UNCLASSIFIED_TABLE, 'note'))).fingerprint).toBe(base);
  });

  it('reads an optional column only when the source has it', async () => {
    const dataset = buildSyntheticLegacyDataset();
    const without = await readProbe({
      ...dataset,
      schema: dataset.schema.filter((c) => !(c.table === 'product' && c.column === 'agent')),
    });
    expect(without.tables['product']?.columns).toEqual(['id', 'code_product', 'name_product']);
  });

  it('refuses a source missing a table or a required column before reading a row', async () => {
    const dataset = buildSyntheticLegacyDataset();
    await expect(
      readProbe({
        ...dataset,
        schema: dataset.schema.filter(
          (c) => !(c.table === 'product' && c.column === 'name_product'),
        ),
      }),
    ).rejects.toThrow(/SOURCE_SCHEMA_MISSING_COLUMN/u);
    await expect(
      readProbe({ ...dataset, schema: dataset.schema.filter((c) => c.table !== 'user') }),
    ).rejects.toThrow(/SOURCE_SCHEMA_MISSING_TABLE/u);
  });
});

describe('rows are streamed in bounded batches', () => {
  it('hands at most batchSize rows at a time, in primary key byte order, every row once', async () => {
    const dataset = buildSyntheticLegacyDataset({ extraUsers: 1234 });
    const batches: LegacyReadSetBatch[] = [];
    const result = await readLegacyReadSet(await sessionOf(dataset), PROBE, {
      batchSize: 100,
      expectedFingerprint: (await readProbe(dataset)).fingerprint,
      onBatch: (batch) => {
        batches.push(batch);
      },
    });
    const userBatches = batches.filter((b) => b.table === 'user');
    expect(Math.max(...userBatches.map((b) => b.rows.length))).toBe(100);
    const ids = userBatches.flatMap((b) => b.rows.map((r) => r[0] as string));
    expect(ids).toHaveLength(1245);
    expect(result.tables['user']?.rows).toBe(1245);
    const sorted = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(ids).toEqual(sorted);
    expect(userBatches[0]?.columns).toEqual(['id', 'Balance']);
  });

  it('reads no further than the batch it hands an unfinished consumer', async () => {
    // A session that counts the user rows the reader has PULLED: whenever the consumer is
    // handed a batch, the rows pulled are exactly the rows handed over so far — nothing is
    // read ahead and buffered beyond the batch. `pulled` counts the current pass only: the
    // digest-only pass before delivery reads every row and hands none.
    const dataset = buildSyntheticLegacyDataset({ extraUsers: 500 });
    const base = await sessionOf(dataset);
    let pulled = 0;
    const counting: LegacySourceSession = {
      ...base,
      readSetRows: (table, pk, columns) =>
        (async function* () {
          if (table === 'user') pulled = 0;
          for await (const row of base.readSetRows(table, pk, columns)) {
            if (table === 'user') pulled += 1;
            yield row;
          }
        })(),
    };
    const gaps: number[] = [];
    let handed = 0;
    await readLegacyReadSet(counting, PROBE, {
      batchSize: 50,
      expectedFingerprint: (await readProbe(dataset)).fingerprint,
      onBatch: async (batch) => {
        if (batch.table !== 'user') return;
        handed += batch.rows.length;
        gaps.push(pulled - handed);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    expect(handed).toBe(511);
    expect(gaps).toHaveLength(11);
    expect(gaps.every((gap) => gap === 0)).toBe(true);
  });

  it('refuses a batch size outside 1..max', async () => {
    for (const batchSize of [0, -1, 1.5, READ_SET_MAX_BATCH + 1]) {
      await expect(readLegacyReadSet(await sessionOf(), PROBE, { batchSize })).rejects.toThrow();
    }
  });
});

describe('verification precedes delivery', () => {
  /** A session that records every user row pulled, per pass, and can corrupt a pass. */
  function passes(dataset: SyntheticLegacyDataset, corruptPass?: number) {
    const pulledPerPass: number[] = [];
    const connector = connectorOf(dataset);
    return {
      pulledPerPass,
      open: async (): Promise<LegacySourceSession> => {
        const base = await connector.open();
        return {
          ...base,
          readSetRows: (table, pk, columns) =>
            (async function* () {
              if (table === 'user') pulledPerPass.push(0);
              const pass = pulledPerPass.length;
              for await (const row of base.readSetRows(table, pk, columns)) {
                if (table === 'user') pulledPerPass[pass - 1] = (pulledPerPass[pass - 1] ?? 0) + 1;
                // The corrupted pass reads a different Balance for the first user row.
                yield table === 'user' && pass === corruptPass && pulledPerPass[pass - 1] === 1
                  ? [row[0] ?? null, 'diverged']
                  : row;
              }
            })(),
        };
      },
    };
  }

  it('delivering rows without the approved read set fingerprint is refused before any read', async () => {
    const spy = passes(buildSyntheticLegacyDataset());
    const onBatch = vi.fn();
    await expect(readLegacyReadSet(await spy.open(), PROBE, { onBatch } as never)).rejects.toThrow(
      /requires the approved read set fingerprint/u,
    );
    expect(onBatch).not.toHaveBeenCalled();
    expect(spy.pulledPerPass).toEqual([]);
  });

  it('a malformed approved value is refused before any read', async () => {
    const spy = passes(buildSyntheticLegacyDataset());
    const onBatch = vi.fn();
    await expect(
      readLegacyReadSet(await spy.open(), PROBE, { onBatch, expectedFingerprint: 'ABC' }),
    ).rejects.toThrow(/64 lowercase hex/u);
    expect(onBatch).not.toHaveBeenCalled();
    expect(spy.pulledPerPass).toEqual([]);
  });

  it('a mismatch is refused after the digest-only pass: onBatch is never called', async () => {
    const spy = passes(buildSyntheticLegacyDataset());
    const onBatch = vi.fn();
    const refusal = await readLegacyReadSet(await spy.open(), PROBE, {
      onBatch,
      expectedFingerprint: 'e'.repeat(64),
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(LegacySourceRefused);
    expect((refusal as LegacySourceRefused).code).toBe('READ_SET_FINGERPRINT_MISMATCH');
    expect(onBatch).not.toHaveBeenCalled();
    expect(spy.pulledPerPass).toHaveLength(1);
  });

  it('a changed source row is refused against the fingerprint approved before it', async () => {
    const approved = (await readProbe()).fingerprint;
    const onBatch = vi.fn();
    await expect(
      readLegacyReadSet(await sessionOf(withRows('product', 0, 'name_product', 'x')), PROBE, {
        onBatch,
        expectedFingerprint: approved,
      }),
    ).rejects.toThrow(/READ_SET_FINGERPRINT_MISMATCH/u);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('the digest-only read refuses a mismatch too, and accepts the approved value', async () => {
    const approved = (await readProbe()).fingerprint;
    await expect(
      readLegacyReadSet(await sessionOf(), PROBE, { expectedFingerprint: 'e'.repeat(64) }),
    ).rejects.toThrow(/READ_SET_FINGERPRINT_MISMATCH/u);
    const spy = passes(buildSyntheticLegacyDataset());
    const result = await readLegacyReadSet(await spy.open(), PROBE, {
      expectedFingerprint: approved,
    });
    expect(result.fingerprint).toBe(approved);
    expect(spy.pulledPerPass).toHaveLength(1);
  });

  it('a match delivers every row once, in a second pass over the same session', async () => {
    const approved = (await readProbe()).fingerprint;
    const spy = passes(buildSyntheticLegacyDataset());
    let delivered = 0;
    const result = await readLegacyReadSet(await spy.open(), PROBE, {
      expectedFingerprint: approved,
      onBatch: (batch) => {
        if (batch.table !== 'user') return;
        delivered += batch.rows.length;
        // A user row is delivered only once the verifying pass has read every user row.
        expect(spy.pulledPerPass).toHaveLength(2);
      },
    });
    expect(result.fingerprint).toBe(approved);
    expect(spy.pulledPerPass).toEqual([delivered, delivered]);
  });

  it('a delivery pass that reads other rows than the verified pass fails', async () => {
    const approved = (await readProbe()).fingerprint;
    const spy = passes(buildSyntheticLegacyDataset(), 2);
    const refusal = await readLegacyReadSet(await spy.open(), PROBE, {
      expectedFingerprint: approved,
      onBatch: () => undefined,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(LegacySourceRefused);
    expect((refusal as LegacySourceRefused).code).toBe('READ_SET_SNAPSHOT_DIVERGED');
  });
});

describe('the adapter refuses rows of a table no read set may read', () => {
  it('UNCLASSIFIED: names and counts only', async () => {
    const session = await sessionOf();
    expect(() => session.readSetRows(SYNTHETIC_UNCLASSIFIED_TABLE, 'id', ['id', 'note'])).toThrow(
      LegacySourceRefused,
    );
    expect(await session.countRows(SYNTHETIC_UNCLASSIFIED_TABLE)).toBe(3);
  });
});

describe('a read set session is bound to the approved v1 source', () => {
  function spying(connector: LegacySourceConnector) {
    const closed = vi.fn();
    const rowsRead = vi.fn();
    return {
      closed,
      rowsRead,
      connector: {
        label: connector.label,
        open: async () => {
          const session = await connector.open();
          return {
            ...session,
            readSetRows: (t: string, pk: string, c: readonly string[]) => {
              rowsRead(t);
              return session.readSetRows(t, pk, c);
            },
            close: async () => {
              closed();
              await session.close();
            },
          } satisfies LegacySourceSession;
        },
      } satisfies LegacySourceConnector,
    };
  }

  it('refuses another source before reading a row of its own tables, and closes', async () => {
    const spy = spying(connectorOf());
    const work = vi.fn();
    await expect(withBoundReadSetSession(spy.connector, 'a'.repeat(64), work)).rejects.toThrow(
      /SOURCE_FINGERPRINT_MISMATCH/u,
    );
    expect(work).not.toHaveBeenCalled();
    expect(spy.rowsRead).not.toHaveBeenCalled();
    expect(spy.closed).toHaveBeenCalledTimes(1);
  });

  it('runs the read set in the SAME session once the v1 fingerprint matches', async () => {
    const approved = (await readImportV1Identity(await sessionOf())).fingerprint;
    const spy = spying(connectorOf());
    const opened: LegacySourceSession[] = [];
    const result = await withBoundReadSetSession(spy.connector, approved, async (session, v1) => {
      opened.push(session);
      expect(v1.fingerprint).toBe(approved);
      return readLegacyReadSet(session, PROBE);
    });
    expect(result.fingerprint).toBe((await readProbe()).fingerprint);
    expect(spy.closed).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
  });

  it('a changed source is refused even if the read set itself would read the same rows', async () => {
    const approved = (await readImportV1Identity(await sessionOf())).fingerprint;
    // An invoice change: the probe reads no invoice, but the source is not the approved one.
    const dataset = buildSyntheticLegacyDataset();
    const changed = {
      ...dataset,
      tables: {
        ...dataset.tables,
        invoice: dataset.tables.invoice.map((r, i) => (i === 0 ? { ...r, Status: 'removed' } : r)),
      },
    };
    await expect(
      withBoundReadSetSession(connectorOf(changed), approved, (s) => readLegacyReadSet(s, PROBE)),
    ).rejects.toThrow(/SOURCE_FINGERPRINT_MISMATCH/u);
  });

  it('requires a well-formed approved value', async () => {
    await expect(withBoundReadSetSession(connectorOf(), 'ABC', vi.fn())).rejects.toThrow();
  });
});
