import { describe, expect, it } from 'vitest';
import {
  CALLBACK_REF_LENGTH,
  ERROR_KINDS,
  ERROR_KIND_HTTP_STATUS,
  errors,
  notificationListQuerySchema,
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  isEventType,
  isLedgerReason,
  isRegisteredMetric,
  LEDGER_REASONS,
  metricDefinition,
  NexaError,
  PRICING_PRECEDENCE,
  STATE_MACHINES,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  validateStateMachine,
  type StateMachineDefinition,
} from '@nexa/contracts';

describe('event catalog', () => {
  it('has a payload schema for every registered event type', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_PAYLOAD_SCHEMAS[type]).toBeDefined();
    }
  });

  it('rejects an unregistered event name', () => {
    // Adding an event is a contract change, not a feature commit.
    expect(isEventType('SystemPinged')).toBe(true);
    expect(isEventType('OrderPaid')).toBe(false);
  });
});

describe('ledger reason catalog', () => {
  it('carries every enumerated reason exactly once', () => {
    // The architecture review calls this "the 24-value ledger reason enum" but
    // its own verbatim list enumerates 25. The list is authoritative over the
    // label; see docs/open-questions.md (C-LEDGER-COUNT).
    expect(LEDGER_REASONS.length).toBe(25);
    expect(new Set(LEDGER_REASONS).size).toBe(LEDGER_REASONS.length);
  });

  it('keeps the three cashback sources distinct', () => {
    // The legacy system has three unrelated cashback mechanisms that all end as
    // one opaque balance bump, so none of them can be reported on separately.
    expect(isLedgerReason('CASHBACK_GATEWAY')).toBe(true);
    expect(isLedgerReason('CASHBACK_TOPUP')).toBe(true);
    expect(isLedgerReason('CASHBACK_RENEWAL')).toBe(true);
  });

  it('keeps refund separate from purchase reversal and chargeback', () => {
    for (const reason of ['REFUND', 'PURCHASE_REVERSAL', 'CHARGEBACK']) {
      expect(isLedgerReason(reason)).toBe(true);
    }
  });
});

describe('error taxonomy', () => {
  it('maps every kind to an HTTP status', () => {
    for (const kind of ERROR_KINDS) {
      expect(ERROR_KIND_HTTP_STATUS[kind]).toBeGreaterThanOrEqual(400);
    }
  });

  it('derives status from the kind, not from the message', () => {
    expect(errors.notFound('x.y', 'gone').httpStatus).toBe(404);
    expect(errors.permissionDenied('x.y', 'no').httpStatus).toBe(403);
    expect(errors.conflict('x.y', 'clash').httpStatus).toBe(409);
  });

  it('marks transient upstream failures retryable and validation failures not', () => {
    expect(new NexaError({ kind: 'TIMEOUT', code: 'a', message: 'b' }).retryable).toBe(true);
    expect(errors.validation('a', 'b').retryable).toBe(false);
  });
});

describe('metric registry', () => {
  it('starts empty rather than aspirational, and refuses an unregistered name', () => {
    expect(isRegisteredMetric('total_revenue')).toBe(false);
    expect(() => metricDefinition('total_revenue')).toThrow();
  });
});

describe('pricing precedence', () => {
  it('is declared as ordered data so a change is a visible diff', () => {
    expect(PRICING_PRECEDENCE[0]?.step).toBe('BASE_PRICE');
    expect(PRICING_PRECEDENCE.at(-1)?.step).toBe('PROMOTIONAL_DISCOUNT');
    // Wallet application and cashback are settlement, not price. Keeping them
    // out of the pricing pipeline is what stops "final price" meaning two things.
    expect(PRICING_PRECEDENCE.map((s) => s.step)).not.toContain('WALLET');
  });
});

describe('callback references', () => {
  it('leaves usable room for a route inside Telegram callback_data', () => {
    const budget = TELEGRAM_CALLBACK_DATA_MAX_BYTES;

    // A ref leaves 48 bytes for the route; a raw UUID leaves 28. Persian flow
    // and step names are multi-byte in UTF-8, so 28 bytes runs out quickly.
    const refHeadroom = budget - CALLBACK_REF_LENGTH;
    const uuidHeadroom = budget - 36;

    expect(refHeadroom).toBe(48);
    expect(uuidHeadroom).toBe(28);
    expect(refHeadroom).toBeGreaterThan(uuidHeadroom);

    const realisticRoute = 'renew:choose-plan:';
    expect(
      Buffer.byteLength(`${realisticRoute}${'x'.repeat(CALLBACK_REF_LENGTH)}`, 'utf8'),
    ).toBeLessThanOrEqual(budget);
  });
});

describe('state machine validation', () => {
  it('accepts a well-formed machine', () => {
    const machine: StateMachineDefinition<'A' | 'B', 'go'> = {
      name: 'demo',
      initial: 'A',
      states: ['A', 'B'],
      terminal: ['B'],
      transitions: [{ from: 'A', to: 'B', on: 'go' }],
    };
    expect(validateStateMachine(machine)).toEqual([]);
  });

  it('reports unreachable states and non-terminal dead ends', () => {
    const machine: StateMachineDefinition<'A' | 'B' | 'C', 'go'> = {
      name: 'broken',
      initial: 'A',
      states: ['A', 'B', 'C'],
      terminal: [],
      transitions: [{ from: 'A', to: 'B', on: 'go' }],
    };
    const problems = validateStateMachine(machine);
    expect(problems.map((p) => p.kind)).toContain('UNREACHABLE_STATE');
    expect(problems.map((p) => p.kind)).toContain('DEAD_END_STATE');
  });

  it('validates every declared machine', () => {
    for (const machine of STATE_MACHINES) {
      expect(validateStateMachine(machine)).toEqual([]);
    }
  });
});

describe('the notification list page size is parsed, not clamped', () => {
  // `Number(query.limit)` followed by `Math.min(Math.max(n, 1), 200)` carried
  // NaN straight through — `Math.max(NaN, 1)` is NaN — into the SQL LIMIT,
  // where it surfaced as an internal error rather than a bad request. Zero,
  // negative, fractional and oversized values were silently rewritten rather
  // than refused, so a caller could not tell a misspelled request from an
  // honoured one.
  it.each([
    ['abc', 'not a number at all'],
    ['NaN', 'the literal spelling of the value that used to get through'],
    ['Infinity', 'infinite'],
    ['-Infinity', 'infinite the other way'],
    ['1.5', 'fractional'],
    ['0', 'zero pages'],
    ['-1', 'negative'],
    ['201', 'past the bound'],
    ['', 'empty'],
  ])('refuses %s (%s)', (limit) => {
    expect(notificationListQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it.each([['1'], ['50'], ['200']])('accepts %s', (limit) => {
    const parsed = notificationListQuerySchema.safeParse({ limit });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(Number(limit));
  });

  it('accepts an absent limit, leaving the default to the service', () => {
    const parsed = notificationListQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBeUndefined();
  });
});
