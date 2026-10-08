import { describe, expect, it } from 'vitest';
import {
  PAYMENT_METHODS,
  PAYMENT_OPS_QUEUES,
  PAYMENT_SITUATIONS,
  PAYMENT_SITUATION_CUSTOMER_TEMPLATES,
  PAYMENT_STATES,
  REFUND_REFUSAL_REASONS,
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
  receiptFiled: false,
  providerReviewOpened: false,
  resolvedByAdmin: false,
  receiptDisposition: null,
  invoiceCreation: null,
  queues: [],
  refundOpen: false,
  refundCompleted: false,
  refundRemaining: true,
  // What the refund service answers for a payment that is not CONFIRMED (CX4).
  refundRefusal: 'PAYMENT_NOT_SETTLED',
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
  RECEIPT_UNDER_REVIEW: ['PENDING'],
  PROVIDER_REVIEW: ['PENDING'],
  OUTCOME_UNKNOWN: ['UNKNOWN'],
  MISMATCH: ['UNKNOWN'],
  PARTIAL: ['PENDING', 'UNKNOWN', 'FAILED', 'EXPIRED', 'CANCELLED'],
  LATE_COMPLETION: ['PENDING', 'UNKNOWN', 'FAILED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: ['CONFIRMED'],
  REFUND_IN_PROGRESS: ['CONFIRMED'],
  // A refund is money back on the wallet whether the payment confirmed or failed (OQ-TPTG-17).
  REFUNDED: ['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'],
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
        for (const [customerSignalled, receiptFiled] of [
          [false, false],
          [true, false],
          [true, true],
        ] as const) {
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
                    for (const refundRefusal of [null, 'DELIVERY_IN_PROGRESS'] as const) {
                      yield {
                        state,
                        method,
                        topup: false,
                        refundRefusal,
                        customerSignalled,
                        receiptFiled,
                        refundRemaining: !refundCompleted,
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
      ['RECEIPT_UNDER_REVIEW', { customerSignalled: true, receiptFiled: true }],
      // A late approval while still PENDING is money at the provider (review M1).
      [
        'LATE_COMPLETION',
        { method: 'GATEWAY', invoiceCreation: 'CREATED', queues: ['PENDING', 'LATE_COMPLETION'] },
      ],
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
      ['REJECTED', { state: 'FAILED', resolvedByAdmin: true, receiptDisposition: 'REJECTED' }],
      ['FAILED', { state: 'FAILED', method: 'GATEWAY' }],
      // An operator's reconciliation of a gateway payment is not a receipt rejection (CX4).
      ['FAILED', { state: 'FAILED', method: 'GATEWAY', resolvedByAdmin: true }],
      // Reconciled FAILED and refunded to the wallet (OQ-TPTG-17): money went back (M2).
      [
        'REFUNDED',
        { state: 'FAILED', method: 'GATEWAY', resolvedByAdmin: true, refundCompleted: true },
      ],
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
            // Waiting, or sending the receipt of the transfer already made — never paying.
            (['CLAIMED', 'POSSIBLY', 'PARTIALLY', 'AT_PROVIDER'].includes(g.money) &&
              !['WAIT_DO_NOT_PAY_AGAIN', 'SEND_RECEIPT'].includes(g.customer)) ||
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
                g.situation === 'RECEIPT_UNDER_REVIEW' ||
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

  it('asks nobody to review a claim that has no receipt, and a reviewer to review one that has (CX2)', () => {
    const claim = paymentSituationOf(facts({ customerSignalled: true }));
    expect(claim).toMatchObject({
      situation: 'CUSTOMER_SIGNALLED',
      customer: 'SEND_RECEIPT',
      actions: [],
      needsAction: false,
    });
    const receipt = paymentSituationOf(facts({ customerSignalled: true, receiptFiled: true }));
    expect(receipt).toMatchObject({
      situation: 'RECEIPT_UNDER_REVIEW',
      customer: 'WAIT_DO_NOT_PAY_AGAIN',
      actions: ['REVIEW_RECEIPT_IN_TELEGRAM'],
      needsAction: true,
    });
  });

  it('never tells an operator "pay within the window" for a late approval still PENDING (M1)', () => {
    const late = paymentSituationOf(
      facts({ method: 'GATEWAY', invoiceCreation: 'CREATED', queues: ['LATE_COMPLETION'] }),
    );
    expect(late).toMatchObject({
      situation: 'LATE_COMPLETION',
      money: 'AT_PROVIDER',
      customer: 'WAIT_DO_NOT_PAY_AGAIN',
      // Its exit is the expiry sweep: not work for a person (the drain rule).
      needsAction: false,
    });
  });

  it('calls a reconciled gateway failure FAILED and money refunded to the wallet REFUNDED (CX4, M2)', () => {
    const reconciled = paymentSituationOf(
      facts({ state: 'FAILED', method: 'GATEWAY', resolvedByAdmin: true }),
    );
    expect(reconciled.situation).toBe('FAILED');
    const returned = paymentSituationOf(
      facts({ state: 'FAILED', method: 'GATEWAY', resolvedByAdmin: true, refundCompleted: true }),
    );
    expect(returned).toMatchObject({
      situation: 'REFUNDED',
      money: 'RETURNED',
      customer: 'NOTHING',
    });
    expect(returned.actions).toEqual([]);
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

  it('offers a refund exactly where the refund service would not refuse one (review of PR #248, CX4)', () => {
    const confirmed = (over: Partial<PaymentSituationFacts>) =>
      paymentSituationOf(
        facts({ state: 'CONFIRMED', method: 'MANUAL_TRANSFER', refundRefusal: null, ...over }),
      ).actions;
    expect(confirmed({ refundRefusal: null })).toEqual(['ISSUE_REFUND']);
    // Every refusal the service can answer withholds the action — the two the guide's own copy
    // used to miss (a delivery still in progress, refunds in another currency) included.
    for (const reason of REFUND_REFUSAL_REASONS) {
      expect(confirmed({ refundRefusal: reason }), reason).toEqual([]);
      expect(
        confirmed({ refundRefusal: reason, refundCompleted: true, refundRemaining: true }),
        reason,
      ).toEqual([]);
    }
    // Nothing left after a full refund: the guide does not promise one the server refuses.
    expect(confirmed({ refundCompleted: true, refundRemaining: false })).toEqual([]);
    expect(
      everyRow().filter(
        ({ f, g }) =>
          g.actions.includes('ISSUE_REFUND') && (f.refundRefusal !== null || !f.refundRemaining),
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
