import { describe, expect, it } from 'vitest';
import { ReviewUsageError, parseReviewArgs } from '../../apps/api/src/legacy-import-review';

/**
 * `legacy-import review …` — the Manual Review Queue on the operator's terminal. The
 * refusals are pure; the integration suite drives the real queue through `runReview`.
 */

const BASE = ['--tenant', 'acme', '--target', 'nexa_staging'];

describe('legacy-import review: arguments', () => {
  it('parses each action with its own flags', () => {
    expect(parseReviewArgs(['counts', ...BASE])).toMatchObject({ action: 'counts', runId: null });
    expect(
      parseReviewArgs([
        'list',
        ...BASE,
        '--table',
        'invoice',
        '--reason',
        'CUSTOMER_MISSING',
        '--state',
        'OPEN',
        '--after',
        'invoice:a0000001',
        '--limit',
        '20',
      ]),
    ).toMatchObject({
      action: 'list',
      table: 'invoice',
      reason: 'CUSTOMER_MISSING',
      state: 'OPEN',
      after: { legacyTable: 'invoice', legacyId: 'a0000001' },
      limit: 20,
    });
    expect(parseReviewArgs(['list', ...BASE])).toMatchObject({ limit: 50, after: null });
    expect(
      parseReviewArgs([
        'resolve',
        ...BASE,
        '--table',
        'user',
        '--legacy-id',
        '100000004',
        '--expected-reason',
        'INVALID_SOURCE_ROW',
        '--resolution',
        'WILL_NOT_IMPORT',
      ]),
    ).toMatchObject({ action: 'resolve', table: 'user', resolution: 'WILL_NOT_IMPORT' });
    expect(
      parseReviewArgs(['reopen', ...BASE, '--table', 'user', '--legacy-id', '100000004']),
    ).toMatchObject({ action: 'reopen' });
  });

  it('never takes a password on the command line, exactly as the import modes refuse one', () => {
    for (const target of [
      'postgres://nexa:secret@db:5432/nexa',
      'postgresql://u:p@127.0.0.1/nexa_staging',
    ]) {
      expect(() => parseReviewArgs(['counts', '--tenant', 'acme', '--target', target])).toThrow(
        /must not carry a password/u,
      );
    }
    expect(() => parseReviewArgs(['counts', ...BASE, '--password', 'x'])).toThrow(
      /never accepted as an argument/u,
    );
    expect(() => parseReviewArgs(['counts', ...BASE, '--db-password', 'x'])).toThrow(
      /never accepted as an argument/u,
    );
    // A DSN without one, an env: reference and a bare name are fine.
    expect(
      parseReviewArgs(['counts', '--tenant', 'acme', '--target', 'postgres://nexa@db:5432/nexa']),
    ).toMatchObject({ target: 'postgres://nexa@db:5432/nexa' });
    expect(
      parseReviewArgs(['counts', '--tenant', 'acme', '--target', 'env:NEXA_TARGET_DATABASE_URL']),
    ).toMatchObject({ target: 'env:NEXA_TARGET_DATABASE_URL' });
  });

  it('is terminal only: --out and --format are refused', () => {
    expect(() => parseReviewArgs(['list', ...BASE, '--out', '/tmp/x'])).toThrow(/terminal only/u);
    expect(() => parseReviewArgs(['list', ...BASE, '--format', 'json'])).toThrow(/terminal only/u);
    expect(() => parseReviewArgs(['counts', ...BASE, '--out', 'dir'])).toThrow(ReviewUsageError);
  });

  it('nothing defaults: tenant and target are required, and every value is closed', () => {
    expect(() => parseReviewArgs([])).toThrow(ReviewUsageError);
    expect(() => parseReviewArgs(['purge', ...BASE])).toThrow(ReviewUsageError);
    expect(() => parseReviewArgs(['counts', '--target', 'nexa_staging'])).toThrow(/--tenant/u);
    expect(() => parseReviewArgs(['counts', '--tenant', 'acme'])).toThrow(/--target/u);
    expect(() => parseReviewArgs(['list', ...BASE, '--limit', '501'])).toThrow(ReviewUsageError);
    expect(() => parseReviewArgs(['list', ...BASE, '--state', 'CLOSED'])).toThrow(ReviewUsageError);
    expect(() => parseReviewArgs(['list', ...BASE, '--reason', 'EXISTING_CUSTOMER'])).toThrow(
      /not a review reason/u,
    );
    expect(() => parseReviewArgs(['list', ...BASE, '--after', 'a0000001'])).toThrow(/TABLE:ID/u);
    expect(() => parseReviewArgs(['list', ...BASE, '--table', 'product'])).toThrow(
      ReviewUsageError,
    );
    expect(() =>
      parseReviewArgs([
        'resolve',
        ...BASE,
        '--table',
        'user',
        '--legacy-id',
        '1',
        '--expected-reason',
        'INVALID_SOURCE_ROW',
        '--resolution',
        'FIXED',
      ]),
    ).toThrow(/--resolution/u);
    expect(() =>
      parseReviewArgs(['resolve', ...BASE, '--table', 'user', '--legacy-id', '1']),
    ).toThrow(/--resolution|--expected-reason/u);
    // A flag of another action is unknown here.
    expect(() => parseReviewArgs(['counts', ...BASE, '--table', 'user'])).toThrow(
      /Unknown argument/u,
    );
  });
});
