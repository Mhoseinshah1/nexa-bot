import { describe, expect, it } from 'vitest';
import {
  CALLBACK_REF_LENGTH,
  canDeleteUser,
  canDisableUser,
  canEnableUser,
  ERROR_KINDS,
  ERROR_KIND_HTTP_STATUS,
  errors,
  notificationListQuerySchema,
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  isEventType,
  isServiceAdapter,
  isLedgerReason,
  isRegisteredMetric,
  LEDGER_REASONS,
  marzbanActivationSchema,
  metricDefinition,
  NexaError,
  PRICING_PRECEDENCE,
  providerDescriptor,
  STATE_MACHINES,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  validateStateMachine,
  type ProviderAdapter,
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
    // The loop below was vacuous for three phases: `STATE_MACHINES` was `[]`,
    // so this case passed by iterating over nothing and would have kept passing
    // if a machine had been declared and never registered. The registry is
    // asserted non-empty and asserted to contain the machine by NAME, so
    // emptying the list or forgetting to register a machine fails here rather
    // than silently removing the check.
    expect(STATE_MACHINES.length).toBeGreaterThan(0);
    expect(STATE_MACHINES.map((machine) => machine.name)).toContain('recovery');
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

describe('a Marzban panel must name the inbounds its accounts are created on', () => {
  /*
   * The regression this pins is not a validation nicety. `inboundTags` was OPTIONAL and
   * documented as defaulting to "every inbound for those protocols, which is Marzban's
   * own documented default". A real v0.8.4 panel disagreed: `UserCreate.excluded_inbounds`
   * excludes every inbound NOT listed, so omitting the key excludes all of them. The
   * create answers 200 with a subscription URL and the customer's subscription is zero
   * bytes — a success by every status code the installation can see.
   *
   * `docs/providers/marzban.md` records the measurement. These five cases are what stop
   * the field going back to optional, or to "some protocol has tags".
   */
  it('refuses an activation that names protocols and no inbounds at all', () => {
    const parsed = marzbanActivationSchema.safeParse({ proxyProtocols: ['vless'] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.path[0] === 'inboundTags')).toBe(true);
  });

  it('refuses an activation whose tag list for a configured protocol is empty', () => {
    expect(
      marzbanActivationSchema.safeParse({ proxyProtocols: ['vless'], inboundTags: { vless: [] } })
        .success,
    ).toBe(false);
  });

  it('refuses tags for SOME protocol while another is left with none', () => {
    /*
     * The narrower path to the same zero-byte subscription: `vless` is configured and
     * served, `vmess` is configured and silently excluded from every inbound. A record
     * that is merely non-empty would pass.
     */
    const parsed = marzbanActivationSchema.safeParse({
      proxyProtocols: ['vless', 'vmess'],
      inboundTags: { vless: ['VLESS TCP'] },
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.path[0] === 'inboundTags' && issue.path[1] === 'vmess',
      ),
    ).toBe(true);
  });

  it('accepts an activation that names a tag for every configured protocol', () => {
    expect(
      marzbanActivationSchema.safeParse({
        proxyProtocols: ['vless', 'vmess'],
        inboundTags: { vless: ['VLESS TCP'], vmess: ['VMess WS'] },
      }).success,
    ).toBe(true);
  });

  it('declares inboundTags as a field an operator must supply before the panel is usable', () => {
    /*
     * The descriptor is what `decideOperability` reads and what the Web Admin renders,
     * so a required schema field that is not also declared here is a panel refused with
     * no indication of which field is missing.
     */
    const marzban = providerDescriptor('marzban');
    expect(marzban?.requiredActivationFields).toContain('inboundTags');
    expect(marzban?.requiredActivationFields).toContain('proxyProtocols');
  });
});

describe('an adapter may be called for a management operation only when it can do it', () => {
  /*
   * `canDisableUser` and its two siblings ask two questions and require both answers.
   * These cases exist because each half alone fails in a different, specific way:
   *
   *   method without capability -> the executor performs an operation the providers
   *     endpoint says the panel cannot do, so a customer is offered a button the
   *     product denies having, and an operator's capability list is a lie.
   *   capability without method -> the executor calls `undefined` inside a claimed
   *     operation. A TypeError is the one failure shape provider outcomes exist to keep
   *     out of this layer: it is not a `ProviderFailureKind`, so nothing classifies it
   *     and a mutating operation cannot decide whether it took effect.
   */
  const stub = (
    capabilities: readonly string[],
    methods: Partial<Record<'suspendUser' | 'resumeUser' | 'terminateUser', () => unknown>>,
  ): ProviderAdapter =>
    ({
      descriptor: { capabilities } as unknown,
      supports: (capability: string) => capabilities.includes(capability),
      probe: () => Promise.reject(new Error('not used')),
      createUser: () => Promise.reject(new Error('not used')),
      lookupUser: () => Promise.reject(new Error('not used')),
      readUsage: () => Promise.reject(new Error('not used')),
      ...methods,
    }) as unknown as ProviderAdapter;

  const noop = (): unknown => undefined;

  it('says yes only when the method and the capability are both there', () => {
    expect(canDisableUser(stub(['DISABLE_USER'], { suspendUser: noop }))).toBe(true);
    expect(canEnableUser(stub(['ENABLE_USER'], { resumeUser: noop }))).toBe(true);
    expect(canDeleteUser(stub(['DELETE_USER'], { terminateUser: noop }))).toBe(true);
  });

  it('says no to a method whose capability is not declared', () => {
    expect(canDisableUser(stub([], { suspendUser: noop }))).toBe(false);
    expect(canEnableUser(stub([], { resumeUser: noop }))).toBe(false);
    expect(canDeleteUser(stub([], { terminateUser: noop }))).toBe(false);
  });

  it('says no to a declared capability with no method behind it', () => {
    expect(canDisableUser(stub(['DISABLE_USER'], {}))).toBe(false);
    expect(canEnableUser(stub(['ENABLE_USER'], {}))).toBe(false);
    expect(canDeleteUser(stub(['DELETE_USER'], {}))).toBe(false);
  });

  it('does not let one capability answer for another', () => {
    /*
     * Three separate entries in PROVIDER_CAPABILITIES, so a panel that disables but
     * cannot delete must read as exactly that. A bundled guard would advertise both.
     */
    const disableOnly = stub(['DISABLE_USER'], { suspendUser: noop, terminateUser: noop });
    expect(canDisableUser(disableOnly)).toBe(true);
    expect(canDeleteUser(disableOnly)).toBe(false);
    expect(canEnableUser(disableOnly)).toBe(false);
  });

  it('still recognises the service half from the three methods that are not optional', () => {
    /*
     * `isServiceAdapter` must NOT start requiring the management three: an adapter that
     * creates and reads users is a complete service adapter, and Sanaei is one.
     */
    expect(isServiceAdapter(stub(['CREATE_USER'], {}))).toBe(true);
  });
});
