import { describe, expect, it, vi } from 'vitest';
import {
  PRODUCTS_READ_SET,
  ProductObservationAssembler,
  digestProductsReadSet,
  liveInvoiceCountsByCode,
  productCodeMultiplicity,
  readApprovedProductsReadSet,
} from '../../apps/api/src/modules/platform/legacy-importer/application/products-read-set';
import {
  readFromSession,
  readImportV1Identity,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR2 — the `products` read set over the SYNTHETIC fixture (not evidence).
 */

/** The PR1 golden value (`legacy-import-read-set-v1.test.ts`), restated: reading products must not move it. */
const SYNTHETIC_V1_FINGERPRINT = '4b2bc6f8d96f565f665bb9c5f709a0ef0a95727755dd24ee04b23265fc9bf5e3';

const open = (snapshot?: 'A' | 'B') =>
  new FixtureLegacySourceConnector(
    buildSyntheticLegacyDataset(snapshot === undefined ? {} : { productReview: snapshot }) as never,
  ).open();

describe('the products read set', () => {
  it('is its own versioned read set with a reviewed allowlist (no inbounds, no proxies)', () => {
    expect(PRODUCTS_READ_SET.fingerprintVersion).toBe('legacy-read-set:products:v1');
    expect(PRODUCTS_READ_SET.tables).toEqual([
      {
        table: 'product',
        primaryKey: 'id',
        columns: ['id', 'code_product'],
        optionalColumns: [
          'name_product',
          'price_product',
          'Volume_constraint',
          'Service_time',
          'Location',
          'Category',
          'category',
          'agent',
          'note',
          'data_limit_reset',
          'one_buy_status',
          'hide_panel',
        ],
      },
    ]);
  });

  it('reading it leaves the v1 fingerprint exactly the pinned synthetic value', async () => {
    const session = await open();
    const before = await readImportV1Identity(session);
    expect(before.fingerprint).toBe(SYNTHETIC_V1_FINGERPRINT);
    const products = await digestProductsReadSet(session);
    expect(products.fingerprint).not.toBe(before.fingerprint);
    expect((await readImportV1Identity(session)).fingerprint).toBe(SYNTHETIC_V1_FINGERPRINT);
    expect((await readFromSession('fixture', session)).fingerprint).toBe(SYNTHETIC_V1_FINGERPRINT);
  });

  it('reads optional columns only when present; its fingerprint is not v1’s', async () => {
    const plain = await digestProductsReadSet(await open());
    expect(plain.tables['product']?.columns).toEqual([
      'id',
      'code_product',
      'name_product',
      'price_product',
      'Volume_constraint',
      'Service_time',
      'agent',
    ]);
    const review = await digestProductsReadSet(await open('A'));
    expect(review.tables['product']?.columns).toEqual([
      'id',
      'code_product',
      'name_product',
      'price_product',
      'Volume_constraint',
      'Service_time',
      'Location',
      'Category',
      'agent',
      'note',
      'one_buy_status',
      'hide_panel',
    ]);
    expect(review.fingerprint).not.toBe(plain.fingerprint);
    // Deterministic, and a changed product moves it.
    expect((await digestProductsReadSet(await open('A'))).fingerprint).toBe(review.fingerprint);
    expect((await digestProductsReadSet(await open('B'))).fingerprint).not.toBe(review.fingerprint);
  });

  it('refuses an unapproved fingerprint BEFORE handing out a single row', async () => {
    const onBatch = vi.fn();
    await expect(
      readApprovedProductsReadSet(await open('A'), 'f'.repeat(64), { batchSize: 2, onBatch }),
    ).rejects.toThrow(/SOURCE_FINGERPRINT_MISMATCH/u);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('delivers in bounded batches under the approved fingerprint', async () => {
    const session = await open('A');
    const approved = (await digestProductsReadSet(session)).fingerprint;
    const sizes: number[] = [];
    const result = await readApprovedProductsReadSet(session, approved, {
      batchSize: 4,
      onBatch: (batch) => {
        sizes.push(batch.rows.length);
        return Promise.resolve();
      },
    });
    expect(result.fingerprint).toBe(approved);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(result.tables['product']?.rows);
  });
});

describe('assembling per-code observations', () => {
  it('keeps distinct codes distinct, groups a duplicated code, skips unreviewable codes', async () => {
    const session = await open('A');
    const approved = (await digestProductsReadSet(session)).fingerprint;
    const assembler = new ProductObservationAssembler(
      await productCodeMultiplicity(session),
      await liveInvoiceCountsByCode(session),
    );
    const seen: { code: string; rows: number; live: number }[] = [];
    await readApprovedProductsReadSet(session, approved, {
      // A batch of 1 puts the two `dup` rows in different batches: they are still one code.
      batchSize: 1,
      onBatch: (batch) => {
        for (const o of assembler.take(batch)) {
          seen.push({ code: o.code, rows: o.rows.length, live: o.liveInvoiceCount });
        }
        return Promise.resolve();
      },
    });
    assembler.finish();
    const byCode = Object.fromEntries(seen.map((o) => [o.code, o]));
    expect(Object.keys(byCode).sort()).toEqual(
      ['dup', 'p1', 'p13', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'].sort(),
    );
    expect(seen).toHaveLength(Object.keys(byCode).length);
    expect(byCode['dup']?.rows).toBe(2);
    // p1 and p3 share 30 GB / 30 d and stay two codes.
    expect(byCode['p1']?.rows).toBe(1);
    expect(byCode['p3']?.rows).toBe(1);
    // The synthetic dataset's one live, real, non-custom invoice naming a product is p1's.
    expect(byCode['p1']?.live).toBe(1);
    expect(byCode['p2']?.live).toBe(0);
    expect(assembler.skipped).toEqual({ CODE_EMPTY: 2, CODE_INVALID: 0 });
    expect(assembler.rows).toBe(14);
  });
});
