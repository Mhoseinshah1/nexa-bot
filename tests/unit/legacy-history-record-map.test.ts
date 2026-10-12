import { describe, expect, it } from 'vitest';
import { LEGACY_HISTORY_RECORD_TYPES } from '@nexa/contracts';
import {
  EXTRA_LIVE_STATE_FLAGS,
  HISTORY_DIRECTORIES,
  HISTORY_FILES,
  LIVE_STATE_FLAGS,
  LegacyHistoryIngestRefused,
  OPERATIONAL_RECORD_FILES,
  legacyUserIdOf,
  occurredAtOf,
  planHistoryFiles,
  readHistoryRecord,
  summaryOf,
  type PlannedHistoryFile,
} from '../../apps/api/src/modules/platform/legacy-history/application/record-map';
import { redactHistoryPayload } from '../../apps/api/src/modules/platform/legacy-history/application/redaction';

/**
 * Mirza `.nxpkg` importer — the history archive's pure rules (design §5). SYNTHETIC records
 * shaped like the converter's (`mirza2nexa/modules/*.py`); no real value anywhere.
 */

const payments: PlannedHistoryFile = {
  path: 'records/payments.jsonl',
  ...HISTORY_FILES['records/payments.jsonl']!,
};

const payment = (over: Record<string, unknown> = {}) => ({
  record_type: 'legacy_payment_history',
  schema: 'mirza.payment_report.v1',
  idempotency_key: 'legacy:payment:1',
  customer: {
    telegram_user_id: '7000000069',
    source_user_id: '7000000069',
    relation: 'CUSTOMER_IMPORTED',
  },
  amount: { amount_minor: '35000', currency: 'IRT', raw: '35000' },
  status: { outcome: 'SUCCEEDED', raw: 'paid' },
  method: { normalized: 'CARD_TO_CARD', raw: 'cart to cart' },
  times: { created: { local: '2025-01-01T08:02:17', unix: null } },
  provenance: { source_table: 'Payment_report', source_pk: '1' },
  affects_wallet: false,
  creates_payment: false,
  ...over,
});

function refusal(fn: () => unknown): LegacyHistoryIngestRefused {
  try {
    fn();
  } catch (error) {
    if (error instanceof LegacyHistoryIngestRefused) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the history file plan', () => {
  it('maps every archive record type from exactly one file or directory', () => {
    const produced = [...Object.values(HISTORY_FILES), ...Object.values(HISTORY_DIRECTORIES)].map(
      (spec) => spec.historyType,
    );
    expect([...produced].sort()).toEqual([...LEGACY_HISTORY_RECORD_TYPES].sort());
    expect(new Set(produced.map(String)).size).toBe(produced.length);
  });

  it('plans history files, leaves operational ones to the importer and ignores non-record files', () => {
    const plan = planHistoryFiles([
      'manifest.json',
      'reports/coverage.json',
      'source/catalog.json',
      'records/customers.jsonl',
      'records/invoices.jsonl',
      'records/payments.jsonl',
      'records/agents/state.jsonl',
      'records/archive/vs_order.jsonl',
      'records/configuration/PaySetting.jsonl',
    ]);
    expect(plan.files.map((f) => [f.path, f.historyType])).toEqual([
      ['records/agents/state.jsonl', 'agent_state'],
      ['records/archive/vs_order.jsonl', 'archive_row'],
      ['records/configuration/PaySetting.jsonl', 'configuration_row'],
      ['records/payments.jsonl', 'payment'],
    ]);
    expect(plan.operational).toEqual(['records/customers.jsonl', 'records/invoices.jsonl']);
    expect(OPERATIONAL_RECORD_FILES).toContain('records/wallet_opening_balances.jsonl');
  });

  it.each([
    'records/unknown.jsonl',
    'records/agents/other.jsonl',
    'records/archive/nested/x.jsonl',
    'records/archive/../payments.jsonl',
    'records/configuration/x.json',
    'records/support/tickets.json',
  ])('refuses an unknown record file: %s', (path) => {
    const error = refusal(() => planHistoryFiles([path]));
    expect(error.reason).toBe('UNKNOWN_FILE');
    expect(error.code).toBe('NXPKG_UNSUPPORTED_VERSION');
  });
});

describe('one history record', () => {
  it('reads a payment: type, key, legacy user, payload verbatim', () => {
    const raw = payment();
    const read = readHistoryRecord(payments, 1, raw);
    expect(read).toMatchObject({
      historyType: 'payment',
      idempotencyKey: 'legacy:payment:1',
      legacyUserId: '7000000069',
      occurredAt: null,
    });
    expect(read.payload).toBe(raw);
  });

  it('fails closed on an unknown record_type, and on a known one in the wrong file', () => {
    const unknown = refusal(() =>
      readHistoryRecord(payments, 3, payment({ record_type: 'legacy_brand_new_thing' })),
    );
    expect(unknown.reason).toBe('UNKNOWN_RECORD_TYPE');
    expect(unknown.line).toBe(3);
    const misfiled = refusal(() =>
      readHistoryRecord(payments, 1, payment({ record_type: 'legacy_ticket' })),
    );
    expect(misfiled.reason).toBe('RECORD_TYPE_MISMATCH');
    // An operational type is not history either.
    expect(
      refusal(() => readHistoryRecord(payments, 1, payment({ record_type: 'customer' }))).reason,
    ).toBe('UNKNOWN_RECORD_TYPE');
  });

  it.each([
    undefined,
    7,
    '',
    'payment:1',
    'legacy',
    'Legacy:payment:1',
    `legacy:${'x'.repeat(600)}`,
  ])('refuses an idempotency key that is not legacy:… (%s)', (key) => {
    expect(
      refusal(() => readHistoryRecord(payments, 1, payment({ idempotency_key: key }))).reason,
    ).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it.each([...LIVE_STATE_FLAGS, ...EXTRA_LIVE_STATE_FLAGS])(
    'refuses a record whose live-state flag %s is true',
    (flag) => {
      const error = refusal(() => readHistoryRecord(payments, 9, payment({ [flag]: true })));
      expect(error.reason).toBe('LIVE_FLAG');
      expect(error.code).toBe('NXPKG_LIVE_FLAG');
      expect(error.detail).toBe(flag);
      // false, null or absent is fine; only a literal true is refused.
      expect(() => readHistoryRecord(payments, 9, payment({ [flag]: false }))).not.toThrow();
      expect(() => readHistoryRecord(payments, 9, payment({ [flag]: 'true' }))).not.toThrow();
    },
  );

  it('refuses something that is not a record', () => {
    expect(refusal(() => readHistoryRecord(payments, 1, [1, 2])).reason).toBe('RECORD_INVALID');
    expect(refusal(() => readHistoryRecord(payments, 1, null)).reason).toBe('RECORD_INVALID');
    expect(refusal(() => readHistoryRecord(payments, 1, payment({ record_type: 5 }))).reason).toBe(
      'RECORD_INVALID',
    );
  });
});

describe('legacy user and time', () => {
  it('reads the owner field of each type', () => {
    expect(legacyUserIdOf('service_operation', { owner: { telegram_user_id: '7000000037' } })).toBe(
      '7000000037',
    );
    expect(legacyUserIdOf('agent_request', { requester: { telegram_user_id: '5000000401' } })).toBe(
      '5000000401',
    );
    expect(
      legacyUserIdOf('referral', {
        referee: { telegram_user_id: '1' },
        referrer: { telegram_user_id: '2' },
      }),
    ).toBe('1');
    expect(
      legacyUserIdOf('service_ownership', {
        final_owner_telegram_user_id: null,
        current_owner_candidate: { telegram_user_id: '7000000061' },
      }),
    ).toBe('7000000061');
    expect(legacyUserIdOf('service_ownership', { final_owner_telegram_user_id: '42' })).toBe('42');
  });

  it('leaves a malformed or absent id null, and types without a person null', () => {
    expect(legacyUserIdOf('payment', { customer: { telegram_user_id: null } })).toBeNull();
    expect(legacyUserIdOf('payment', { customer: { telegram_user_id: '0123' } })).toBeNull();
    expect(legacyUserIdOf('payment', { customer: { telegram_user_id: 7000000069 } })).toBeNull();
    expect(legacyUserIdOf('payment', {})).toBeNull();
    expect(legacyUserIdOf('panel_registry', { customer: { telegram_user_id: '1' } })).toBeNull();
  });

  it('takes only unambiguous instants: Unix seconds or an ISO time with an offset', () => {
    expect(
      occurredAtOf('payment', { times: { created: { unix: 1_700_000_000 } } })?.toISOString(),
    ).toBe('2023-11-14T22:13:20.000Z');
    expect(occurredAtOf('payment', { times: { created: { unix: '1700000000' } } })).toBeNull();
    expect(occurredAtOf('payment', { times: { created: { unix: 12 } } })).toBeNull();
    expect(occurredAtOf('referral', { attributed_at: '2024-05-01T10:00:00Z' })?.toISOString()).toBe(
      '2024-05-01T10:00:00.000Z',
    );
    expect(
      occurredAtOf('referral', { attributed_at: '2024-05-01T10:00:00+03:30' })?.toISOString(),
    ).toBe('2024-05-01T06:30:00.000Z');
    // A local wall time (the converter's OK_TEHRAN_LOCAL) has no offset: not unambiguous.
    expect(occurredAtOf('referral', { attributed_at: '2024-05-01T10:00:00' })).toBeNull();
    expect(
      occurredAtOf('service_operation', { time: { local: '2025-04-22T14:44:11' } }),
    ).toBeNull();
  });

  it('summarises codes and amounts, never a person', () => {
    expect(summaryOf('payment', payment())).toEqual({
      schema: 'mirza.payment_report.v1',
      sourceTable: 'Payment_report',
      status: 'SUCCEEDED',
      method: 'CARD_TO_CARD',
      amountMinor: '35000',
      currency: 'IRT',
    });
  });
});

describe('redaction', () => {
  it('keeps only the allowlist of the type: Telegram ids, person raws, usernames, free text and raw columns are dropped', () => {
    const { payload, redacted } = redactHistoryPayload('service_ownership', {
      record_type: 'legacy_service_ownership',
      final_owner_telegram_user_id: '7000000061',
      current_owner_candidate: { telegram_user_id: '7000000061', basis: 'INVOICE_ID_USER' },
      ownership_evidence: [
        { telegram_user_id: '7000000000', rule: 'OWN-R1' },
        { telegram_user_id: '7000000001', rule: 'OWN-R2' },
      ],
      owner: { raw: '7000000037', telegram_user_id: '7000000037', role: 'OWNER' },
      status: { raw: 'paid', normalized: 'PAID' },
      panel_account_username: 'syn49',
      customer_text: 'synthetic text',
      fields_raw: { agent_id: '7000000053', amount: '10000' },
      amount: { amount_minor: '20000' },
      ownership_decision: 'CONFIRMED_CURRENT_OWNER',
    });
    expect(payload).toEqual({
      record_type: 'legacy_service_ownership',
      current_owner_candidate: { basis: 'INVOICE_ID_USER' },
      ownership_evidence: [{ rule: 'OWN-R1' }, { rule: 'OWN-R2' }],
      ownership_decision: 'CONFIRMED_CURRENT_OWNER',
    });
    expect(redacted).toEqual([
      'amount',
      'current_owner_candidate.telegram_user_id',
      'customer_text',
      'fields_raw',
      'final_owner_telegram_user_id',
      'owner',
      'ownership_evidence[].telegram_user_id',
      'panel_account_username',
      'status',
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/700000/);
  });
});
