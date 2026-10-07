import { describe, expect, it } from 'vitest';
import {
  PAYMENT_METHODS,
  PAYMENT_OPS_QUEUES,
  PAYMENT_SITUATIONS,
  PAYMENT_SITUATION_CUSTOMER_TEMPLATES,
  PAYMENT_STATES,
  paymentSituationCode,
  paymentNeedsAction,
  paymentSituationOf,
  type PaymentOpsQueue,
  type PaymentSituation,
  type PaymentSituationFacts,
  type PaymentSituationGuide,
  type PaymentState,
} from '@nexa/contracts';
import { CatalogueTranslator } from '@nexa/i18n';

/**
 * Roadmap E1 — the ONE situation classifier (`payment-situations.ts`).
 *
 * What this file defends: distinct accounting states never collapse into one situation;
 * an UNKNOWN is never shown as a failure or as "no money"; every situation where money may
 * have moved tells the customer not to pay again; the operator actions offered are only the
 * commands the services accept the shape of; and every situation's customer sentence is a
 * template key that exists.
 */

const base: PaymentSituationFacts = {
  state: 'PENDING',
  method: 'MANUAL_TRANSFER',
  topup: false,
  customerSignalled: false,
  providerReviewOpened: false,
  resolvedByAdmin: false,
  receiptDisposition: null,
  invoiceCreation: null,
  queues: [],
  refundOpen: false,
  refundCompleted: false,
};

const facts = (over: Partial<PaymentSituationFacts>): PaymentSituationFacts => ({
  ...base,
  ...over,
});

/** The states each situation may be derived from. A situation never spans two money stories. */
const STATES_OF: Readonly<Record<PaymentSituation, readonly PaymentState[]>> = {
  AWAITING_PAYMENT: ['PENDING'],
  INVOICE_NOT_ISSUED: ['PENDING'],
  CUSTOMER_SIGNALLED: ['PENDING'],
  PROVIDER_REVIEW: ['PENDING'],
  OUTCOME_UNKNOWN: ['UNKNOWN'],
  MISMATCH: ['UNKNOWN'],
  PARTIAL: ['PENDING', 'UNKNOWN', 'FAILED', 'EXPIRED', 'CANCELLED'],
  LATE_COMPLETION: ['UNKNOWN', 'FAILED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: ['CONFIRMED'],
  REFUND_IN_PROGRESS: ['CONFIRMED'],
  REFUNDED: ['CONFIRMED'],
  CREDITED_TO_WALLET: ['FAILED'],
  REJECTED: ['FAILED'],
  FAILED: ['FAILED'],
  EXPIRED: ['EXPIRED'],
  CANCELLED: ['CANCELLED'],
};

/**
 * Every combination of the facts that change the answer: each value the classifier branches
 * on (one creation state that issues no invoice, one that does; the credited disposition and
 * another), every state, method and queue mix.
 */
function* everyFacts(): Generator<PaymentSituationFacts> {
  const queueSets: PaymentOpsQueue[][] = [
    [],
    ['MISMATCH'],
    ['PARTIAL'],
    ['LATE_COMPLETION'],
    ['PARTIAL', 'MISMATCH'],
    ['LATE_COMPLETION', 'PARTIAL'],
  ];
  for (const state of PAYMENT_STATES) {
    for (const method of PAYMENT_METHODS) {
      for (const queues of queueSets) {
        for (const customerSignalled of [false, true]) {
          for (const providerReviewOpened of [false, true]) {
            for (const resolvedByAdmin of [false, true]) {
              for (const receiptDisposition of [null, 'CREDITED_TO_WALLET', 'REJECTED'] as const) {
                for (const invoiceCreation of [null, 'CREATED', 'CREATE_UNKNOWN'] as const) {
                  for (const [refundOpen, refundCompleted] of [
                    [false, false],
                    [true, false],
                    [false, true],
                    [true, true],
                  ] as const) {
                    for (const topup of [false, true]) {
                      yield {
                        state,
                        method,
                        topup,
                        customerSignalled,
                        providerReviewOpened,
                        resolvedByAdmin,
                        receiptDisposition,
                        invoiceCreation,
                        queues,
                        refundOpen,
                        refundCompleted,
                      };
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

/** Every combination and its guide, classified once for the whole file. */
let rows:
  readonly { readonly f: PaymentSituationFacts; readonly g: PaymentSituationGuide }[] | null = null;
function everyRow() {
  rows ??= [...everyFacts()].map((f) => ({ f, g: paymentSituationOf(f) }));
  return rows;
}

describe('the payment situation classifier', () => {
  it('names each situation from the facts that define it', () => {
    const cases: [PaymentSituation, Partial<PaymentSituationFacts>][] = [
      ['AWAITING_PAYMENT', {}],
      ['INVOICE_NOT_ISSUED', { method: 'GATEWAY', invoiceCreation: 'CREATE_UNKNOWN' }],
      ['INVOICE_NOT_ISSUED', { method: 'GATEWAY', invoiceCreation: 'CREATE_FAILED' }],
      ['AWAITING_PAYMENT', { method: 'GATEWAY', invoiceCreation: 'CREATING' }],
      ['CUSTOMER_SIGNALLED', { customerSignalled: true }],
      ['PROVIDER_REVIEW', { method: 'GATEWAY', providerReviewOpened: true }],
      ['OUTCOME_UNKNOWN', { state: 'UNKNOWN', method: 'GATEWAY' }],
      ['MISMATCH', { state: 'UNKNOWN', method: 'GATEWAY', queues: ['MISMATCH'] }],
      ['PARTIAL', { state: 'UNKNOWN', method: 'GATEWAY', queues: ['PARTIAL', 'MISMATCH'] }],
      ['LATE_COMPLETION', { state: 'UNKNOWN', method: 'GATEWAY', queues: ['LATE_COMPLETION'] }],
      ['LATE_COMPLETION', { state: 'EXPIRED', method: 'GATEWAY', queues: ['LATE_COMPLETION'] }],
      ['PARTIAL', { state: 'FAILED', method: 'GATEWAY', queues: ['PARTIAL'] }],
      ['CONFIRMED', { state: 'CONFIRMED' }],
      ['REFUND_IN_PROGRESS', { state: 'CONFIRMED', refundOpen: true, refundCompleted: true }],
      ['REFUNDED', { state: 'CONFIRMED', refundCompleted: true }],
      [
        'CREDITED_TO_WALLET',
        { state: 'FAILED', resolvedByAdmin: true, receiptDisposition: 'CREDITED_TO_WALLET' },
      ],
      ['REJECTED', { state: 'FAILED', resolvedByAdmin: true }],
      ['FAILED', { state: 'FAILED', method: 'GATEWAY' }],
      ['EXPIRED', { state: 'EXPIRED' }],
      ['CANCELLED', { state: 'CANCELLED' }],
    ];
    for (const [expected, over] of cases) {
      expect(paymentSituationCode(facts(over)), JSON.stringify(over)).toBe(expected);
    }
    // Every member is reachable from some row.
    expect(new Set(cases.map(([one]) => one))).toEqual(new Set(PAYMENT_SITUATIONS));
  });

  it('never merges accounting states: each situation comes only from its own states', () => {
    const rows = everyRow();
    expect(rows.length).toBeGreaterThan(10_000);
    expect(
      rows
        .filter(({ f, g }) => !STATES_OF[g.situation].includes(f.state))
        .map(({ f, g }) => `${f.state} → ${g.situation}`),
    ).toEqual([]);
  });

  it('never shows an UNKNOWN as a failure, as no money, or as something to pay again', () => {
    const unknown = everyRow().filter(({ f }) => f.state === 'UNKNOWN');
    expect(unknown.length).toBeGreaterThan(0);
    expect(
      unknown.filter(
        ({ g }) =>
          ['FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED'].includes(g.situation) ||
          g.money === 'NO' ||
          g.customer !== 'WAIT_DO_NOT_PAY_AGAIN' ||
          !g.needsAction,
      ),
    ).toEqual([]);
  });

  it('tells the customer not to pay again wherever money may already have moved', () => {
    expect(
      everyRow()
        .filter(
          ({ g }) =>
            (['CLAIMED', 'POSSIBLY', 'PARTIALLY', 'AT_PROVIDER'].includes(g.money) &&
              g.customer !== 'WAIT_DO_NOT_PAY_AGAIN') ||
            (g.customer === 'MAY_PAY_AGAIN' && g.money !== 'NO'),
        )
        .map(({ g }) => g.situation),
    ).toEqual([]);
  });

  it('keeps a credited receipt apart from a rejection, though both are FAILED by an administrator', () => {
    const credited = paymentSituationOf(
      facts({ state: 'FAILED', resolvedByAdmin: true, receiptDisposition: 'CREDITED_TO_WALLET' }),
    );
    const rejected = paymentSituationOf(
      facts({ state: 'FAILED', resolvedByAdmin: true, receiptDisposition: 'REJECTED' }),
    );
    expect(credited.situation).toBe('CREDITED_TO_WALLET');
    expect(credited.money).toBe('TO_WALLET');
    expect(credited.customer).toBe('NOTHING');
    expect(rejected.situation).toBe('REJECTED');
    expect(rejected.money).toBe('NO');
    expect(rejected.customer).toBe('MAY_PAY_AGAIN');
  });

  it('puts what the provider said after the end above how the attempt ended', () => {
    for (const state of ['FAILED', 'EXPIRED', 'CANCELLED'] as const) {
      const late = paymentSituationOf(
        facts({ state, method: 'GATEWAY', resolvedByAdmin: true, queues: ['LATE_COMPLETION'] }),
      );
      expect(late.situation).toBe('LATE_COMPLETION');
      expect(late.money).toBe('AT_PROVIDER');
    }
  });

  it('marks for action exactly what an existing command can resolve, so the queue drains', () => {
    expect(
      everyRow()
        .filter(
          ({ f, g }) =>
            g.needsAction !== paymentNeedsAction(g.situation, f.state) ||
            g.needsAction !==
              (f.state === 'UNKNOWN' ||
                g.situation === 'CUSTOMER_SIGNALLED' ||
                g.situation === 'REFUND_IN_PROGRESS') ||
            // A situation that needs a person always names at least one thing they can do.
            (g.needsAction && g.actions.length === 0),
        )
        .map(({ f, g }) => `${f.state}/${g.situation}`),
    ).toEqual([]);
    // Late money on an attempt that already ended has no domain exit (OQ-WP11A-03): it is
    // shown with what exists, and kept OUT of the work queue, which would never drain of it.
    const late = paymentSituationOf(
      facts({ state: 'EXPIRED', method: 'GATEWAY', queues: ['LATE_COMPLETION'] }),
    );
    expect(late.situation).toBe('LATE_COMPLETION');
    expect(late.needsAction).toBe(false);
    expect(late.actions.length).toBeGreaterThan(0);
  });

  it('offers reconciliation only on an UNKNOWN gateway payment', () => {
    expect(
      everyRow()
        .filter(({ f, g }) => {
          const eligible = f.state === 'UNKNOWN' && f.method === 'GATEWAY';
          const reconciles =
            g.actions.includes('RECONCILE') || g.actions.includes('ASK_PROVIDER_AGAIN');
          return (reconciles && !eligible) || (eligible && !g.actions.includes('RECONCILE'));
        })
        .map(({ f, g }) => `${f.state}/${f.method}/${g.situation}`),
    ).toEqual([]);
  });

  it('offers a refund only where a channel exists and an order was bought', () => {
    const order = (method: (typeof PAYMENT_METHODS)[number]) =>
      paymentSituationOf(facts({ state: 'CONFIRMED', method })).actions;
    expect(order('WALLET')).toEqual(['ISSUE_REFUND']);
    expect(order('MANUAL_TRANSFER')).toEqual(['ISSUE_REFUND']);
    // REFUND_METHOD_SUPPORT: a gateway refund has no adapter — nothing fake is offered.
    expect(order('GATEWAY')).toEqual([]);
    // A top-up's money is already on the wallet (TOPUP_CREDITED_TO_WALLET).
    expect(
      paymentSituationOf(facts({ state: 'CONFIRMED', method: 'MANUAL_TRANSFER', topup: true }))
        .actions,
    ).toEqual([]);
    expect(
      everyRow().filter(
        ({ f, g }) =>
          g.actions.includes('ISSUE_REFUND') &&
          (f.state !== 'CONFIRMED' || f.method === 'GATEWAY' || f.topup),
      ),
    ).toEqual([]);
  });

  it('sends late or partial money on a closed payment to the provider and the wallet adjustment, flagged undecided', () => {
    const late = paymentSituationOf(
      facts({ state: 'EXPIRED', method: 'GATEWAY', queues: ['LATE_COMPLETION'] }),
    );
    expect(late.actions).toEqual(['VERIFY_AT_PROVIDER', 'MANUAL_WALLET_ADJUSTMENT']);
    const unknownLate = paymentSituationOf(
      facts({ state: 'UNKNOWN', method: 'GATEWAY', queues: ['LATE_COMPLETION'] }),
    );
    expect(unknownLate.actions).not.toContain('MANUAL_WALLET_ADJUSTMENT');
  });

  it('has a template key for every situation it says the customer was told, and says why when none', () => {
    const translator = new CatalogueTranslator('fa');
    for (const situation of PAYMENT_SITUATIONS) {
      const keys = PAYMENT_SITUATION_CUSTOMER_TEMPLATES[situation];
      for (const key of keys) expect(translator.has(key), key).toBe(true);
    }
    const silent = PAYMENT_SITUATIONS.filter(
      (one) => PAYMENT_SITUATION_CUSTOMER_TEMPLATES[one].length === 0,
    );
    expect(silent.sort()).toEqual(['LATE_COMPLETION', 'REFUND_IN_PROGRESS']);
  });

  it('is total over the queue vocabulary it reads, NEEDS_ACTION included', () => {
    expect(PAYMENT_OPS_QUEUES).toContain('NEEDS_ACTION');
    // The classifier reads three facets from the queues; a queue the classifier does not
    // read cannot change its answer.
    const plain = paymentSituationCode(facts({ state: 'UNKNOWN', method: 'GATEWAY' }));
    for (const queue of PAYMENT_OPS_QUEUES) {
      if (['MISMATCH', 'PARTIAL', 'LATE_COMPLETION'].includes(queue)) continue;
      expect(
        paymentSituationCode(facts({ state: 'UNKNOWN', method: 'GATEWAY', queues: [queue] })),
      ).toBe(plain);
    }
  });
});
