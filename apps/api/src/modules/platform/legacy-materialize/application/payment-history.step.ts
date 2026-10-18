import { CURRENCY_CODES, type PaymentMethod, type PaymentState } from '@nexa/contracts';
import {
  applyPlanned,
  at,
  customerOf,
  gap,
  matchPlanned,
  mirzaIdOf,
  mirzaInstant,
  parseMinor,
  sourceRefOf,
  text,
  write,
  type HistoryRecord,
  type MaterializeDeps,
  type Planned,
  type PlannedStep,
  type PlannedWrite,
} from './materialize-support.js';
import type {
  ExactMatchRow,
  MaterializeContext,
  MaterializeStep,
  MaterializeStepOutcome,
} from './ports.js';
import type { PlannedRepository } from './materialize-support.js';

/**
 * Mirza `Payment_report` into `payments` (plan §3, §5-2), as HISTORY.
 *
 * A row written here is a record that a payment existed, and does nothing else. It is
 * written by repository and never through `PaymentService`: no wallet credit, no order
 * settlement, no outbox event, no notification, no gateway call. Its state is terminal, so no
 * sweep (expiry, gateway inquiry, reminder) ever picks it up, and its evidence kind is
 * `LEGACY_IMPORT`, which the reports do not count as NEXA revenue.
 *
 * - Mirza `paid` -> CONFIRMED at the original time; `reject` -> FAILED; `expire` -> EXPIRED;
 *   a payment still waiting (`Unpaid`, `waiting`) -> EXPIRED, because the installation never
 *   holds an open historical payment.
 * - The method is mapped onto the three NEXA methods (a card transfer or an offline crypto
 *   transfer -> MANUAL_TRANSFER; a gateway, crypto gateway or Stars -> GATEWAY; an unknown
 *   method -> MANUAL_TRANSFER, which claims no gateway). The Mirza method is kept in the
 *   row's note; the full record stays in the archive.
 * - `order_id` is NULL. The converter proves no relation between a payment and an invoice
 *   (`id_order` is a payment reference, never an invoice key), so none is invented; a row
 *   with no order is the shape of a wallet top-up, which is what the CHECKs and indexes allow.
 */

export const PAYMENT_HISTORY_STEP = 'payment-history';
export const PAYMENT_SOURCE_REF_PREFIX = 'payment';

/** Mirza's `Payment_Method` (as the converter normalised it) onto a NEXA method. */
const METHOD_OF: Readonly<Record<string, PaymentMethod>> = {
  CARD_TO_CARD: 'MANUAL_TRANSFER',
  CRYPTO_OFFLINE: 'MANUAL_TRANSFER',
  GATEWAY_AQAYEPARDAKHT: 'GATEWAY',
  GATEWAY_ZARINPAL: 'GATEWAY',
  GATEWAY_VARIZA: 'GATEWAY',
  GATEWAY_RIAL: 'GATEWAY',
  GATEWAY_RIAL_1: 'GATEWAY',
  GATEWAY_RIAL_2: 'GATEWAY',
  GATEWAY_RIAL_3: 'GATEWAY',
  GATEWAY_ABAN: 'GATEWAY',
  CRYPTO_PLISIO: 'GATEWAY',
  CRYPTO_NOWPAYMENTS: 'GATEWAY',
  TELEGRAM_STARS: 'GATEWAY',
};

/**
 * Admin balance adjustments are logged by Mirza in this table, but they are wallet changes
 * (and `low balance by admin` is a DEBIT stored as a positive price). As payments they would
 * read as money received; they stay in the archive, with this reason.
 */
const ADMIN_METHODS: ReadonlySet<string> = new Set([
  'ADMIN_CREDIT_ADJUSTMENT',
  'ADMIN_DEBIT_ADJUSTMENT',
]);

export interface PaymentWrite extends PlannedWrite {
  readonly customerId: string;
  readonly state: Extract<PaymentState, 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'EXPIRED'>;
  readonly method: PaymentMethod;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly createdAt: Date;
  /** `confirmed_at` for CONFIRMED, `resolved_at` otherwise. */
  readonly settledAt: Date;
  readonly note: string;
}

export function paymentFingerprint(p: Omit<PaymentWrite, 'fingerprint' | 'sourceRef'>): string {
  return [
    p.customerId,
    p.state,
    p.method,
    p.amountMinor.toString(),
    p.currency,
    p.createdAt.toISOString(),
    p.settledAt.toISOString(),
  ].join('|');
}

/** A Mirza token reduced to what is safe in a note: letters, digits, `_`, `-`, bounded. */
const token = (value: unknown, max: number): string | null => {
  const t = text(value);
  if (t === null) return null;
  const cleaned = t.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
};

function stateOf(outcome: string | null, reason: string | null): PaymentWrite['state'] | null {
  switch (outcome) {
    case 'SUCCEEDED':
      return 'CONFIRMED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return reason === 'EXPIRED_UNPAID' ? 'EXPIRED' : 'CANCELLED';
    // Decision: no open historical payment, ever. A payment Mirza never saw paid is over.
    case 'PENDING':
      return 'EXPIRED';
    default:
      // A status outside Mirza's evidenced vocabulary: its outcome is not guessed.
      return null;
  }
}

export function planPayment(
  record: HistoryRecord,
  customers: ReadonlyMap<string, string>,
): Planned<PaymentWrite> {
  const amount = parseMinor(at(record.payload, 'amount', 'amount_minor'));
  const sum = amount !== null && amount > 0n ? amount : 0n;
  const customerId = customerOf(record, customers);
  const id = mirzaIdOf(record, 'payment_id');
  const sourceRef = id === null ? null : sourceRefOf(PAYMENT_SOURCE_REF_PREFIX, id);
  if (sourceRef === null) return gap('SOURCE_ID_UNUSABLE', sum);
  if (customerId === null) return gap('CUSTOMER_NOT_IMPORTED', sum);
  const method = text(at(record.payload, 'method', 'normalized'));
  if (method !== null && ADMIN_METHODS.has(method)) {
    return gap('ADMIN_ADJUSTMENT_NOT_A_PAYMENT', sum);
  }
  if (amount === null) return gap('UNPARSEABLE_AMOUNT', 0n);
  if (amount <= 0n) return gap('NON_POSITIVE_AMOUNT', sum);
  const currency = text(at(record.payload, 'amount', 'currency'));
  if (currency === null || !(CURRENCY_CODES as readonly string[]).includes(currency)) {
    return gap('UNSUPPORTED_CURRENCY', sum);
  }
  const state = stateOf(
    text(at(record.payload, 'status', 'outcome')),
    text(at(record.payload, 'status', 'reason')),
  );
  if (state === null) return gap('STATUS_UNKNOWN', sum);
  const createdAt =
    mirzaInstant(at(record.payload, 'times', 'created', 'unix')) ??
    mirzaInstant(at(record.payload, 'times', 'created', 'local'));
  if (createdAt === null) return gap('UNPARSEABLE_TIME', sum);
  // The creation time is not the paid time; the last update is the nearest thing Mirza keeps.
  // It is used only when it is readable and not before the creation.
  const updated =
    mirzaInstant(at(record.payload, 'times', 'updated', 'unix')) ??
    mirzaInstant(at(record.payload, 'times', 'updated', 'local'));
  const settledAt =
    updated !== null && updated.getTime() >= createdAt.getTime() ? updated : createdAt;

  const rawMethod = token(at(record.payload, 'method', 'raw'), 40);
  const rawStatus = token(at(record.payload, 'status', 'raw'), 20);
  const note =
    `legacy method=${method ?? 'UNKNOWN'}` +
    (method === null || method === 'UNKNOWN' ? ` raw=${rawMethod ?? 'NULL'}` : '') +
    ` status=${rawStatus ?? 'NULL'}`;
  const fields = {
    customerId,
    state,
    method: (method !== null ? METHOD_OF[method] : undefined) ?? 'MANUAL_TRANSFER',
    amountMinor: amount,
    currency,
    createdAt,
    settledAt,
    note,
  } as const;
  return write<PaymentWrite>(
    { sourceRef, fingerprint: paymentFingerprint(fields), ...fields },
    amount,
  );
}

export class PaymentHistoryStep implements MaterializeStep {
  readonly name = PAYMENT_HISTORY_STEP;
  private readonly step: PlannedStep<PaymentWrite>;

  constructor(
    private readonly deps: MaterializeDeps,
    repository: PlannedRepository<PaymentWrite>,
  ) {
    this.step = {
      name: PAYMENT_HISTORY_STEP,
      recordType: 'payment',
      repository,
      plan: async (records, ctx, tx) => {
        const customers = await deps.records.customersByLegacyUser(
          ctx.scope,
          records.flatMap((r) => (r.legacyUserId === null ? [] : [r.legacyUserId])),
          tx,
        );
        return records.map((record) => planPayment(record, customers));
      },
    };
  }

  apply(ctx: MaterializeContext): Promise<MaterializeStepOutcome> {
    return applyPlanned(this.deps, this.step, ctx);
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    return [
      await matchPlanned(this.deps, this.step, ctx, {
        mirzaTable: 'Payment_report',
        nexaTable: 'payments',
        hasAmount: true,
      }),
    ];
  }
}
