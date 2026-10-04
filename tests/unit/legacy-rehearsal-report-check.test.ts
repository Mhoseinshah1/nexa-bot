import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from '../../scripts/legacy-rehearsal-report-check.mjs';

/**
 * The rehearsal harness's check of P7's machine-readable report against
 * `docs/legacy-migration/final-report.schema.json` (Item 16). The validator implements only
 * the keywords that schema uses, so these cases pin both halves: a conforming document
 * passes, each kind of drift is reported, and a schema keyword it does not implement is
 * refused rather than silently ignored.
 */
const schema = JSON.parse(
  readFileSync(join(__dirname, '../../docs/legacy-migration/final-report.schema.json'), 'utf8'),
) as Record<string, unknown>;

const SHA = 'a'.repeat(64);

function report(): Record<string, any> {
  return {
    schemaVersion: '1',
    evidenceClass: 'staging',
    generatedAt: '2026-10-04T05:00:00.000Z',
    run: {
      runId: '01a10500-0000-7000-8000-000000000001',
      tenant: 'rehearsal',
      mode: 'APPLY',
      status: 'COMPLETED',
      failureCode: null,
      codeVersion: '0.0.0-unknown',
      startedAt: '2026-10-04T04:59:00.000Z',
      finishedAt: '2026-10-04T05:00:00.000Z',
      durationSeconds: 60,
      resumes: 1,
      errors: 0,
      rowsSeen: 30,
    },
    source: {
      fingerprint: SHA,
      snapshotAt: '2026-10-04T04:59:00.000Z',
      checksumTable: { user: SHA, invoice: SHA },
      schemaEvidence: { serverVersion: '10.11', tablesRead: ['user', 'invoice', 'product'] },
    },
    customers: {
      source: 11,
      existing: 0,
      created: 8,
      blocked: 1,
      skipped: 0,
      manualReview: 2,
      errors: 0,
    },
    wallet: {
      currency: 'IRT',
      legacyTotalMinor: '80444',
      importedTotalMinor: '80345',
      notImportedTotalMinor: '99',
      positive: { count: 5, sumMinor: '100345' },
      zero: { count: 2 },
      negative: { count: 1, sumMinor: '-20000' },
      openingEntries: 6,
      duplicatesPrevented: 6,
      preImportTotalMinor: '0',
      expectedPostImportTotalMinor: '80345',
      actualPostImportTotalMinor: '80345',
    },
    services: {
      candidates: 19,
      adopted: 0,
      alreadyMapped: 0,
      testSkipped: 2,
      providerMissing: 2,
      ambiguous: 2,
      mappingMissing: 1,
      productUnresolved: 1,
      unsupported: 4,
      manualReview: 7,
      failed: 0,
    },
    products: { hiddenCreated: 6, hiddenReused: 0, custom: 1, unresolved: 1 },
    trials: { eligible: 4, ineligible: 1, used: 2, noTrial: 1, existingConflict: 0 },
    provider: { reads: 8, writes: 0, inventoriesComplete: true },
    manualReview: { total: 4, byReason: { ADOPTION_PENDING_P6: 4 } },
    reconciliation: [{ id: 'P3', holds: true, expected: 'writes=0 reads>0', actual: 'writes=0' }],
  };
}

describe('legacy-rehearsal-report-check', () => {
  it('accepts a document in the shape P7 emits', () => {
    expect(validate(schema, report())).toEqual([]);
  });

  it('reports a missing provider.writes — the figure the harness gates on', () => {
    const doc = report();
    delete doc.provider.writes;
    expect(validate(schema, doc)).toEqual(['provider: missing required "writes"']);
  });

  it('reports money as a JSON number, an unknown field and an unknown evidence class', () => {
    const doc = report();
    doc.wallet.importedTotalMinor = 80345;
    doc.extra = true;
    doc.evidenceClass = 'real';
    const errors = validate(schema, doc);
    expect(errors).toContain('wallet.importedTotalMinor: is integer, not string');
    expect(errors).toContain('<root>: unexpected property "extra"');
    expect(errors.some((e: string) => e.startsWith('evidenceClass: must be one of'))).toBe(true);
  });

  it('reports a reason code outside the closed-code shape', () => {
    const doc = report();
    doc.manualReview.byReason = { 'free text': 1 };
    expect(validate(schema, doc)[0]).toContain('property name "free text"');
  });

  it('refuses a schema keyword it does not implement instead of ignoring it', () => {
    expect(() => validate({ type: 'object', minProperties: 1 }, {})).toThrow(/not supported/u);
  });
});
