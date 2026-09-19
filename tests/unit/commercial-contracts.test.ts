import { describe, expect, it } from 'vitest';
import { CommercialActionService } from '../../apps/api/src/modules/commerce/commercial/application/commercial-action.service.js';
import {
  COMMERCIAL_ORDER_PURPOSES,
  extendedAllowance,
  extendedExpiry,
  IDEMPOTENT_MUTATIONS,
  isAddonPurchasable,
  isIdempotentMutation,
  nextState,
  operationTypeForAddonKind,
  operationTypeForOrderPurpose,
  operationTypeCarriesTarget,
  orderPurposeCreatesNewService,
  orderPurposeTargetsExistingService,
  ORDER_PURPOSES,
  OPERATION_TYPES,
  SERVICE_ADDON_KINDS,
  SERVICE_MACHINE,
  serviceAddonAmountMatchesKind,
  serviceAddonSpecificationSchema,
  TARGETED_OPERATION_TYPES,
  UNLIMITED_TRAFFIC_BYTES,
  type OrderPurpose,
} from '@nexa/contracts';

/**
 * The vocabulary Phase 4F froze, and the two pieces of arithmetic under it.
 *
 * These are pure functions in the contracts package, which is the only reason they can
 * be tested without a database or a panel — and the reason they are pure is that every
 * one of them decides something a customer pays for.
 */
describe('order purpose', () => {
  it('has exactly one purpose that produces a service, and it is the default one', () => {
    expect(ORDER_PURPOSES.filter(orderPurposeCreatesNewService)).toEqual(['NEW_SERVICE']);
  });

  /*
   * The derivation, not the list. A purpose added to `ORDER_PURPOSES` without a thought
   * has to land on the side that does NOT provision — an operation that refuses is a bug
   * report, a second provider account is a customer paying twice.
   */
  it('treats every purpose that is not the original purchase as commercial', () => {
    expect([...COMMERCIAL_ORDER_PURPOSES].sort()).toEqual(
      ['ADD_TIME', 'ADD_TRAFFIC', 'RENEW'].sort(),
    );
    for (const purpose of COMMERCIAL_ORDER_PURPOSES) {
      expect(orderPurposeTargetsExistingService(purpose)).toBe(true);
    }
  });

  it('maps every commercial purpose onto a real operation type, and the original onto none', () => {
    expect(operationTypeForOrderPurpose('NEW_SERVICE')).toBeNull();
    for (const purpose of COMMERCIAL_ORDER_PURPOSES) {
      const type = operationTypeForOrderPurpose(purpose);
      expect(type).not.toBeNull();
      expect(OPERATION_TYPES).toContain(type);
    }
  });

  /*
   * THE regression test for the reading that cost this branch three defects.
   *
   * `orderPurposeNeedsService` returned `purpose !== 'NEW_SERVICE'` and was read as
   * "needs a service created" when it meant "names one that exists". The two
   * predicates are positively named and separately exhaustive so there is nothing left
   * to misread — and this asserts the property that makes them safe to rely on: every
   * purpose is on exactly one side, never both and never neither.
   */
  it('classifies every order purpose, exhaustively', () => {
    for (const purpose of ORDER_PURPOSES as readonly OrderPurpose[]) {
      const creates = orderPurposeCreatesNewService(purpose);
      const targets = orderPurposeTargetsExistingService(purpose);
      expect(
        { purpose, creates, targets },
        `${purpose} must be on exactly one side`,
      ).toEqual({ purpose, creates: !targets, targets: !creates });
    }
  });

  /*
   * And the partition stated as sets, so a purpose added to the enum without a branch
   * fails HERE as well as at the compiler. The `never` arm in each switch throws at
   * runtime; this is what makes the failure a named test rather than an exception in
   * whatever settlement happened to run first.
   */
  it('partitions the union into creators and targeters with nothing left over', () => {
    const creators = ORDER_PURPOSES.filter(orderPurposeCreatesNewService);
    const targeters = ORDER_PURPOSES.filter(orderPurposeTargetsExistingService);
    expect([...creators, ...targeters].sort()).toEqual([...ORDER_PURPOSES].sort());
    expect(creators.filter((p) => targeters.includes(p))).toEqual([]);
  });

  /*
   * The two derivations that must agree, asserted against each other rather than
   * against a literal: `COMMERCIAL_ORDER_PURPOSES` is what the schema's CHECK
   * constraint is built from, and the predicate is what the settlement dispatch reads.
   * They disagreeing is a row the settlement path would misread.
   */
  it('agrees with COMMERCIAL_ORDER_PURPOSES, which the schema CHECK is built from', () => {
    expect([...COMMERCIAL_ORDER_PURPOSES].sort()).toEqual(
      ORDER_PURPOSES.filter(orderPurposeTargetsExistingService).sort(),
    );
  });
});

describe('service add-ons', () => {
  it('maps each kind onto the operation type of the same name', () => {
    for (const kind of SERVICE_ADDON_KINDS) {
      expect(OPERATION_TYPES).toContain(operationTypeForAddonKind(kind));
    }
  });

  it('refuses an amount in the field its kind does not read', () => {
    expect(
      serviceAddonAmountMatchesKind({
        kind: 'ADD_TRAFFIC',
        trafficBytes: null,
        durationDays: 30,
      }),
    ).toBe(false);
    expect(
      serviceAddonAmountMatchesKind({ kind: 'ADD_TIME', trafficBytes: 10n, durationDays: null }),
    ).toBe(false);
  });

  it('refuses a row carrying both amounts, and one carrying neither', () => {
    expect(
      serviceAddonSpecificationSchema.safeParse({
        kind: 'ADD_TRAFFIC',
        trafficBytes: 1n,
        durationDays: 1,
      }).success,
    ).toBe(false);
    expect(
      serviceAddonSpecificationSchema.safeParse({
        kind: 'ADD_TIME',
        trafficBytes: null,
        durationDays: null,
      }).success,
    ).toBe(false);
  });

  /*
   * Zero is `UNLIMITED_TRAFFIC_BYTES` on a product and it cannot mean that here: an
   * unlimited amount is not a thing that can be ADDED to an allowance, and reading zero
   * as "add nothing" would sell a customer a no-op.
   */
  it('refuses an add-on of zero, which on a product would mean unlimited', () => {
    expect(
      serviceAddonSpecificationSchema.safeParse({
        kind: 'ADD_TRAFFIC',
        trafficBytes: UNLIMITED_TRAFFIC_BYTES,
        durationDays: null,
      }).success,
    ).toBe(false);
    expect(
      serviceAddonSpecificationSchema.safeParse({
        kind: 'ADD_TIME',
        trafficBytes: null,
        durationDays: 0,
      }).success,
    ).toBe(false);
  });

  it('calls a withdrawn add-on unsellable rather than free', () => {
    expect(isAddonPurchasable('ACTIVE')).toBe(true);
    expect(isAddonPurchasable('INACTIVE')).toBe(false);
  });
});

describe('the operation target', () => {
  /*
   * A `SUSPEND` carrying a desired expiry is a row nothing reads and a reviewer has to
   * guess at. The schema carries this as a CHECK; this is the same rule in the shape the
   * application reads it.
   */
  it('is legal on exactly the three types that buy an allowance', () => {
    for (const type of OPERATION_TYPES) {
      expect(operationTypeCarriesTarget(type)).toBe(
        (TARGETED_OPERATION_TYPES as readonly string[]).includes(type),
      );
    }
    expect([...TARGETED_OPERATION_TYPES].sort()).toEqual(['ADD_TIME', 'ADD_TRAFFIC', 'RENEW']);
  });

  /*
   * The claim the wire evidence buys. `scripts/marzban-allowance-check.sh` rows 1 and 2
   * are why these three may be here at all: both fields are assigned absolutely and an
   * identical replay changes nothing. An increment would have the opposite property.
   */
  it('replays safely, for every type that carries one', () => {
    for (const type of TARGETED_OPERATION_TYPES) {
      expect(isIdempotentMutation(type)).toBe(true);
      expect(IDEMPOTENT_MUTATIONS).toContain(type);
    }
  });
});

describe('extendedExpiry', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');

  /*
   * Renewing EARLY keeps what is left. The legacy `/support` FAQ tells customers exactly
   * this (`TBR-012`), and it is the only reading under which renewing before you have to
   * is never a punishment.
   */
  it('adds to what remains when the service has not expired', () => {
    const current = new Date('2026-03-06T00:00:00.000Z'); // five days left
    expect(extendedExpiry(current, now, 30)?.toISOString()).toBe('2026-04-05T00:00:00.000Z');
  });

  /*
   * Renewing LATE starts from now. A service that lapsed a week ago must not be sold a
   * period that has already elapsed — `OQ-4F-02` records that the research says nothing
   * about this case, which is why the rule is written down rather than inferred.
   */
  it('starts from now when the service has already expired', () => {
    const current = new Date('2026-02-22T00:00:00.000Z'); // a week ago
    expect(extendedExpiry(current, now, 30)?.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('is exactly the boundary at the instant of expiry', () => {
    expect(extendedExpiry(now, now, 1)?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  /* Nothing to extend, so the target omits the field and the panel's value is left alone. */
  it('leaves an unlimited window alone', () => {
    expect(extendedExpiry(null, now, 30)).toBeNull();
  });
});

describe('extendedAllowance', () => {
  /*
   * Strictly additive, and consumption is untouched. `OQ-4F-01` records why this is a
   * decision: the legacy system has five per-panel renewal strategies, its default is
   * reset-volume-and-time, its own FAQ says days stack, and nobody could read which is
   * live. This is the one no customer can be worse off under.
   */
  it('adds the purchased amount to the allowance in force', () => {
    expect(extendedAllowance(10n, 30n)).toBe(40n);
  });

  it('leaves an already-unlimited allowance unlimited', () => {
    expect(extendedAllowance(UNLIMITED_TRAFFIC_BYTES, 30n)).toBe(UNLIMITED_TRAFFIC_BYTES);
  });

  /*
   * A product with no traffic limit, renewed. Adding a finite number to an unlimited
   * purchase would sell the customer LESS than they just paid for.
   */
  it('makes an allowance unlimited when that is what was purchased', () => {
    expect(extendedAllowance(10n, UNLIMITED_TRAFFIC_BYTES)).toBe(UNLIMITED_TRAFFIC_BYTES);
  });
});

describe('the machine the renewal finally uses', () => {
  /*
   * `EXPIRED -> ACTIVE on RENEW` has been frozen since Phase 0 with no caller. This is
   * the edge 4F gives one, and the assertion is here so that removing it from
   * `SERVICE_MACHINE` fails a test rather than quietly making every expired service
   * unrenewable.
   */
  it('takes an expired service back to active on a renewal', () => {
    expect(nextState(SERVICE_MACHINE, 'EXPIRED', 'RENEW')).toBe('ACTIVE');
  });

  /*
   * And it is the ONLY edge `RENEW` has. A renewal of an ACTIVE service changes its
   * allowance and not its state, and a renewal of a SUSPENDED one is refused before an
   * operation exists — the pinned Marzban leaves a `disabled` account disabled through
   * both fields (`scripts/marzban-allowance-check.sh`, row 6), so a renewal there would
   * take the customer's money and change nothing they could see.
   */
  it('has no other renewal edge', () => {
    const renewals = SERVICE_MACHINE.transitions.filter((t) => t.on === 'RENEW');
    expect(renewals).toEqual([{ from: 'EXPIRED', to: 'ACTIVE', on: 'RENEW' }]);
  });
});

/**
 * `availableFor` must tell an OUTAGE apart from a withdrawn plan.
 *
 * A unit test with a fault-injected repository, because the integration suite has no way
 * to make a real one throw: every failure it can produce is a business refusal, which is
 * exactly the half that must be swallowed. F4F-38 measured the gap — the narrowed catch
 * survived the whole suite — and this is what kills it.
 *
 * The deps are the five members this path touches. Cast rather than faked in full: a
 * complete double would be forty members of which thirty-five are never called, and the
 * cast is where a future dependency on this path shows up as a crash in this test rather
 * than as a silent pass.
 */
describe('availableFor separates an outage from a refusal', () => {
  const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as never;
  const actor = { kind: 'SYSTEM_JOB' } as never;
  const service = {
    id: '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa',
    productId: '0191f4a0-9e77-7d18-8c03-2b9d4e5a1f60',
    panelId: '0191f4a0-9e77-7d18-8c03-2b9d4e5a1f61',
    state: 'ACTIVE',
    expiresAt: null,
    trafficLimitBytes: 0n,
  } as never;

  function serviceWith(findById: () => Promise<unknown>): CommercialActionService {
    return new CommercialActionService({
      guard: { check: async () => undefined },
      panels: { operability: async () => ({ ok: true, reason: null }) },
      products: { findById },
      addons: { listOfferable: async () => ({ items: [], hasMore: false }) },
      settings: { valueOf: async () => 'IRT' },
    } as never);
  }

  it('rethrows an infrastructure failure instead of hiding the button', async () => {
    const broken = serviceWith(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(broken.availableFor(scope, actor, service)).rejects.toThrow(
      /connection terminated/,
    );
  });

  it('still swallows the business refusal, which is what the catch is for', async () => {
    // A withdrawn plan: `renewableProduct` raises SERVICE_ACTION_UNAVAILABLE, and a
    // renewal simply is not offered. No throw, no button.
    const withdrawn = serviceWith(async () => null);
    await expect(withdrawn.availableFor(scope, actor, service)).resolves.not.toContain('RENEW');
  });
});
