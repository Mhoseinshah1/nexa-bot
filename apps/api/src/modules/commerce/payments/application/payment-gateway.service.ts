import {
  COMMERCE_ERROR_CODES,
  PAYMENT_GATEWAY_DESCRIPTORS,
  errors,
  money,
  paymentGatewayProviderSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PaymentGatewayConfig,
  type PaymentMethod,
  type PaymentGatewayProvider,
  type PaymentGatewayStatus,
  type PermissionKey,
  type TenantContext,
  type SalesCurrencyCode,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  accountAgeInDays,
  evaluateGatewayEligibility,
  type GatewayEligibility,
} from '../domain/gateway-eligibility.js';
import type {
  GatewayAudienceReader,
  PaymentGatewayRecord,
  PaymentGatewayRepository,
} from './gateway-ports.js';

export const PAYMENT_GATEWAY_VIEW_PERMISSION = 'payments.gateways.view' satisfies PermissionKey;
export const PAYMENT_GATEWAY_EDIT_PERMISSION = 'payments.gateways.edit' satisfies PermissionKey;

export interface PaymentGatewayServiceDeps {
  readonly repository: PaymentGatewayRepository;
  readonly audience: GatewayAudienceReader;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  /**
   * Read for ONE thing: the denomination the amount bounds are expressed in.
   *
   * A route stores bare minor units and no currency of its own —
   * `payment-gateways.ts` records why a per-route currency would be a second
   * denomination with no conversion to reach it — so the one currency this
   * installation sells in is what a bound means, and what a surface must render it as.
   */
  readonly settings: SettingsResolver;
}

/** What one command was asked to do, so a replay can answer with the same route. */
interface GatewayResult {
  readonly provider: string;
}

/** A route this customer may use, with the bounds that apply to their amount. */
export interface OfferedGateway {
  readonly gateway: PaymentGatewayRecord;
  readonly minAmount: Money;
  readonly maxAmount: Money | null;
}

/**
 * The payment routes an operator offers, and which of them a customer may use.
 *
 * Two commands and three reads, and the commands are separate for the reason
 * `PaymentAccountService` states: folding "switch this off" into the edit would make
 * "who stopped accepting card-to-card, and when" answerable only by diffing two field
 * sets.
 *
 * Creating a tenant's routes is NOT here. It is a boot-time reconcile with no actor
 * behind it, so it goes through the repository at the same place and in the same
 * transaction as `ensureSystemRoles` — see `resolveInstallationTenant`. Routing it
 * through this service would have meant either a fabricated actor or widening
 * `SYSTEM_JOB_PERMISSIONS` for a statement that writes nothing an operator asked for.
 *
 * Everything that mutates charges `payments.gateways.edit`; the reads charge
 * `payments.gateways.view`, except `offer`, which charges nothing because its caller is
 * a customer's own payment attempt rather than an administrator.
 */
export class PaymentGatewayService {
  constructor(private readonly deps: PaymentGatewayServiceDeps) {}

  /**
   * Every route, with the denomination its bounds are in.
   *
   * The currency travels WITH the list rather than being fetched separately by the
   * surface, because a bound rendered in the wrong denomination is a number an operator
   * would act on. One read, one answer, and the surface cannot pair them wrongly.
   */
  async list(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<{ gateways: readonly PaymentGatewayRecord[]; currency: SalesCurrencyCode }> {
    await this.deps.guard.check(scope, actor, PAYMENT_GATEWAY_VIEW_PERMISSION);
    const [gateways, currency] = await Promise.all([
      this.deps.repository.list(scope),
      this.deps.settings.valueOf<SalesCurrencyCode>(scope, 'sales.currency'),
    ]);
    return { gateways, currency };
  }

  /** The denomination a route's bounds are in, for a surface rendering one route. */
  async currency(scope: TenantContext): Promise<SalesCurrencyCode> {
    return this.deps.settings.valueOf<SalesCurrencyCode>(scope, 'sales.currency');
  }

  /** Replaces one route's configuration. Cannot switch it on or off — that is `setStatus`. */
  async configure(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly provider: string;
      readonly config: PaymentGatewayConfig;
    },
  ): Promise<PaymentGatewayRecord> {
    const provider = this.provider(input.provider);
    const denial = {
      action: 'payment_gateway.configure',
      entityType: 'PaymentGateway',
      entityId: provider,
    };
    // Before the replay lookup, the rule `PaymentAccountService.create` states: a replay
    // returns a ROW, and an unauthorized caller who guessed a key would be handed one.
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      provider,
      displayName: input.config.displayName,
      instructions: input.config.instructions,
      // `bigint` has no JSON form, so the hash needs the decimal string. Omitting
      // either bound would make two edits differing only in a limit hash identically,
      // and the second would be answered with the first's row.
      minAmountMinor: input.config.minAmountMinor.toString(),
      maxAmountMinor: input.config.maxAmountMinor.toString(),
      eligibility: input.config.eligibility,
      sortOrder: input.config.sortOrder,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_GATEWAY_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, provider, tx);
        // The denomination these bounds are being written in, read inside the transaction.
        const currency = await this.deps.settings.valueOf<SalesCurrencyCode>(
          scope,
          'sales.currency',
          tx,
        );
        const after = await this.deps.repository.update(
          scope,
          provider,
          input.config,
          currency,
          now,
          tx,
        );
        if (after === null) {
          throw errors.notFound(
            COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_NOT_FOUND,
            'Unknown payment route.',
          );
        }

        await this.record(scope, actor, tx, {
          action: 'payment_gateway.configure',
          entityId: provider,
          before: auditView(before),
          after: auditView(after),
        });
        await this.remember(scope, input.idempotencyKey, requestHash, provider, tx);
        return after;
      },
    );
  }

  /**
   * Switches one route on or off.
   *
   * A no-op when the route is already in the requested status, and it says so by
   * returning the row unchanged with NO audit row: an audit entry for a change that did
   * not happen is the legacy activity feed, a sentence per button press with no way to
   * tell an action from a no-op. The transition itself is a conditional UPDATE naming
   * its `from`, so two operators racing produce one change and one refusal rather than
   * two audit rows claiming the same one.
   */
  async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly provider: string;
      readonly status: PaymentGatewayStatus;
    },
  ): Promise<PaymentGatewayRecord> {
    const provider = this.provider(input.provider);
    const denial = {
      action: 'payment_gateway.set_status',
      entityType: 'PaymentGateway',
      entityId: provider,
    };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({ provider, status: input.status });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_GATEWAY_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, provider, tx);
        if (before.status === input.status) {
          await this.remember(scope, input.idempotencyKey, requestHash, provider, tx);
          return before;
        }

        const after = await this.deps.repository.setStatus(
          scope,
          provider,
          { from: before.status, to: input.status },
          now,
          tx,
        );
        /*
         * Zero rows means somebody else moved it between the read and the write. Its own
         * refusal rather than a silent re-read: what this operator asked for is no
         * longer what the route needs, and reporting success would put an audit row
         * against a change they did not make.
         */
        if (after === null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
            'Another operator changed this route while the request was in flight. Try again.',
            { reason: 'STATUS_RACE' },
          );
        }

        await this.record(scope, actor, tx, {
          action: 'payment_gateway.set_status',
          entityId: provider,
          before: auditView(before),
          after: auditView(after),
        });
        await this.remember(scope, input.idempotencyKey, requestHash, provider, tx);
        return after;
      },
    );
  }

  /**
   * Every route, with the eligibility verdict for this customer against each.
   *
   * The operator's view of "why can this customer not pay", which is the question
   * `PAYMENT_GATEWAY_INELIGIBILITY_REASONS` exists to answer. Charges
   * `payments.gateways.view`, because it reads configuration; the customer's own path is
   * `offer` below and charges nothing.
   */
  async explain(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
  ): Promise<readonly { gateway: PaymentGatewayRecord; eligibility: GatewayEligibility }[]> {
    await this.deps.guard.check(scope, actor, PAYMENT_GATEWAY_VIEW_PERMISSION);
    const gateways = await this.deps.repository.list(scope);
    if (gateways.length === 0) return [];

    const audience = await this.audienceFor(scope, customerId);
    return gateways.map((gateway) => ({
      gateway,
      eligibility: evaluateGatewayEligibility(gateway.status, gateway, audience),
    }));
  }

  /**
   * The route a customer's payment of this amount should be issued against.
   *
   * The one method here with no permission check, and that is deliberate rather than an
   * omission: the caller is the customer's own payment attempt, acting as the customer,
   * and there is no `ActorContext` for a customer in this product. What bounds it instead
   * is that it takes a CUSTOMER id and an amount and returns configuration — it writes
   * nothing, and every fact it reads is about the tenant the scope already names.
   *
   * ## Three refusals, and only one of them is the customer's to know
   *
   * - no route configured at all, or none this customer is eligible for →
   *   `PAYMENT_GATEWAY_UNAVAILABLE`. ONE code for four underlying facts, because naming
   *   which threshold refused them tells whoever holds that chat how this installation's
   *   payment gating is set up. The `reason` detail carries it for the operator.
   * - the amount is outside the chosen route's bounds →
   *   `PAYMENT_GATEWAY_AMOUNT_REJECTED`, which is a misconfiguration an operator can
   *   act on and the detail says which side it fell on.
   * - a bound is denominated in another currency → `PAYMENT_GATEWAY_UNAVAILABLE` with
   *   `BOUND_CURRENCY_MISMATCH`. Fails closed, because converting it would be the FX
   *   guess the money model refuses. This is unreachable while the bounds carry no
   *   currency of their own and is asserted anyway: the day a route gains one, this is
   *   the branch that has to already exist.
   *
   * ## Why the eligible route is picked by ORDER rather than by asking
   *
   * `sortOrder` then provider, which is the order the operator arranged and the order
   * every surface renders. With one operable route the choice is not a choice; when
   * there are several, the first ELIGIBLE one is what a customer would have tapped, and
   * a chooser can be added over this method without changing what it decides.
   */
  async offer(
    scope: TenantContext,
    customerId: UserId,
    amount: Money,
    tx?: unknown,
  ): Promise<OfferedGateway> {
    const gateways = await this.deps.repository.list(scope, tx);
    if (gateways.length === 0) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
        'No payment route is configured.',
        { reason: 'NO_GATEWAYS' },
      );
    }

    const audience = await this.audienceFor(scope, customerId, tx);
    const eligible = gateways.find(
      (gateway) => evaluateGatewayEligibility(gateway.status, gateway, audience).eligible,
    );
    if (eligible === undefined) {
      /*
       * The reasons go to the DETAIL, not to the message. An operator reading the
       * operational log needs to know it was `TOO_FEW_PAYMENTS` on every route; the
       * customer needs to know they cannot pay this way right now, and nothing more.
       */
      const reasons = gateways.map((gateway) => {
        const verdict = evaluateGatewayEligibility(gateway.status, gateway, audience);
        return `${gateway.provider}:${verdict.eligible ? 'ELIGIBLE' : verdict.reason}`;
      });
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
        'No payment route is available for this customer.',
        { reason: 'NO_ELIGIBLE_GATEWAY', gateways: reasons },
      );
    }

    /*
     * The row's own denomination. A NULL is a row the previous release wrote during
     * the rolling update that shipped the column, and that release relabelled its
     * bounds with the amount's currency — so that, and only that, is what a NULL means.
     */
    const boundsCurrency = eligible.boundsCurrency ?? amount.currency;
    return {
      gateway: eligible,
      minAmount: this.boundFor(eligible.minAmountMinor, boundsCurrency),
      maxAmount:
        eligible.maxAmountMinor === 0n
          ? null
          : this.boundFor(eligible.maxAmountMinor, boundsCurrency),
    };
  }

  /**
   * Refuses an amount the chosen route will not accept.
   *
   * Separate from `offer` because the caller has its OWN floor to apply as well — the
   * installation-wide `wallet.topup.minimum` — and the two have to be combined rather
   * than applied in sequence: whichever is more restrictive wins, on both sides. That
   * rule is the answer to `FBR-008`, which could not establish which layer a legacy
   * installation prefers. Most-restrictive needs no evidence, because it can never
   * permit what either layer forbids.
   */
  assertAmountAccepted(offered: OfferedGateway, amount: Money): void {
    if (amount.currency !== offered.minAmount.currency) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
        'This payment route is configured in another currency.',
        { reason: 'BOUND_CURRENCY_MISMATCH' },
      );
    }
    if (offered.minAmount.amountMinor > 0n && amount.amountMinor < offered.minAmount.amountMinor) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED,
        'That amount is below what this payment route accepts.',
        {
          side: 'BELOW_MINIMUM',
          boundMinor: offered.minAmount.amountMinor.toString(),
          currency: offered.minAmount.currency,
        },
      );
    }
    if (offered.maxAmount !== null && amount.amountMinor > offered.maxAmount.amountMinor) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED,
        'That amount is above what this payment route accepts.',
        {
          side: 'ABOVE_MAXIMUM',
          boundMinor: offered.maxAmount.amountMinor.toString(),
          currency: offered.maxAmount.currency,
        },
      );
    }
  }

  /**
   * Whether an ACTIVE route settles through this method. STATUS only, nothing else.
   *
   * The narrowest question a payment path can ask a route, and the narrowness is the
   * point. `offer` answers "which route may THIS customer use for THIS amount", which
   * folds in the eligibility thresholds and the amount bounds — and whether those apply
   * to an ORDER payment is the open product decision `OQ-5C-01`. This asks only whether
   * the operator has switched the route off, which is not a threshold and carries no
   * product ambiguity: an operator who disables card-to-card means customers should not
   * be offered card-to-card.
   *
   * `FBR-002` is the evidence that the toggle is meant to be load-bearing — "the toggle
   * determines whether customers can pay through that route at all". Before this, 5C
   * bound it to the wallet top-up path and nowhere else, so an operator could disable
   * MANUAL_TRANSFER and watch order payments keep arriving through it. A control that
   * does not do what it says is the write-only-settings class of defect, and this is the
   * read that makes it true.
   *
   * No permission check: this is a fact about the installation's configuration consulted
   * by a customer-initiated command, exactly as `settlementMethodFor` is. What a
   * customer may DO with the answer is charged by the caller.
   */
  async methodIsOffered(
    scope: TenantContext,
    method: PaymentMethod,
    tx?: unknown,
  ): Promise<boolean> {
    const gateways = await this.deps.repository.list(scope, tx);
    return gateways.some(
      (gateway) =>
        gateway.status === 'ACTIVE' && this.settlementMethodFor(gateway.provider) === method,
    );
  }

  /** How the chosen route settles, from the descriptor rather than from its name. */
  settlementMethodFor(provider: PaymentGatewayProvider) {
    return PAYMENT_GATEWAY_DESCRIPTORS[provider].settlesVia;
  }

  // -------------------------------------------------------------------------

  /**
   * A bound, denominated in the currency it was WRITTEN in — the row's, never the
   * amount's.
   *
   * It used to take the amount's currency, which made `BOUND_CURRENCY_MISMATCH`
   * unreachable by construction and hid the failure it was reserved for: an operator
   * switching `sales.currency` from IRT to IRR relabelled every stored `1000000` as
   * IRR at comparison time, so each route began accepting a tenth of what it had, with
   * no bound edited and no conversion performed. `assertAmountAccepted` now meets the
   * row's own denomination and fails closed until the operator re-saves the bounds.
   */
  private boundFor(amountMinor: bigint, currency: CurrencyCode): Money {
    return money(amountMinor, currency);
  }

  private async audienceFor(scope: TenantContext, customerId: UserId, tx?: unknown) {
    const [confirmedPayments, firstSeenAt] = await Promise.all([
      this.deps.audience.confirmedPaymentCount(scope, customerId, tx),
      this.deps.audience.firstSeenAt(scope, customerId, tx),
    ]);
    /*
     * A customer this tenant does not have gets an age of ZERO, not an exception.
     *
     * Zero is the conservative answer: it satisfies no `activateAfterAccountDays` bound,
     * so an unknown customer is refused by any route that has one rather than admitted
     * by a route that does. Throwing here would turn a gating question into a 500 on a
     * path that has a correct refusal available.
     */
    return {
      confirmedPayments,
      accountAgeDays:
        firstSeenAt === null ? 0 : accountAgeInDays(firstSeenAt, this.deps.clock.now()),
    };
  }

  private async require(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    tx: TransactionScope,
  ): Promise<PaymentGatewayRecord> {
    const gateway = await this.deps.repository.find(scope, provider, tx);
    if (gateway === null) {
      throw errors.notFound(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_NOT_FOUND,
        'Unknown payment route.',
      );
    }
    return gateway;
  }

  /** A provider from the CLOSED catalogue, validated in the service so every surface inherits it. */
  private provider(candidate: string): PaymentGatewayProvider {
    const parsed = paymentGatewayProviderSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a payment route this installation can operate.',
      );
    }
    return parsed.data;
  }

  private async replay(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PaymentGatewayRecord | null> {
    const found = await this.deps.idempotency.find<GatewayResult>(
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    // Null when the idempotency row outlived its route, which a restore can produce:
    // falling through and doing the work beats reporting a stale success.
    return this.deps.repository.find(scope, found.result.provider as PaymentGatewayProvider);
  }

  private async remember(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    provider: PaymentGatewayProvider,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
      { provider } satisfies GatewayResult,
      tx,
    );
  }

  private async record(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    entry: {
      readonly action: string;
      readonly entityId: string;
      readonly before: Record<string, unknown> | null;
      readonly after: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: entry.action,
        entityType: 'PaymentGateway',
        entityId: entry.entityId,
        before: entry.before,
        after: entry.after,
        result: 'SUCCESS',
      },
      tx,
    );
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }

  /** `recordMutationDenial`, not a bare check — see `ProductService.authorize`. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, PAYMENT_GATEWAY_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        PAYMENT_GATEWAY_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }
}

/**
 * Every mutable field, so a before/after pair answers what an edit changed.
 *
 * The amounts are STRINGS here, because an audit payload is JSON and a `bigint` does not
 * survive it. `status` is in both views even though only `setStatus` changes it — an
 * audit row is read on its own, and one that omitted the field would leave a reader
 * unable to tell whether the route was even switched on at the time.
 */
function auditView(gateway: PaymentGatewayRecord): Record<string, unknown> {
  return {
    provider: gateway.provider,
    status: gateway.status,
    displayName: gateway.displayName,
    instructions: gateway.instructions,
    minAmountMinor: gateway.minAmountMinor.toString(),
    maxAmountMinor: gateway.maxAmountMinor.toString(),
    activateAfterPayments: gateway.activateAfterPayments,
    deactivateAfterPayments: gateway.deactivateAfterPayments,
    activateAfterAccountDays: gateway.activateAfterAccountDays,
    sortOrder: gateway.sortOrder,
  };
}
