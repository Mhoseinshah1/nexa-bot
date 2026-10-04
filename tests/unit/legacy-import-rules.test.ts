import { describe, expect, it } from 'vitest';
import {
  isNexaError,
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_IMPORT_SOURCE_TABLES,
} from '@nexa/contracts';
import {
  assertLegacyKey,
  assertSha256,
  decideMapWrite,
  resumeDecision,
} from '../../apps/api/src/modules/platform/legacy-import/application/legacy-import-ports';

/**
 * Migration P4's two pure rules (`docs/legacy-import-metadata.md`): what a rerun's write does
 * to an existing map row, and what a resumed run does with a source row it meets again.
 */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';

const imported = {
  status: 'IMPORTED' as const,
  checksum: A,
  entityType: 'CUSTOMER' as const,
  entityId: E1,
  reasonCode: null,
};

describe('decideMapWrite', () => {
  it('an identical IMPORTED decision is UNCHANGED (idempotent rerun)', () => {
    expect(
      decideMapWrite(imported, {
        checksum: A,
        decision: { status: 'IMPORTED', entityType: 'CUSTOMER', entityId: E1, reasonCode: null },
      }),
    ).toBe('UNCHANGED');
  });

  it('never re-points an IMPORTED row to another entity', () => {
    expect(
      decideMapWrite(imported, {
        checksum: A,
        decision: { status: 'IMPORTED', entityType: 'CUSTOMER', entityId: E2, reasonCode: null },
      }),
    ).toBe('IMPORTED_ENTITY_MISMATCH');
    expect(
      decideMapWrite(imported, {
        checksum: A,
        decision: { status: 'IMPORTED', entityType: 'SERVICE', entityId: E1, reasonCode: null },
      }),
    ).toBe('IMPORTED_ENTITY_MISMATCH');
  });

  it('never downgrades an IMPORTED row', () => {
    for (const status of ['SKIPPED', 'MANUAL_REVIEW', 'FAILED'] as const) {
      expect(
        decideMapWrite(imported, {
          checksum: A,
          decision: { status, reasonCode: 'INTERNAL_ERROR' },
        }),
      ).toBe('IMPORTED_ENTITY_MISMATCH');
    }
  });

  it('surfaces a changed source under an IMPORTED row instead of absorbing it', () => {
    expect(
      decideMapWrite(imported, {
        checksum: B,
        decision: { status: 'IMPORTED', entityType: 'CUSTOMER', entityId: E1, reasonCode: null },
      }),
    ).toBe('IMPORTED_SOURCE_CHANGED');
  });

  it('a non-IMPORTED row may be revisited, and an identical revisit changes nothing', () => {
    const review = {
      status: 'MANUAL_REVIEW' as const,
      checksum: A,
      entityType: null,
      entityId: null,
      reasonCode: 'PROVIDER_MISSING' as const,
    };
    expect(
      decideMapWrite(review, {
        checksum: A,
        decision: { status: 'MANUAL_REVIEW', reasonCode: 'PROVIDER_MISSING' },
      }),
    ).toBe('UNCHANGED');
    expect(
      decideMapWrite(review, {
        checksum: A,
        decision: { status: 'IMPORTED', entityType: 'SERVICE', entityId: E1, reasonCode: null },
      }),
    ).toBe('UPDATE');
    expect(
      decideMapWrite(review, {
        checksum: B,
        decision: { status: 'MANUAL_REVIEW', reasonCode: 'PROVIDER_MISSING' },
      }),
    ).toBe('UPDATE');
  });
});

describe('resumeDecision', () => {
  it('skips only what was IMPORTED from the same source row', () => {
    expect(resumeDecision(null, A)).toBe('PROCESS');
    expect(resumeDecision({ status: 'IMPORTED', checksum: A }, A)).toBe('SKIP');
    expect(resumeDecision({ status: 'IMPORTED', checksum: A }, B)).toBe('SOURCE_CHANGED');
    expect(resumeDecision({ status: 'FAILED', checksum: A }, A)).toBe('PROCESS');
    expect(resumeDecision({ status: 'MANUAL_REVIEW', checksum: A }, A)).toBe('PROCESS');
  });
});

describe('legacy keys (Codex P2, #175)', () => {
  const code = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (error) {
      return isNexaError(error) ? error.code : 'not-nexa';
    }
  };

  it('refuses a credential-shaped id for EVERY source table', () => {
    for (const table of LEGACY_IMPORT_SOURCE_TABLES) {
      for (const id of [
        'hunter2',
        'password:hunter2',
        'a b',
        '',
        '-1',
        '1.5',
        '+98912',
        'token=abcd',
        'abcd:ef12',
      ]) {
        expect({ table, id, code: code(() => assertLegacyKey(table, id)) }).toEqual({
          table,
          id,
          code: LEGACY_IMPORT_ERROR_CODES.INVALID,
        });
      }
    }
  });

  it('accepts the evidenced shapes: user.id is a numeric Telegram id', () => {
    for (const id of ['1', '42', '7123456789', '9'.repeat(20)]) {
      expect(code(() => assertLegacyKey('user', id))).toBeNull();
    }
    // A leading zero is never a Telegram id (it is a valid 4-hex invoice id, below).
    expect(code(() => assertLegacyKey('user', '0123'))).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
  });

  it('refuses a table whose key shape is not evidenced', () => {
    for (const table of ['Invoice', 'marzban_panel', 'product', 'Payment_report']) {
      expect(code(() => assertLegacyKey(table, '1'))).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
    }
  });

  /**
   * OQ-P4-01: `invoice.id_invoice` is `bin2hex(random_bytes(2|4))`, optionally prefixed by a
   * 7-digit `rand(1000000, 9999999)` collision fallback, in every public MirzaBot revision.
   */
  it('accepts exactly the evidenced invoice shapes', () => {
    for (const id of [
      'a3f9', // bin2hex(random_bytes(2))
      '0000',
      '9c1e04ab', // bin2hex(random_bytes(4))
      '12345678', // 8 hex that happen to be digits
      '1000000a3f9', // prefix + 4 hex
      '99999999c1e04ab', // prefix + 8 hex
      '4821733' + 'deadbeef',
    ]) {
      expect({ id, code: code(() => assertLegacyKey('invoice', id)) }).toEqual({ id, code: null });
    }
  });

  it('refuses every invoice id outside the evidenced shapes', () => {
    for (const id of [
      'A3F9', // uppercase: bin2hex is lowercase
      'a3f', // 3 hex
      'a3f9b', // 5 hex
      'a3f9b2', // 6 hex (random_bytes(3) never reached id_invoice)
      'a3f9b2c1d0', // 10 hex
      '0123456a3f9', // prefix with a leading zero
      '123456a3f9', // 6-digit prefix + 4 = 10 chars (also not hex-8)
      '12345678a3f9b', // 8-digit prefix + 5
      '1234567a3f9b2', // prefix + 6 hex
      'a3f9-b2c1',
      'a3f9 ',
      ' a3f9',
      'beefcafe\n',
      'g3f9',
      'hunter2',
      'password:hunter2',
      'https://sub.example/abc',
      '',
    ]) {
      expect({ id, code: code(() => assertLegacyKey('invoice', id)) }).toEqual({
        id,
        code: LEGACY_IMPORT_ERROR_CODES.INVALID,
      });
    }
  });
});

describe('shape checks', () => {
  const code = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (error) {
      return isNexaError(error) ? error.code : 'not-nexa';
    }
  };
  it('refuses keys and checksums outside the declared shape', () => {
    expect(code(() => assertLegacyKey('user', '12345'))).toBeNull();
    expect(code(() => assertLegacyKey('User', '1'))).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
    expect(code(() => assertLegacyKey('user; drop', '1'))).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
    expect(code(() => assertLegacyKey('user', 'a b'))).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
    expect(code(() => assertLegacyKey('user', '9'.repeat(21)))).toBe(
      LEGACY_IMPORT_ERROR_CODES.INVALID,
    );
    expect(code(() => assertSha256(A, 'c'))).toBeNull();
    expect(code(() => assertSha256(A.toUpperCase(), 'c'))).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
  });
});
