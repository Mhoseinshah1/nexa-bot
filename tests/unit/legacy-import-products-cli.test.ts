import { describe, expect, it } from 'vitest';
import {
  ProductsUsageError,
  mergeProductsIntoMap,
  parseProductsExportArgs,
  parseProductsReadArgs,
} from '../../apps/api/src/legacy-import-products';
import {
  PANEL_MAPPING_FORMAT,
  PanelMappingRefused,
  parsePanelMapping,
} from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';

/** Mirza PR2 — the `products-read` / `products-export` command lines and the map merge. */

const HEX = 'a'.repeat(64);
const TENANT = '0190a000-0000-7000-8000-00000000000a';
const P = (n: number) => `0190a000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

describe('products-read arguments', () => {
  const base = ['--tenant', 'main', '--source', 'fixture:x.json', '--target', 'nexa_dev'];

  it('requires the v1 approval; the products approval is optional', () => {
    expect(() => parseProductsReadArgs(base)).toThrow(/--expected-fingerprint is required/u);
    const unbound = parseProductsReadArgs([...base, '--expected-fingerprint', HEX]);
    expect(unbound).toMatchObject({ expectedProductsFingerprint: null, batchSize: 1000 });
    const bound = parseProductsReadArgs([
      ...base,
      '--expected-fingerprint',
      HEX,
      '--expected-products-fingerprint',
      'b'.repeat(64),
      '--batch-size',
      '50',
    ]);
    expect(bound).toMatchObject({ expectedProductsFingerprint: 'b'.repeat(64), batchSize: 50 });
  });

  it.each([
    [['--expected-fingerprint', 'XYZ'], /SHA-256/u],
    [['--expected-fingerprint', HEX, '--batch-size', '0'], /--batch-size/u],
    [['--expected-fingerprint', HEX, '--batch-size', '5001'], /--batch-size/u],
    [['--expected-fingerprint', HEX, '--password', 'x'], /password/iu],
    [['--expected-fingerprint', HEX, '--panel-map', 'm.json'], /Unknown argument/u],
  ])('refuses %j', (extra, message) => {
    expect(() => parseProductsReadArgs([...base, ...extra])).toThrow(ProductsUsageError);
    expect(() => parseProductsReadArgs([...base, ...extra])).toThrow(message);
  });

  it('refuses a password inside a DSN', () => {
    expect(() =>
      parseProductsReadArgs([
        '--tenant',
        'main',
        '--source',
        'mysql://u:secret@h/db',
        '--target',
        'nexa_dev',
        '--expected-fingerprint',
        HEX,
      ]),
    ).toThrow(ProductsUsageError);
  });
});

describe('products-export arguments', () => {
  it('requires the approved products fingerprint and takes no source', () => {
    const base = ['--tenant', 'main', '--target', 'nexa_dev'];
    expect(() => parseProductsExportArgs(base)).toThrow(/--expected-products-fingerprint/u);
    expect(
      parseProductsExportArgs([...base, '--expected-products-fingerprint', HEX]),
    ).toMatchObject({ panelMap: null });
    expect(() =>
      parseProductsExportArgs([
        ...base,
        '--expected-products-fingerprint',
        HEX,
        '--source',
        'fixture:x',
      ]),
    ).toThrow(/Unknown argument/u);
  });
});

describe('merging the export into a panel map', () => {
  const map = (products: { codeProduct: string; productId: string }[]) =>
    JSON.stringify({
      format: PANEL_MAPPING_FORMAT,
      tenantId: TENANT,
      panels: [{ codePanel: 'rp1', panelId: P(100) }],
      testPanels: [],
      missingPanels: [],
      productionPanels: [P(100)],
      products,
    });
  const exported = {
    readSetFingerprint: HEX,
    products: [
      { codeProduct: 'p1', productId: P(1) },
      { codeProduct: 'p3', productId: P(3) },
    ],
    notExported: {},
  };

  it('replaces reviewed codes, keeps unreviewed hand-written ones, and moves the fingerprint', () => {
    const before = map([{ codeProduct: 'old', productId: P(9) }]);
    const merged = mergeProductsIntoMap(before, TENANT, exported, new Set(['p1', 'p2', 'p3']));
    expect(merged.file.products).toEqual([
      { codeProduct: 'old', productId: P(9) },
      { codeProduct: 'p1', productId: P(1) },
      { codeProduct: 'p3', productId: P(3) },
    ]);
    expect(merged.fingerprint).not.toBe(parsePanelMapping(before, TENANT).fingerprint);
    // The merged file is itself a valid map with exactly that fingerprint.
    expect(parsePanelMapping(JSON.stringify(merged.file), TENANT).fingerprint).toBe(
      merged.fingerprint,
    );
  });

  it('refuses a hand-written entry that contradicts a review row', () => {
    expect(() =>
      mergeProductsIntoMap(
        map([{ codeProduct: 'p2', productId: P(2) }]),
        TENANT,
        exported,
        new Set(['p1', 'p2', 'p3']),
      ),
    ).toThrow(PanelMappingRefused);
    expect(() =>
      mergeProductsIntoMap(
        map([{ codeProduct: 'p1', productId: P(7) }]),
        TENANT,
        exported,
        new Set(['p1', 'p3']),
      ),
    ).toThrow(/approved to/u);
    // The same entry the review approved is fine.
    expect(
      mergeProductsIntoMap(
        map([{ codeProduct: 'p1', productId: P(1) }]),
        TENANT,
        exported,
        new Set(['p1', 'p3']),
      ).file.products,
    ).toHaveLength(2);
  });
});
