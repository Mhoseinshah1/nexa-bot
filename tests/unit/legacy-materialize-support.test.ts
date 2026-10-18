import { describe, expect, it } from 'vitest';
import { walletEntryListResponseSchema } from '@nexa/contracts';
import {
  mirzaInstant,
  parseMinor,
  sourceRefOf,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/materialize-support';
import {
  readForkMessage,
  threadSourceRef,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/ticket-history.step';

/**
 * The pure parts of the one-time import's history steps: how a Mirza time, amount, id and
 * message become NEXA values. A date is never invented: anything unreadable is null.
 */
describe('Mirza values', () => {
  it('reads absolute times as they are', () => {
    expect(mirzaInstant(1_735_700_000)?.toISOString()).toBe('2025-01-01T02:53:20.000Z');
    expect(mirzaInstant('2024-08-01T10:00:00Z')?.toISOString()).toBe('2024-08-01T10:00:00.000Z');
    expect(mirzaInstant('2024-08-01T10:00:00+03:30')?.toISOString()).toBe(
      '2024-08-01T06:30:00.000Z',
    );
  });

  it("reads Mirza's local time in Asia/Tehran, the only zone the evidence names", () => {
    // Winter: UTC+03:30.
    expect(mirzaInstant('2024-01-15T12:00:00')?.toISOString()).toBe('2024-01-15T08:30:00.000Z');
    // Summer 2024: Iran abolished DST in 2022, so still +03:30.
    expect(mirzaInstant('2024-07-01T12:00:00')?.toISOString()).toBe('2024-07-01T08:30:00.000Z');
    // Summer 2021 was UTC+04:30.
    expect(mirzaInstant('2021-07-01T12:00:00')?.toISOString()).toBe('2021-07-01T07:30:00.000Z');
  });

  it('is null for anything that is not a real time', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'not a date',
      '1403/04/12 08:00:00',
      '2024-02-30T10:00:00',
      12,
      9_999_999_999_999,
    ]) {
      expect(mirzaInstant(bad)).toBeNull();
    }
  });

  it('reads whole numbers and nothing else as money', () => {
    expect(parseMinor('5000')).toBe(5000n);
    expect(parseMinor('-3000')).toBe(-3000n);
    for (const bad of ['10.5', '1e3', '', '150,000', null, undefined, '۱۲۳']) {
      expect(parseMinor(bad)).toBeNull();
    }
  });

  it('builds a bounded source_ref', () => {
    expect(sourceRefOf('payment', '42')).toBe('payment:42');
    expect(sourceRefOf('payment', '  ')).toBeNull();
    expect(sourceRefOf('payment', 'x'.repeat(200))).toBeNull();
  });

  it('names a support thread by its converter hash only', () => {
    expect(threadSourceRef('legacy:support:thread:0123456789abcdef01234567')).toBe(
      'support-thread:0123456789abcdef01234567',
    );
    expect(threadSourceRef('legacy:support:thread:NOT-HEX')).toBeNull();
    expect(threadSourceRef('something else')).toBeNull();
  });

  it('reads a fork message only when both the sender and the text are readable', () => {
    const rec = (fields: Record<string, unknown>) =>
      ({
        id: 'x',
        idempotencyKey: 'k',
        legacyUserId: null,
        customerId: null,
        occurredAt: null,
        createdAt: new Date(),
        payload: { fields_raw: fields },
      }) as never;
    expect(readForkMessage(rec({ sender: 'user', message: 'hi' }))).toEqual({
      sender: 'CUSTOMER',
      body: 'hi',
    });
    expect(readForkMessage(rec({ role: 'Admin', text: 'hello' }))).toEqual({
      sender: 'ADMIN',
      body: 'hello',
    });
    expect(readForkMessage(rec({ sender: 'robot', message: 'hi' }))).toBeNull();
    expect(readForkMessage(rec({ sender: 'user' }))).toBeNull();
  });
});

describe('the wallet entries response', () => {
  it('still parses a response with no imported history, and carries MIRZA rows in their own array', () => {
    expect(walletEntryListResponseSchema.parse({ entries: [], nextCursor: null })).toEqual({
      entries: [],
      nextCursor: null,
    });
    const parsed = walletEntryListResponseSchema.parse({
      entries: [],
      nextCursor: null,
      importedEntries: [
        {
          id: 'a',
          customerId: 'c',
          source: 'MIRZA',
          origin: 'WALLET_TRANSACTION',
          sourceRef: 'wallet-tx:1',
          direction: null,
          amount: '0',
          signedAmount: '0',
          currency: 'IRT',
          rawKind: null,
          note: null,
          occurredAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      importedNextCursor: null,
    });
    expect(parsed.importedEntries?.[0]?.source).toBe('MIRZA');
  });
});
