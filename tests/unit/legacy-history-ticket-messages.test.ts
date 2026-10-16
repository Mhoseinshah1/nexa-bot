import { describe, expect, it } from 'vitest';
import {
  itemOf,
  LegacyHistoryReadService,
} from '../../apps/api/src/modules/platform/legacy-history/application/legacy-history-read.service';
import type { LegacyHistoryRecordRow } from '../../apps/api/src/modules/platform/legacy-history/application/ports';

/**
 * A ticket message names no customer: Customer 360 reads it through its ticket. The join is the
 * repository's (SQL, covered by the integration suite); here the service and the item mapping
 * carry the ticket's record id through. SYNTHETIC values only.
 */

const row = (over: Partial<LegacyHistoryRecordRow> = {}): LegacyHistoryRecordRow => ({
  id: 'rec-msg-1',
  nxpkgImportId: 'imp',
  packageImportId: 'pkg',
  recordType: 'ticket_message',
  idempotencyKey: 'legacy:ticket_message:1',
  legacyUserId: null,
  customerId: null,
  occurredAt: null,
  payload: {
    record_type: 'legacy_ticket_message',
    seq: 2,
    ticket_ref: { raw: '1', ticket_exists: true },
    fields_raw: { text: 'synthetic text' },
  },
  createdAt: new Date('2025-01-01T00:00:00Z'),
  ...over,
});

describe('itemOf for a ticket message', () => {
  it('carries the ticket record id and still redacts the text', () => {
    const item = itemOf(row({ ticketRecordId: 'rec-ticket-1' }), false);
    expect(item.ticketRecordId).toBe('rec-ticket-1');
    expect(item.summary).toMatchObject({ seq: 2 });
    expect(JSON.stringify(item.payload)).not.toContain('synthetic text');
  });

  it('has no ticketRecordId key for other record types', () => {
    const item = itemOf(row({ recordType: 'payment', payload: { record_type: 'x' } }), false);
    expect('ticketRecordId' in item).toBe(false);
  });

  it('passes a null (no ticket matched) through as null', () => {
    expect(itemOf(row({ ticketRecordId: null }), true).ticketRecordId).toBeNull();
  });
});

describe('forCustomer', () => {
  it('lists the customer ticket messages with their ticket and counts them by type', async () => {
    const calls: unknown[] = [];
    const service = new LegacyHistoryReadService({
      repository: {
        countsForCustomer: async () => new Map([['ticket_message', 1]]),
        listForCustomer: async (_scope: unknown, customer: unknown) => {
          calls.push(customer);
          return [row({ ticketRecordId: 'rec-ticket-1' })];
        },
      } as never,
      customers: { findById: async () => ({ id: 'c1', telegramUserId: '7000000001' }) },
      guard: {
        check: async () => undefined,
        permissionsOf: async () => new Set(['legacy.history.view']),
      } as never,
      audit: { record: async () => undefined } as never,
    });
    const page = await service.forCustomer(
      { tenantId: 't1' } as never,
      {} as never,
      '019210ab-cdef-7012-8345-6789abcdef01',
      {},
    );
    expect(page.byType).toEqual([{ recordType: 'ticket_message', count: 1 }]);
    expect(page.items[0]?.ticketRecordId).toBe('rec-ticket-1');
    expect(calls).toEqual([{ id: 'c1', telegramUserId: '7000000001' }]);
  });
});
