import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_HISTORY_RECORD_TYPES, type LegacyHistoryRecordType } from '@nexa/contracts';
import { openNxpkg } from '../../apps/api/src/infrastructure/nxpkg';
import {
  planHistoryFiles,
  readHistoryRecord,
  summaryOf,
} from '../../apps/api/src/modules/platform/legacy-history/application/record-map';
import {
  HISTORY_PUBLIC_FIELDS,
  fitsKind,
  publicFieldKind,
  redactHistoryPayload,
} from '../../apps/api/src/modules/platform/legacy-history/application/redaction';

/**
 * Mirza `.nxpkg` importer — the history read's non-PII projection is an ALLOWLIST (review
 * finding M6). Every record of the converter's SYNTHETIC fixture package is projected and
 * searched for anything personal; no real value anywhere.
 */

const FIXTURES = join(__dirname, '../fixtures/nxpkg');
type Rec = Record<string, unknown>;

/** Every history record of the fixture package, by archive type. */
const records = new Map<LegacyHistoryRecordType, Rec[]>();
/** Every Telegram id the package names anywhere (customers, owners, transfers, handlers…). */
const telegramIds = new Set<string>();
let root = '';

const TELEGRAM_KEY = /telegram|^raw_id$|^source_user_id$|user_id$|^agent_id$|^id_user$/;
function collectIds(value: unknown, key: string | null): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, key);
  } else if (value !== null && typeof value === 'object') {
    const parentIsPerson = key !== null && /owner|customer|requester|referr|referee/.test(key);
    for (const [k, v] of Object.entries(value as Rec)) {
      if (parentIsPerson && k === 'raw' && typeof v === 'string') telegramIds.add(v);
      collectIds(v, k);
    }
  } else if (key !== null && TELEGRAM_KEY.test(key) && /^\d{6,}$/.test(String(value))) {
    telegramIds.add(String(value));
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'legacy-history-redaction-'));
  const pkg = await openNxpkg(
    join(FIXTURES, 'synthetic-keyfile.nxpkg'),
    { keyFileText: readFileSync(join(FIXTURES, 'synthetic-keyfile.nxkey'), 'utf8') },
    {
      workDir: join(root, 'work'),
      maxPayloadBytes: 64 * 1024 * 1024,
      maxFiles: 1000,
      maxFileBytes: 32 * 1024 * 1024,
    },
  );
  const paths = pkg.files().map((file) => file.path);
  for (const path of paths) {
    if (path.endsWith('.jsonl')) {
      for await (const record of pkg.iterJsonl(path)) collectIds(record, null);
    }
  }
  for (const file of planHistoryFiles(paths).files) {
    let line = 0;
    for await (const record of pkg.iterJsonl(file.path)) {
      line += 1;
      const read = readHistoryRecord(file, line, record);
      const list = records.get(read.historyType) ?? [];
      list.push(read.payload);
      records.set(read.historyType, list);
    }
  }
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/**
 * A synthetic `legacy_wallet_difference` (the fixture has no wallet difference), shaped as
 * `mirza2nexa/modules/wallet_history.py` writes it, personal values included.
 */
const walletDifference = (): Rec => ({
  record_type: 'legacy_wallet_difference',
  schema: 'mirza.wallet_transaction.difference.v1',
  idempotency_key: 'legacy:wallet-difference:7000000013',
  customer: {
    telegram_user_id: '7000000013',
    source_user_id: '7000000013',
    customer_decision: 'IMPORT',
    relation: 'CUSTOMER_IMPORTED',
  },
  features: {
    snapshot_minor: '1323518',
    history_last_balance_after_minor: '1300000',
    delta_snapshot_minus_history_minor: '23518',
    delta_sign: 'POSITIVE',
    abs_delta_minor: '23518',
    transactions: 4,
    last_transaction: { transaction_id: '4', time_kind: 'LOCAL', time: '2025-06-01 23:48:00' },
    groups: { TOPUP: { AFTER: { count: 1, sum_minor: '23518', unparsed_amounts: 0 } } },
    unquantified: [{ kind: 'GIFT_CODE', table: 'Giftcodeconsumed', pk: '7000000013' }],
    sum_after_all_groups_minor: '23518',
    exact_matches: [{ table: 'Payment_report', pk: '7000000099' }],
    order: { verdict: 'MISMATCH', note: 'free text about 7000000013' },
    evidence_sources_complete: true,
  },
  cause: 'TOPUP_AFTER_HISTORY',
  certainty: 'PROVEN',
  proposed_action: 'ARCHIVE_ONLY',
  evidence_refs: [
    { table: 'wallet_transaction', pk: '4', role: 'LAST_HISTORY_ROW' },
    { table: 'Payment_report', pk: null, pk_ref: 'pk:3b92193d', role: 'TOPUP_AFTER' },
  ],
  evidence_refs_not_listed: 0,
  snapshot_is_the_opening_figure: true,
  opening_balance_changed: false,
  affects_wallet: false,
  applied_to_balance: false,
  applies_to_live_state: false,
  provenance: { source_table: 'wallet_transaction', source_pk: null, row_checksum: 'ab' },
});

/** Every scalar leaf of a projection, with its dotted path (`[]` for array elements). */
function leaves(value: unknown, path = ''): [string, unknown][] {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, `${path}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Rec).flatMap(([k, v]) =>
      leaves(v, path === '' ? k : `${path}.${k}`),
    );
  }
  return [[path, value]];
}

/** Paths that hold free text or a name in the converter's records. */
const FREE_TEXT = new Set([
  'admin_answer',
  'admin_note',
  'customer_text',
  'description',
  'reason',
  'label',
  'label_normalized',
  'name',
  'name_panel',
  'department_name',
  'title_proposal',
  'tracking',
  'username',
  'service_username',
  'panel_account_username',
  'sold_to_panel_username',
  'rejection_note.text',
  'details.text',
  'times.zone',
  'created_at.zone',
]);

describe('the non-PII projection of the fixture package', () => {
  it('covers every record type (wallet_difference synthesised: the fixture has none)', () => {
    records.set('wallet_difference', [walletDifference()]);
    expect([...records.keys()].sort()).toEqual([...LEGACY_HISTORY_RECORD_TYPES].sort());
    expect(Object.keys(HISTORY_PUBLIC_FIELDS).sort()).toEqual(
      [...LEGACY_HISTORY_RECORD_TYPES].sort(),
    );
    // The walk is only meaningful if the package really carries the M6 leaks.
    expect(telegramIds.size).toBeGreaterThan(20);
    const ownership = JSON.stringify(records.get('service_ownership'));
    expect(ownership).toContain('from_telegram_user_id');
    expect(JSON.stringify(records.get('support_message'))).toContain('admin_answer');
    expect(JSON.stringify(records.get('payment'))).toContain('telegram_message_id');
  });

  it.each([...LEGACY_HISTORY_RECORD_TYPES])(
    '%s: no Telegram id, no free text and no *.raw survives',
    (type) => {
      const list = type === 'wallet_difference' ? [walletDifference()] : (records.get(type) ?? []);
      expect(list.length).toBeGreaterThan(0);
      for (const record of list) {
        const { payload, redacted } = redactHistoryPayload(type, record);
        const summary = summaryOf(type, payload);
        const serialised = JSON.stringify({ payload, summary });

        // No Telegram id the package names, anywhere (amounts and keys included).
        for (const id of telegramIds) expect(serialised).not.toContain(id);

        for (const [path, value] of leaves(payload)) {
          if (value === null) continue; // an absent value names nobody
          const kind = publicFieldKind(type, path);
          // Every surviving leaf is allowlisted for this type and has its kind's shape.
          expect(kind, `${type} ${path}`).not.toBeNull();
          expect(fitsKind(kind!, value), `${type} ${path}`).toBe(true);
          // Six digits or more only as a number the kind promises: an amount, count or time.
          if (/\d{6,}/.test(String(value))) {
            expect(['amount', 'count', 'instant'], `${type} ${path}`).toContain(kind);
          }
          // No raw source value and no raw columns.
          for (const segment of path.replace(/\[\]/g, '').split('.')) {
            expect(segment, `${type} ${path}`).not.toMatch(/^raw$|_raw$|^fields$|^fields_raw$/);
          }
          expect(FREE_TEXT.has(path), `${type} ${path}`).toBe(false);
          // A string that survives is a token: no spaces, no non-Latin text.
          if (typeof value === 'string' && kind !== 'instant') {
            expect(value, `${type} ${path}`).toMatch(/^[A-Za-z0-9_.+:/-]*$/);
          }
        }
        for (const [, value] of Object.entries(summary)) {
          if (typeof value === 'string' && /\d{6,}/.test(value)) {
            expect(value).toMatch(/^-?\d+$/); // an amount, never an id-bearing token
          }
        }
        // Nothing listed as dropped survived (an array element path may be dropped in one
        // element and kept in another, so only the paths outside arrays are compared).
        for (const path of redacted.filter((p) => !p.includes('[]'))) {
          expect(leaves(payload).some(([p]) => p === path)).toBe(false);
        }
      }
    },
  );

  it('drops the M6 leaks by name', () => {
    const ownership = records.get('service_ownership') ?? [];
    const withTransfer = ownership.find(
      (r) => Array.isArray(r['transfer_evidence']) && r['transfer_evidence'].length > 0,
    )!;
    const own = redactHistoryPayload('service_ownership', withTransfer);
    expect(own.redacted).toEqual(
      expect.arrayContaining([
        'transfer_evidence[].from_telegram_user_id',
        'transfer_evidence[].to_telegram_user_id',
        'provenance.source_pk',
      ]),
    );
    const answered = (records.get('support_message') ?? []).find(
      (r) => r['admin_answer'] !== null,
    )!;
    expect(redactHistoryPayload('support_message', answered).redacted).toEqual(
      expect.arrayContaining(['admin_answer', 'customer_text', 'customer.telegram_user_id']),
    );
    const agentRecord = (records.get('agent_profile') ?? [])[0]!;
    expect(redactHistoryPayload('agent_profile', agentRecord).redacted).toEqual(
      expect.arrayContaining(['provenance.source_pk', 'idempotency_key']),
    );
    const payment = (records.get('payment') ?? []).find(
      (r) => (r['telegram_message_id'] as Rec | null)?.['raw'] != null,
    )!;
    const pay = redactHistoryPayload('payment', payment);
    expect(pay.redacted).toEqual(
      expect.arrayContaining(['telegram_message_id', 'amount.raw', 'status.raw']),
    );
    expect(pay.payload).toMatchObject({
      record_type: 'legacy_payment_history',
      idempotency_key: payment['idempotency_key'],
      status: { outcome: expect.any(String) },
      provenance: { source_table: 'Payment_report' },
    });
    const walletTx = (records.get('wallet_transaction') ?? [])[0]!;
    const wallet = redactHistoryPayload('wallet_transaction', walletTx);
    expect(wallet.redacted).toEqual(
      expect.arrayContaining(['amount.raw', 'balance_after.raw', 'reason', 'username']),
    );
    expect(wallet.payload['amount']).toEqual({
      currency: 'IRT',
      parse_note: 'OK',
      value_minor: (walletTx['amount'] as Rec)['value_minor'],
    });
  });
});

describe('a field the allowlist does not name', () => {
  it('is dropped by default, at any depth, on a known type', () => {
    const base = (records.get('payment') ?? [])[0]!;
    const { payload, redacted } = redactHistoryPayload('payment', {
      ...base,
      brand_new_field: 'SOME_CODE',
      brand_new_note: 'free text 7000000001',
      status: { ...(base['status'] as Rec), invented: 'NEW_STATE' },
      amount: { ...(base['amount'] as Rec), extra: { nested: true } },
      review_codes: ['A_CODE'],
    });
    expect(payload).not.toHaveProperty('brand_new_field');
    expect(payload).not.toHaveProperty('brand_new_note');
    expect(payload).not.toHaveProperty('review_codes');
    expect(payload['status']).not.toHaveProperty('invented');
    expect(payload['amount']).not.toHaveProperty('extra');
    expect(redacted).toEqual(
      expect.arrayContaining([
        'amount.extra',
        'brand_new_field',
        'brand_new_note',
        'review_codes',
        'status.invented',
      ]),
    );
  });

  it('an allowlisted path whose value has the wrong shape is dropped too', () => {
    const { payload, redacted } = redactHistoryPayload('payment', {
      record_type: 'legacy_payment_history',
      status: { outcome: '7000000001' },
      method: { normalized: 'a free text with spaces' },
      amount: { amount_minor: 35000, currency: 'IRT' },
      idempotency_key: 'legacy:agents:profile:7000000000',
      times: { created: { unix: 12 } },
    });
    expect(payload).toEqual({
      record_type: 'legacy_payment_history',
      status: {},
      method: {},
      amount: { currency: 'IRT' },
      times: { created: {} },
    });
    expect(redacted).toEqual([
      'amount.amount_minor',
      'idempotency_key',
      'method.normalized',
      'status.outcome',
      'times.created.unix',
    ]);
  });

  it('the allowlist of another type does not apply', () => {
    const { payload } = redactHistoryPayload('archive_row', {
      record_type: 'legacy_archive_row',
      class: 'REVIEW',
      status: { outcome: 'SUCCEEDED' },
      fields: { id_user: '7000000000' },
    });
    expect(payload).toEqual({ record_type: 'legacy_archive_row', class: 'REVIEW' });
  });
});
