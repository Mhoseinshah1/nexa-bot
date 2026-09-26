import {
  COMMERCE_ERROR_CODES,
  PAYMENT_GATEWAY_DESCRIPTORS,
  errors,
  paymentGatewayProviderSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PaymentGatewayConfig,
  type PaymentGatewayDescriptor,
  type PaymentMethod,
  type PaymentGatewayProvider,
  type PaymentGatewayStatus,
  type PaymentPurpose,
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
import type { PaymentAccountRepository } from './account-ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  accountAgeInDays,
  evaluateGatewayEligibility,
  type GatewayAudience,
  type GatewayEligibility,
} from '../domain/gateway-eligibility.js';
import { allowsPurpose, boundsOf, decideAmount } from '../domain/gateway-selection.js';
import type {
  GatewayAudienceReader,
  PaymentGatewayRecord,
  PaymentGatewayRepository,
} from './gateway-ports.js';
import type { ExternalGatewayAdapter, GatewayCredentialStore } from './gateway-invoice-ports.js';

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
  /**
   * Whether ANY enabled receiving account exists — the one fact that decides whether a
   * route settling by manual transfer can be paid through at all. Asked here, where the
   * routes are decided, so a surface never draws a route whose final tap `issueTopup`
   * or the order's transfer would refuse with `NO_DESTINATION`.
   */
  readonly accounts: Pick<PaymentAccountRepository, 'hasEnabled'>;
  /**
   * A route's stored API key (WP11A): its set-at time for the list and for enabling, and
   * the write for replacing it. Never a read of the key itself — this service has no
   * reason to hold one.
   */
  readonly credentials: Pick<GatewayCredentialStore, 'setAt' | 'replace'>;
  /**
   * The adapter behind an external route, for the one question route selection asks of
   * it: whether an amount has an exact value in the provider's unit. Null for a route
   * that is not an external gateway.
   */
  readonly adapters: (
    provider: PaymentGatewayProvider,
  ) => Pick<ExternalGatewayAdapter, 'providerAmountOf'> | null;
  /** The GENERATED callback URL a route's provider is sent, for the operator to see. */
  readonly callbackUrlFor: (
    scope: TenantContext,
    provider: PaymentGatewayProvider,
  ) => Promise<string | null>;
}

/** A route's credential and callback, as the operator's list shows them. Never a value. */
export interface GatewayOperatorFacts {
  readonly credentialSetAt: Date | null;
  readonly callbackUrl: string | null;
}

/**
 * `PaymentGatewayConfig` with the two purpose switches OPTIONAL: absent means "as the row
 * has it", decided inside `configure`'s transaction against the row it is about to write.
 */
export type PaymentGatewayConfigInput = Omit<
  PaymentGatewayConfig,
  'allowServicePurchase' | 'allowWalletTopup'
> & {
  readonly allowServicePurchase?: boolean | undefined;
  readonly allowWalletTopup?: boolean | undefined;
};

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
 * One route a customer may be SHOWN for a purpose (customer UX completion §D/§F).
 *
 * The descriptor travels with it so a surface decides how the route settles from the
 * descriptor and never from the provider's name — `externalRoutes` in
 * `gateway-selection.ts` is the one consumer today. `gateway` is the row itself, for
 * the caller that goes on to issue a payment against it and snapshots what it promised.
 */
export interface OfferedRoute {
  readonly provider: PaymentGatewayProvider;
  /** Null means "the product's own name for this route", rendered from a template key. */
  readonly displayName: string | null;
  readonly topupCashbackPercent: number;
  readonly descriptor: PaymentGatewayDescriptor;
  readonly gateway: PaymentGatewayRecord;
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
 * `payments.gateways.view`, except `routesFor`, `offer` and `methodIsOffered`, which
 * charge nothing because their caller is a customer's own payment attempt rather than
 * an administrator.
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
  ): Promise<{
    gateways: readonly PaymentGatewayRecord[];
    currency: SalesCurrencyCode;
    facts: ReadonlyMap<PaymentGatewayProvider, GatewayOperatorFacts>;
  }> {
    await this.deps.guard.check(scope, actor, PAYMENT_GATEWAY_VIEW_PERMISSION);
    const [gateways, currency] = await Promise.all([
      this.deps.repository.list(scope),
      this.deps.settings.valueOf<SalesCurrencyCode>(scope, 'sales.currency'),
    ]);
    const facts = new Map<PaymentGatewayProvider, GatewayOperatorFacts>();
    for (const gateway of gateways)
      facts.set(gateway.provider, await this.factsFor(scope, gateway.provider));
    return { gateways, currency, facts };
  }

  /**
   * One route's credential state and generated callback. A set-at time, never a value;
   * no masked stand-in either (`********` can be resubmitted as the key).
   */
  async factsFor(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
  ): Promise<GatewayOperatorFacts> {
    if (!PAYMENT_GATEWAY_DESCRIPTORS[provider].requiresCredentials) {
      return { credentialSetAt: null, callbackUrl: null };
    }
    const [credentialSetAt, callbackUrl] = await Promise.all([
      this.deps.credentials.setAt(scope, provider),
      this.deps.callbackUrlFor(scope, provider),
    ]);
    return { credentialSetAt, callbackUrl };
  }

  /**
   * Replaces a route's API key (WP11A §13). Write-only.
   *
   * Charges `payments.gateways.edit`, the authority over the route itself. The key is
   * encrypted at rest by the credential store and exists in plaintext only in this
   * call's argument. It is NOT in the request hash — the hash is stored — so a replay
   * under the same key answers with the route as it stands, the rule panels follow for
   * their credentials. The audit row records that the key was replaced and when; never
   * the key, never a fingerprint of it.
   *
   * Refused for a route that takes no credential: storing one would be a value nothing
   * reads, which is the write-only-setting defect.
   */
  async setCredential(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly provider: string;
      readonly apiKey: string;
    },
  ): Promise<PaymentGatewayRecord> {
    const provider = this.provider(input.provider);
    const denial = {
      action: 'payment_gateway.set_credential',
      entityType: 'PaymentGateway',
      entityId: provider,
    };
    await this.authorize(scope, actor, denial);
    if (!PAYMENT_GATEWAY_DESCRIPTORS[provider].requiresCredentials) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This payment route takes no credential.',
      );
    }
    const requestHash = hashRequest({ provider, credential: 'API_KEY' });
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
        const gateway = await this.require(scope, provider, tx);
        const before = await this.deps.credentials.setAt(scope, provider, tx);
        const setAt = await this.deps.credentials.replace(scope, provider, input.apiKey, now, tx);
        await this.record(scope, actor, tx, {
          action: 'payment_gateway.set_credential',
          entityId: provider,
          /*
           * Named so the audit redactor keeps them: it fails closed on any key containing
           * `apikey` or `credential`, and these carry no secret — only whether a key was
           * stored and when it was replaced.
           */
          before: {
            provider,
            configured: before !== null,
            replacedAt: before?.toISOString() ?? null,
          },
          after: { provider, configured: true, replacedAt: setAt.toISOString() },
        });
        await this.remember(scope, input.idempotencyKey, requestHash, provider, tx);
        return gateway;
      },
    );
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
      readonly config: PaymentGatewayConfigInput;
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
      // In the hash, so two edits differing only in the gift are two commands (D5).
      topupCashbackPercent: input.config.topupCashbackPercent,
      // And the two purpose switches, for the same reason: switching top-up off is an
      // edit, and a key reused for it must not replay the edit that left it on.
      allowServicePurchase: input.config.allowServicePurchase,
      allowWalletTopup: input.config.allowWalletTopup,
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
        /*
         * A switch the request did not carry keeps the row's value. The previous
         * release's client sends neither, and a form with no field for a switch has
         * nothing to say about it — defaulting an absent one to ON would re-enable a
         * payment path an operator had switched off, from an edit to the display name.
         */
        const config: PaymentGatewayConfig = {
          ...input.config,
          allowServicePurchase: input.config.allowServicePurchase ?? before.allowServicePurchase,
          allowWalletTopup: input.config.allowWalletTopup ?? before.allowWalletTopup,
        };
        const after = await this.deps.repository.update(scope, provider, config, currency, now, tx);
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
        /*
         * A route that needs a credential cannot be switched ON without one (WP11A): an
         * active route with no key is one every customer who chooses it is refused by —
         * the panels rule that a route which cannot be operated must not be offered.
         * Read inside the transaction, so a key and the enable are one decision.
         */
        if (
          input.status === 'ACTIVE' &&
          PAYMENT_GATEWAY_DESCRIPTORS[provider].requiresCredentials &&
          (await this.deps.credentials.setAt(scope, provider, tx)) === null
        ) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
            'This payment route needs its API key before it can be switched on.',
            { reason: 'CREDENTIAL_MISSING' },
          );
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
   * Every route a customer may be SHOWN for a purpose, in the operator's order.
   *
   * A route is in the list when it is ACTIVE, switched on for `purpose`, admits this
   * customer under its thresholds, and — when an amount is given — admits the amount
   * under its own bounds. Ordered `(sortOrder, provider)`, which is the order the
   * repository reads and every surface renders. Each item carries its descriptor, so
   * what a surface draws for a route is decided from the descriptor and never from the
   * provider's name.
   *
   * The amount is OPTIONAL because the two callers ask at different moments: the
   * pre-invoice asks before any amount is typed and needs to know whether to draw a
   * button at all, while the top-up chooser asks for an amount the customer has already
   * given and must show only the routes that will take it. Passing null means "do not
   * decide the amount here"; `assertAmountAccepted` is the throwing check for a caller
   * that has already chosen.
   *
   * No permission check, for the reason `offer` gives: the caller is a customer's own
   * payment attempt, it takes a customer id and reads configuration, and it writes
   * nothing. Inside a transaction the list is read FOR SHARE — see the repository.
   */
  async routesFor(
    scope: TenantContext,
    customerId: UserId,
    purpose: PaymentPurpose,
    amount: Money | null,
    tx?: unknown,
  ): Promise<readonly OfferedRoute[]> {
    const { routes } = await this.evaluateRoutes(scope, customerId, purpose, amount, tx);
    return routes;
  }

  /**
   * The route a customer's TOP-UP of this amount should be issued against.
   *
   * `routesFor(WALLET_TOPUP)`'s first answer, with the refusals a caller that needs
   * exactly one route deserves. The amount is deliberately NOT passed to the filter:
   * `assertAmountAccepted` is where an amount outside the chosen route's window is
   * refused, and it refuses with `PAYMENT_GATEWAY_AMOUNT_REJECTED` — a misconfiguration
   * an operator can act on, which "no route available" would hide.
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
   * the chooser built over `routesFor` decides nothing this method would not.
   */
  async offer(
    scope: TenantContext,
    customerId: UserId,
    amount: Money,
    tx?: unknown,
  ): Promise<OfferedGateway> {
    const { gateways, audience, routes } = await this.evaluateRoutes(
      scope,
      customerId,
      'WALLET_TOPUP',
      null,
      tx,
    );
    if (gateways.length === 0) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
        'No payment route is configured.',
        { reason: 'NO_GATEWAYS' },
      );
    }

    /*
     * The first route that settles by MANUAL TRANSFER. `offer`'s one caller issues a
     * card-to-card top-up against the route it returns and snapshots that route's name
     * and gift onto it; an external route sorted first would otherwise produce a manual
     * transfer wearing a gateway's name and promise (WP11A audit §1).
     */
    const eligible = routes.find((route) => route.descriptor.settlesVia === 'MANUAL_TRANSFER');
    if (eligible === undefined) {
      /*
       * The reasons go to the DETAIL, not to the message. An operator reading the
       * operational log needs to know it was `TOO_FEW_PAYMENTS` on every route; the
       * customer needs to know they cannot pay this way right now, and nothing more.
       */
      const reasons = gateways.map((gateway) => {
        const verdict = evaluateGatewayEligibility(gateway.status, gateway, audience);
        if (!verdict.eligible) return `${gateway.provider}:${verdict.reason}`;
        return `${gateway.provider}:${
          allowsPurpose(gateway, 'WALLET_TOPUP') ? 'ELIGIBLE' : 'PURPOSE_NOT_ALLOWED'
        }`;
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
    const bounds = boundsOf(eligible.gateway, amount.currency);
    return { gateway: eligible.gateway, minAmount: bounds.minAmount, maxAmount: bounds.maxAmount };
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
    const verdict = decideAmount(
      { minAmount: offered.minAmount, maxAmount: offered.maxAmount },
      amount,
    );
    if (verdict.admitted) return;
    if (verdict.reason === 'BOUND_CURRENCY_MISMATCH') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
        'This payment route is configured in another currency.',
        { reason: 'BOUND_CURRENCY_MISMATCH' },
      );
    }
    throw errors.conflict(
      COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED,
      verdict.reason === 'BELOW_MINIMUM'
        ? 'That amount is below what this payment route accepts.'
        : 'That amount is above what this payment route accepts.',
      {
        side: verdict.reason,
        boundMinor: verdict.bound.amountMinor.toString(),
        currency: verdict.bound.currency,
      },
    );
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
    /*
     * The purpose the route is being offered FOR. Defaults to a purchase, because every
     * caller before the switches existed was asking on behalf of an order; the top-up
     * chooser asks `routesFor` directly and never comes through here.
     */
    purpose: PaymentPurpose = 'SERVICE_PURCHASE',
  ): Promise<boolean> {
    const gateways = await this.deps.repository.list(scope, tx);
    return gateways.some(
      (gateway) =>
        gateway.status === 'ACTIVE' &&
        allowsPurpose(gateway, purpose) &&
        this.settlementMethodFor(gateway.provider) === method,
    );
  }

  /** How the chosen route settles, from the descriptor rather than from its name. */
  settlementMethodFor(provider: PaymentGatewayProvider) {
    return PAYMENT_GATEWAY_DESCRIPTORS[provider].settlesVia;
  }

  // -------------------------------------------------------------------------

  /**
   * The one evaluation behind `routesFor` and `offer`.
   *
   * Returns the unfiltered roster and the audience beside the answer, because `offer`
   * owes an operator the per-route reasons when nothing is offered, and computing them
   * from a second read would be a second answer to the same question. The predicates
   * are applied in the order an operator would expect a reason in: switched off, then
   * not for this purpose, then the customer's thresholds, then the amount.
   */
  private async evaluateRoutes(
    scope: TenantContext,
    customerId: UserId,
    purpose: PaymentPurpose,
    amount: Money | null,
    tx?: unknown,
  ): Promise<{
    readonly gateways: readonly PaymentGatewayRecord[];
    readonly audience: GatewayAudience;
    readonly routes: readonly OfferedRoute[];
  }> {
    const gateways = await this.deps.repository.list(scope, tx);
    const audience = await this.audienceFor(scope, customerId, tx);
    /*
     * A route that settles by manual transfer needs somewhere for the money to go. With
     * no enabled account the route is CONFIGURED and cannot be paid through, and the
     * customer would learn that on the last tap — after typing an amount and choosing
     * it. So the destination is part of what makes the route offerable, for both
     * purposes, and its absence drops the route from the list rather than the tap.
     */
    const destination = await this.deps.accounts.hasEnabled(scope, tx);
    const routes = gateways
      .filter(
        (gateway) =>
          gateway.status === 'ACTIVE' &&
          (PAYMENT_GATEWAY_DESCRIPTORS[gateway.provider].settlesVia !== 'MANUAL_TRANSFER' ||
            destination) &&
          allowsPurpose(gateway, purpose) &&
          evaluateGatewayEligibility(gateway.status, gateway, audience).eligible &&
          /*
           * The amount, against the row's OWN denomination — `boundsOf` says why the
           * fallback is the amount's currency and why that is the only case it stands
           * in for. A window in another currency admits nothing, so such a route drops
           * out of the list rather than being shown and refused a tap later.
           */
          (amount === null || decideAmount(boundsOf(gateway, amount.currency), amount).admitted) &&
          /*
           * An external route whose provider has no exact value for this amount (TonPays
           * takes whole Toman) cannot invoice it, so it is not offered for it — rather
           * than drawn and then refused at the tap.
           */
          (amount === null || this.adapterAdmits(gateway.provider, amount)),
      )
      .map((gateway) => ({
        provider: gateway.provider,
        displayName: gateway.displayName,
        topupCashbackPercent: gateway.topupCashbackPercent,
        descriptor: PAYMENT_GATEWAY_DESCRIPTORS[gateway.provider],
        gateway,
      }));
    return { gateways, audience, routes };
  }

  private adapterAdmits(provider: PaymentGatewayProvider, amount: Money): boolean {
    if (PAYMENT_GATEWAY_DESCRIPTORS[provider].settlesVia !== 'GATEWAY') return true;
    const adapter = this.deps.adapters(provider);
    return adapter !== null && adapter.providerAmountOf(amount) !== null;
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
    topupCashbackPercent: gateway.topupCashbackPercent,
    allowServicePurchase: gateway.allowServicePurchase,
    allowWalletTopup: gateway.allowWalletTopup,
  };
}
