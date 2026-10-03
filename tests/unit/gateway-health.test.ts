import { describe, expect, it } from 'vitest';
import {
  GATEWAY_CONFIGURATION_GAPS,
  GATEWAY_HEALTH_OPERATIONAL_CODES,
  gatewayHealthQuerySchema,
  type PaymentOpsQueueCounts,
} from '@nexa/contracts';
import {
  GATEWAY_CREATE_UNKNOWN_CODE,
  GATEWAY_CARD_CHANGE_UNKNOWN_CODE,
  GATEWAY_IDENTITY_MISMATCH_CODE,
  GATEWAY_LATE_COMPLETION_CODE,
  GATEWAY_MISCONFIGURED_CODE,
  GATEWAY_RECEIPT_UNKNOWN_CODE,
  GATEWAY_REVIEW_UNRESOLVED_CODE,
  GATEWAY_WEBHOOK_UNVERIFIED_CODE,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { configurationGaps } from '../../apps/api/src/modules/commerce/payments/application/payment-gateway.service';
import {
  gatewayHealthSignals,
  gatewayHealthState,
  type GatewayRecordedFacts,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-health.service';

/**
 * Gateway Health's pure parts (program §11): the gap order, the signals, the summary rule,
 * and the operational codes the Notification Center subscribes to.
 */

const ready = {
  provider: 'NOWPAYMENTS' as const,
  credentialSet: true,
  webhookSecretSet: true,
  verifyKeySet: true,
  rateSet: true,
  centralFxOn: true,
  unitRatioSet: true,
  receivingAccountEnabled: true,
};

const nothing: GatewayRecordedFacts = {
  lastInvoiceCreatedAt: null,
  lastInquiryAnsweredAt: null,
  lastInquiryFailure: null,
  lastCreateFailure: null,
  attemptsInWindow: 0,
  attemptsWithProviderError: 0,
  callBudget: null,
  openConditions: [],
  lastReconciliation: null,
};

const zero: PaymentOpsQueueCounts = {
  PENDING: 0,
  UNKNOWN: 0,
  NEEDS_RECONCILIATION: 0,
  MISMATCH: 0,
  PARTIAL: 0,
  LATE_COMPLETION: 0,
  PROVIDER_ERROR: 0,
  REFUND_RELATED: 0,
};

describe('the gateway health operational codes', () => {
  it('are exactly the codes the gateway lane writes — spelled by their producer, none invented', () => {
    expect([...GATEWAY_HEALTH_OPERATIONAL_CODES].sort()).toEqual(
      [
        GATEWAY_MISCONFIGURED_CODE,
        GATEWAY_CREATE_UNKNOWN_CODE,
        GATEWAY_LATE_COMPLETION_CODE,
        GATEWAY_IDENTITY_MISMATCH_CODE,
        GATEWAY_RECEIPT_UNKNOWN_CODE,
        GATEWAY_CARD_CHANGE_UNKNOWN_CODE,
        GATEWAY_REVIEW_UNRESOLVED_CODE,
        GATEWAY_WEBHOOK_UNVERIFIED_CODE,
      ].sort(),
    );
  });
});

describe('configurationGaps', () => {
  it('is empty when everything is set, and lists every gap in the order the enable checks them', () => {
    expect(configurationGaps(ready)).toEqual([]);
    expect(
      configurationGaps({
        ...ready,
        credentialSet: false,
        webhookSecretSet: false,
        verifyKeySet: false,
        rateSet: false,
        centralFxOn: false,
        unitRatioSet: false,
        receivingAccountEnabled: false,
      }),
    ).toEqual([...GATEWAY_CONFIGURATION_GAPS]);
    expect(configurationGaps({ ...ready, verifyKeySet: false, credentialSet: false })).toEqual([
      'CREDENTIAL_MISSING',
      'VERIFY_KEY_MISSING',
    ]);
  });
});

describe('gateway health signals and state', () => {
  const base = {
    provider: 'TONPAYS' as const,
    status: 'ACTIVE' as const,
    gaps: [],
    lastCheck: null,
  };

  it('raises nothing, and says NO_ACTIVITY rather than healthy, for a route with no record', () => {
    const signals = gatewayHealthSignals({ ...base, recorded: nothing, queues: zero });
    expect(signals).toEqual([]);
    expect(
      gatewayHealthState({ status: 'ACTIVE', gaps: [], signals, recorded: nothing, window: null }),
    ).toBe('NO_ACTIVITY');
    const used = { ...nothing, lastInquiryAnsweredAt: new Date() };
    expect(
      gatewayHealthState({ status: 'ACTIVE', gaps: [], signals, recorded: used, window: null }),
    ).toBe('NO_ISSUES_RECORDED');
  });

  it('orders the rule DISABLED > INCOMPLETE > ATTENTION', () => {
    const failing = gatewayHealthSignals({
      ...base,
      lastCheck: { at: new Date('2026-10-03T08:00:00Z'), result: 'refused:INVALID_API_KEY' },
      recorded: nothing,
      queues: zero,
    });
    expect(failing.map((s) => s.kind)).toEqual(['CHECK_FAILED']);
    expect(
      gatewayHealthState({
        status: 'ACTIVE',
        gaps: [],
        signals: failing,
        recorded: nothing,
        window: null,
      }),
    ).toBe('ATTENTION');
    expect(
      gatewayHealthState({
        status: 'ACTIVE',
        gaps: ['CREDENTIAL_MISSING'],
        signals: failing,
        recorded: nothing,
        window: null,
      }),
    ).toBe('INCOMPLETE');
    expect(
      gatewayHealthState({
        status: 'DISABLED',
        gaps: ['CREDENTIAL_MISSING'],
        signals: failing,
        recorded: nothing,
        window: null,
      }),
    ).toBe('DISABLED');
  });

  it('flags an ACTIVE route that lost a requirement, but not a DISABLED one still being set up', () => {
    const active = gatewayHealthSignals({
      ...base,
      gaps: ['NO_RECEIVING_ACCOUNT'],
      recorded: nothing,
      queues: zero,
    });
    expect(active.map((s) => s.key)).toEqual(['TONPAYS:CONFIGURATION_INCOMPLETE']);
    expect(
      gatewayHealthSignals({
        ...base,
        status: 'DISABLED',
        gaps: ['CREDENTIAL_MISSING'],
        recorded: nothing,
        queues: zero,
      }),
    ).toEqual([]);
  });

  it('raises no payment signal when the queues are withheld, rather than a zero one', () => {
    expect(
      gatewayHealthSignals({ ...base, recorded: nothing, queues: { ...zero, UNKNOWN: 2 } }).map(
        (s) => s.kind,
      ),
    ).toEqual(['PAYMENTS_UNKNOWN']);
    expect(gatewayHealthSignals({ ...base, recorded: nothing, queues: null })).toEqual([]);
  });

  it('keys an open condition by route and code, so it dedupes for as long as it holds', () => {
    const since = new Date('2026-10-03T07:00:00Z');
    const [signal] = gatewayHealthSignals({
      ...base,
      recorded: {
        ...nothing,
        openConditions: [
          { code: 'payments.gateway_misconfigured', severity: 'ERROR', count: 1, since },
        ],
      },
      queues: zero,
    });
    expect(signal).toEqual({
      key: 'TONPAYS:OPEN_CONDITION:payments.gateway_misconfigured',
      category: 'PAYMENT_GATEWAY',
      provider: 'TONPAYS',
      kind: 'OPEN_CONDITION',
      severity: 'ERROR',
      opsCode: 'payments.gateway_misconfigured',
      count: 1,
      since: since.toISOString(),
    });
  });
});

describe('the NO_ACTIVITY rule over the selected window (Codex review of #160)', () => {
  const window = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-08T00:00:00Z') };
  const state = (recorded: GatewayRecordedFacts, w: typeof window | null = window) =>
    gatewayHealthState({ status: 'ACTIVE', gaps: [], signals: [], recorded, window: w });

  it('is NO_ACTIVITY for a route whose only record is older than the window, and keeps the facts', () => {
    const old = { ...nothing, lastInquiryAnsweredAt: new Date('2026-06-01T00:00:00Z') };
    expect(state(old)).toBe('NO_ACTIVITY');
    // The same record with no window (all history) is activity.
    expect(state(old, null)).toBe('NO_ISSUES_RECORDED');
  });

  it('counts an attempt or an answer inside the window, half-open', () => {
    expect(state({ ...nothing, attemptsInWindow: 1 })).toBe('NO_ISSUES_RECORDED');
    expect(state({ ...nothing, lastInquiryAnsweredAt: window.start })).toBe('NO_ISSUES_RECORDED');
    expect(state({ ...nothing, lastInquiryAnsweredAt: window.end })).toBe('NO_ACTIVITY');
    expect(
      state({
        ...nothing,
        lastInquiryFailure: { at: new Date('2026-10-02T00:00:00Z'), code: 'X' },
      }),
    ).toBe('NO_ISSUES_RECORDED');
  });
});

describe('the gateway health window', () => {
  it('takes the reports’ ranges with the CUSTOM rule, and no range at all', () => {
    expect(gatewayHealthQuerySchema.safeParse({}).success).toBe(true);
    expect(gatewayHealthQuerySchema.safeParse({ range: 'LAST_7_DAYS' }).success).toBe(true);
    expect(gatewayHealthQuerySchema.safeParse({ range: 'CUSTOM' }).success).toBe(false);
  });
});
