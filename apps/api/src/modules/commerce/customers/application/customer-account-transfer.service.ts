import {
  COMMERCE_ERROR_CODES,
  SERVICE_TRANSFERABLE_STATES,
  errors,
  money,
  telegramUserIdSchema,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type CustomerTransferBlocker,
  type CustomerTransferWarning,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import { adminIdOf } from '../../../platform/identity/application/authentication.service.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ServiceRecord, ServiceRepository } from '../../provisioning/application/ports.js';
import type { ServiceTransferRepository } from '../../provisioning/application/service-transfer-ports.js';
import type { ServiceTransferService } from '../../provisioning/application/service-transfer.service.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { CUSTOMER_VIEW_PERMISSION } from './customer.service.js';
import type { CustomerRecord, CustomerRepository } from './ports.js';

/** CRITICAL: moves every movable service and the whole balance from one identity to another. */
export const ACCOUNT_TRANSFER_PERMISSION: PermissionKey = 'users.transfer';

// --- ports ----------------------------------------------------------------------------

/** What the preview and the transfer decide from, read in one round trip. */
export interface AccountTransferFacts {
  readonly services: readonly {
    readonly id: string;
    readonly state: string;
    readonly isTrial: boolean;
    readonly providerUsername: string;
    /** Paid back and deleted at the customer's own request (WP19): history, never moved. */
    readonly refundedAway: boolean;
  }[];
  readonly orders: number;
  /** `AWAITING_PAYMENT`, or `PAID` with no service yet: money in flight either way. */
  readonly ordersInProgress: number;
  readonly payments: number;
  /** `CONFIRMED` payments: money a later refund would credit back to the SOURCE. */
  readonly confirmedPayments: number;
  /** `PENDING` or `UNKNOWN`: a payment that may still settle against the source. */
  readonly pendingPayments: number;
  readonly isReseller: boolean;
  /** Cashback or referral commission promised to the source and not yet earned. */
  readonly pendingRewards: number;
  readonly pendingBulkItems: number;
  readonly referredCustomers: number;
  readonly referredBy: boolean;
  readonly openTickets: number;
  readonly trialOverride: boolean;
  readonly locationOverride: boolean;
}

export interface AccountTransferRecord {
  readonly id: string;
  readonly fromCustomerId: UserId;
  readonly toCustomerId: UserId;
  readonly idempotencyKey: string;
  readonly serviceIds: readonly string[];
  readonly walletAmount: bigint;
  readonly currency: CurrencyCode;
  readonly fingerprint: string;
  readonly createdAt: Date;
}

export interface AccountTransferDraft {
  readonly id: string;
  readonly fromCustomerId: UserId;
  readonly toCustomerId: UserId;
  readonly idempotencyKey: string;
  readonly serviceIds: readonly string[];
  readonly walletAmount: bigint;
  readonly currency: CurrencyCode;
  readonly debitEntryId: string | null;
  readonly creditEntryId: string | null;
  readonly fingerprint: string;
  readonly reason: string;
  readonly actorAdminId: string | null;
  readonly correlationId: string;
  readonly now: Date;
}

export interface CustomerAccountTransferRepository {
  facts(scope: TenantContext, sourceId: UserId, tx?: unknown): Promise<AccountTransferFacts>;
  isReseller(scope: TenantContext, customerId: UserId, tx?: unknown): Promise<boolean>;
  /**
   * The service's row lock (`FOR NO KEY UPDATE`) and its lifecycle lock, each TRIED: false,
   * holding nothing new that matters, when another transaction holds either.
   */
  tryLockService(scope: TenantContext, serviceId: string, tx: TransactionScope): Promise<boolean>;
  findByKey(
    scope: TenantContext,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<AccountTransferRecord | null>;
  create(
    scope: TenantContext,
    draft: AccountTransferDraft,
    tx: TransactionScope,
  ): Promise<AccountTransferRecord>;
}

export interface CustomerAccountTransferDeps {
  readonly repository: CustomerAccountTransferRepository;
  readonly customers: Pick<CustomerRepository, 'findById' | 'list'>;
  readonly services: Pick<ServiceRepository, 'findForCustomer'>;
  readonly serviceTransfers: Pick<ServiceTransferRepository, 'create' | 'reassign'>;
  /** The ONE evaluator of whether a service may change hands (Package F). */
  readonly transferability: Pick<ServiceTransferService, 'ineligibilityOf'>;
  readonly wallet: Pick<WalletRepository, 'lockCustomer' | 'balanceOf' | 'append'>;
  /** `sales.currency`: the denomination a wallet balance is held and moved in. */
  readonly sellingCurrency: (scope: TenantContext, tx?: unknown) => Promise<CurrencyCode>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

// --- the plan ---------------------------------------------------------------------------

/** What a transfer would do now — the preview's answer, and what the transfer re-derives. */
export interface AccountTransferPlan {
  readonly source: CustomerRecord;
  readonly destination: CustomerRecord | null;
  readonly moves: {
    readonly services: readonly ServiceRecord[];
    readonly walletAmount: bigint;
    readonly currency: CurrencyCode;
  };
  readonly stays: {
    readonly closedServices: number;
    readonly trialServices: number;
    readonly orders: number;
    readonly payments: number;
    readonly referredCustomers: number;
    readonly referredBy: boolean;
    readonly openTickets: number;
    readonly trialOverride: boolean;
    readonly locationOverride: boolean;
    readonly channelExemption: boolean;
    readonly verifiedPhone: boolean;
  };
  readonly blockers: readonly CustomerTransferBlocker[];
  readonly warnings: readonly CustomerTransferWarning[];
  readonly fingerprint: string;
}

export interface AccountTransferResult {
  readonly transfer: AccountTransferRecord;
  readonly replayed: boolean;
}

/**
 * Customer 360's account transfer (spec §11.5, `docs/customer-account-transfer-audit.md`).
 *
 * NOT a Telegram-id UPDATE. The customer row — the identity, the history, the referral
 * attribution, the source's own settings — stays exactly where it is. What moves is what a
 * customer HOLDS:
 *
 * - every service the Package F evaluator says may change hands, each through its own
 *   `service_ownership_transfers` row, which is the only way the database admits a change
 *   of `services.customer_id`;
 * - the whole wallet balance in the selling currency, as a DEBIT of the source and a CREDIT
 *   of the destination — two append-only ledger entries, never a balance overwrite.
 *
 * Anything that could still settle against the source — an order awaiting payment or not
 * yet delivered, a pending payment, a promised reward, a pending bulk item, a service with
 * an undecided operation — REFUSES the whole transfer rather than being moved half-way or
 * left to land on an account nobody uses. Nothing the destination owns is touched, so no
 * destination state can be overwritten.
 *
 * One transaction: both customers' wallet locks in id order (the canonical `customer ->
 * service` order), the plan re-derived under them, the fingerprint the operator confirmed
 * compared, then every write, the audit rows and the events. A replay of the key answers
 * the transfer it already wrote.
 */
export class CustomerAccountTransferService {
  constructor(private readonly deps: CustomerAccountTransferDeps) {}

  /** The preview: what would move, what stays, and why it cannot run if it cannot. A read. */
  async preview(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly sourceId: string; readonly destinationTelegramUserId: string },
  ): Promise<AccountTransferPlan> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
    await this.deps.guard.check(scope, actor, ACCOUNT_TRANSFER_PERMISSION);
    const sourceId = this.customerId(input.sourceId);
    const source = await this.deps.customers.findById(scope, sourceId);
    if (source === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    const destination = await this.findByTelegramId(scope, input.destinationTelegramUserId);
    return this.plan(scope, source, destination);
  }

  /** The transfer itself. See the class docblock. */
  async transfer(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly sourceId: string;
      readonly destinationTelegramUserId: string;
      readonly fingerprint: string;
      readonly confirmTelegramUserId: string;
      readonly reason: string;
    },
  ): Promise<AccountTransferResult> {
    const sourceId = this.customerId(input.sourceId);
    const denial = {
      action: 'customer.account_transfer',
      entityType: 'Customer',
      entityId: sourceId,
    };
    try {
      await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
      await this.deps.guard.check(scope, actor, ACCOUNT_TRANSFER_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        ACCOUNT_TRANSFER_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    const reason = input.reason.trim();
    if (reason === '') {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'An account transfer needs a reason.',
      );
    }
    // The explicit confirmation: the operator typed the destination's numeric id again.
    if (asciiDigits(input.confirmTelegramUserId) !== input.destinationTelegramUserId) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_CONFIRMATION_MISMATCH,
        'The confirmation does not name the destination account.',
      );
    }

    // A replay — the same key — answers the transfer it wrote, whatever has happened since.
    const replayed = await this.deps.repository.findByKey(scope, input.idempotencyKey);
    if (replayed !== null) return this.replayOf(replayed, sourceId, input);

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      ACCOUNT_TRANSFER_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const found = await this.findByTelegramId(scope, input.destinationTelegramUserId, tx);
        /*
         * Both customers' wallet locks, NEWEST FIRST (UUIDv7 ids sort by creation). That is
         * the referral order — a refund takes the referee (newer) and then the referrer
         * (older), and nothing takes older-then-newer — and a source and destination in a
         * referral relationship is the likely pair (`docs/customer-account-transfer-audit.md` §4).
         */
        const ids =
          found === null || found.id === sourceId
            ? [sourceId]
            : [sourceId, found.id].sort((a, b) => b.localeCompare(a));
        for (const id of ids) {
          if (!(await this.deps.wallet.lockCustomer(scope, id, tx))) {
            throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
          }
        }
        /*
         * The key AGAIN, now that the locks are held: a concurrent submission of this very
         * key that committed while this one waited is answered as its replay, never as a
         * stale preview of an account it already emptied.
         */
        const raced = await this.deps.repository.findByKey(scope, input.idempotencyKey, tx);
        if (raced !== null) return this.replayOf(raced, sourceId, input);
        // The destination as it is under its lock — a block that committed meanwhile counts.
        const destination =
          found === null ? null : await this.deps.customers.findById(scope, found.id, tx);

        /*
         * Refuse an undecided provider state from the facts, BEFORE any service lock.
         *
         * A provisioning refund holds such a service's row and then takes its customer's
         * wallet lock (`refundPurchase` → `refundUndeliverable`); taking that row here, while
         * holding the customer, would be the reverse order and a deadlock either side can lose.
         */
        const preliminary = await this.deps.repository.facts(scope, sourceId, tx);
        const live = preliminary.services.filter(
          (service) => !service.isTrial && !service.refundedAway && LIVE_STATES.has(service.state),
        );
        if (live.some((service) => !SETTLED_STATES.has(service.state))) {
          throw refused(['SERVICE_UNSETTLED']);
        }
        /*
         * Each movable service's row lock, then its lifecycle lock — TRIED, never waited for.
         * Anything holding a service lock may next want a customer lock this transaction
         * already holds (a customer's own service transfer takes the row and then the
         * customers' key-share locks), so waiting here could close a cycle. A service some
         * other command holds is in flight, and the transfer is refused as unsettled.
         */
        for (const service of live) {
          if (!(await this.deps.repository.tryLockService(scope, service.id, tx))) {
            throw refused(['SERVICE_UNSETTLED']);
          }
        }

        const source = await this.deps.customers.findById(scope, sourceId, tx);
        if (source === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        const plan = await this.plan(scope, source, destination, tx);
        if (plan.blockers.length > 0 || plan.destination === null) {
          throw refused(plan.blockers);
        }
        if (plan.fingerprint !== input.fingerprint) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_PREVIEW_STALE,
            'What would move has changed since the preview. Preview again.',
          );
        }
        const target = plan.destination;
        const transferId = this.deps.ids.uuid();

        // 1. Every movable service: the ownership row FIRST, then the owner.
        for (const service of plan.moves.services) {
          const written = await this.deps.serviceTransfers.create(
            scope,
            {
              id: this.deps.ids.uuid(),
              serviceId: service.id,
              fromCustomerId: source.id,
              toCustomerId: target.id,
              botInstanceId: null,
              idempotencyKey: `account-transfer:${transferId}:${service.id}`,
              actorType: actor.type,
              actorLabel: actor.label,
              correlationId: actor.correlationId,
              now,
            },
            tx,
          );
          if (written === null) {
            throw new Error(`service transfer key for ${service.id} already written`);
          }
          const moved = await this.deps.serviceTransfers.reassign(
            scope,
            { serviceId: service.id, fromCustomerId: source.id, toCustomerId: target.id, now },
            tx,
          );
          if (!moved) throw new Error(`service ${service.id} changed owner under its row lock`);
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'service.transfer',
              entityType: 'Service',
              entityId: service.id,
              before: { customerId: source.id },
              after: {
                customerId: target.id,
                transferId: written.id,
                accountTransferId: transferId,
              },
              result: 'SUCCESS',
              reason,
            },
            tx,
          );
          await this.deps.outbox.write(tx, actor, {
            eventType: 'ServiceOwnershipTransferred',
            aggregateType: 'Service',
            aggregateId: service.id,
            payload: { serviceId: service.id, fromCustomerId: source.id, toCustomerId: target.id },
          });
        }

        // 2. The balance: a DEBIT of the source and a CREDIT of the destination, one amount.
        const amount = plan.moves.walletAmount;
        let debitEntryId: string | null = null;
        let creditEntryId: string | null = null;
        if (amount > 0n) {
          const value = money(amount, plan.moves.currency);
          const actorAdminId = adminIdOf(actor);
          const note = `account transfer ${transferId}`;
          for (const leg of [
            { customerId: source.id, direction: 'DEBIT', reason: 'ACCOUNT_TRANSFER_OUT' },
            { customerId: target.id, direction: 'CREDIT', reason: 'ACCOUNT_TRANSFER_IN' },
          ] as const) {
            const { entry } = await this.deps.wallet.append(
              scope,
              {
                id: this.deps.ids.uuid(),
                customerId: leg.customerId,
                direction: leg.direction,
                reason: leg.reason,
                amount: value,
                reference: `account-transfer:${transferId}:${leg.direction.toLowerCase()}`,
                actorAdminId,
                note,
                now,
              },
              tx,
            );
            if (leg.direction === 'DEBIT') debitEntryId = entry.id;
            else creditEntryId = entry.id;
            await this.deps.audit.record(
              scope,
              actor,
              {
                action: leg.direction === 'DEBIT' ? 'wallet.transfer_out' : 'wallet.transfer_in',
                entityType: 'Wallet',
                entityId: leg.customerId,
                before: null,
                after: {
                  entryId: entry.id,
                  direction: entry.direction,
                  reason: entry.reason,
                  amountMinor: entry.amount.amountMinor.toString(),
                  currency: entry.amount.currency,
                  accountTransferId: transferId,
                },
                result: 'SUCCESS',
                reason,
              },
              tx,
            );
            await this.deps.outbox.write(tx, actor, {
              eventType: 'WalletEntryRecorded',
              aggregateType: 'Wallet',
              aggregateId: leg.customerId,
              payload: {
                customerId: leg.customerId,
                entryId: entry.id,
                direction: entry.direction,
                reason: entry.reason,
                amountMinor: entry.amount.amountMinor.toString(),
                currency: entry.amount.currency,
              },
            });
          }
        }

        // 3. The record, the audit rows on both customers, and the event.
        const record = await this.deps.repository.create(
          scope,
          {
            id: transferId,
            fromCustomerId: source.id,
            toCustomerId: target.id,
            idempotencyKey: input.idempotencyKey,
            serviceIds: plan.moves.services.map((service) => service.id),
            walletAmount: amount,
            currency: plan.moves.currency,
            debitEntryId,
            creditEntryId,
            fingerprint: plan.fingerprint,
            reason,
            actorAdminId: adminIdOf(actor),
            correlationId: actor.correlationId,
            now,
          },
          tx,
        );
        const summary = {
          transferId,
          fromCustomerId: source.id,
          toCustomerId: target.id,
          fromTelegramUserId: source.telegramUserId,
          toTelegramUserId: target.telegramUserId,
          servicesMoved: plan.moves.services.length,
          walletMovedMinor: amount.toString(),
          currency: plan.moves.currency,
        };
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'customer.account_transfer',
            entityType: 'Customer',
            entityId: source.id,
            before: null,
            after: summary,
            result: 'SUCCESS',
            reason,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'customer.account_transfer.received',
            entityType: 'Customer',
            entityId: target.id,
            before: null,
            after: summary,
            result: 'SUCCESS',
            reason,
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'CustomerAccountTransferred',
          aggregateType: 'Customer',
          aggregateId: source.id,
          payload: {
            transferId,
            fromCustomerId: source.id,
            toCustomerId: target.id,
            servicesMoved: plan.moves.services.length,
            walletMovedMinor: amount.toString(),
            currency: plan.moves.currency,
          },
        });
        return { transfer: record, replayed: false };
      },
    );
  }

  // --- the plan ---------------------------------------------------------------------------

  /**
   * What a transfer would do, decided from the rows. The preview reads it without locks;
   * the transfer reads it again under every lock it takes, so the two can differ only by
   * what changed in between — which the fingerprint then refuses.
   */
  async plan(
    scope: TenantContext,
    source: CustomerRecord,
    destination: CustomerRecord | null,
    tx?: TransactionScope,
  ): Promise<AccountTransferPlan> {
    const facts = await this.deps.repository.facts(scope, source.id, tx);
    const currency = await this.deps.sellingCurrency(scope, tx);
    const balance = (await this.deps.wallet.balanceOf(scope, source.id, currency, tx)).amountMinor;

    const blockers: CustomerTransferBlocker[] = [];
    const warnings: CustomerTransferWarning[] = [];
    if (destination === null) blockers.push('DESTINATION_UNKNOWN');
    else if (destination.id === source.id) blockers.push('SAME_CUSTOMER');
    else if (destination.status !== 'ACTIVE') blockers.push('DESTINATION_BLOCKED');
    if (facts.isReseller) blockers.push('SOURCE_IS_RESELLER');
    if (balance < 0n) blockers.push('SOURCE_BALANCE_NEGATIVE');
    if (facts.ordersInProgress > 0) blockers.push('ORDER_IN_PROGRESS');
    if (facts.pendingPayments > 0) blockers.push('PAYMENT_PENDING');
    if (facts.pendingRewards > 0) blockers.push('REWARD_PENDING');
    if (facts.pendingBulkItems > 0) blockers.push('BULK_OPERATION_PENDING');

    const moving: ServiceRecord[] = [];
    let unsettled = false;
    let closed = 0;
    let trials = 0;
    for (const service of facts.services) {
      if (service.refundedAway || !LIVE_STATES.has(service.state)) {
        closed += 1;
        continue;
      }
      if (service.isTrial) {
        trials += 1;
        continue;
      }
      const record = await this.deps.services.findForCustomer(scope, source.id, service.id, tx);
      if (record === null) {
        closed += 1;
        continue;
      }
      // An undecided provider state, or anything Package F refuses: never moved half-way.
      if (
        !(SERVICE_TRANSFERABLE_STATES as readonly string[]).includes(record.state) ||
        (await this.deps.transferability.ineligibilityOf(scope, record, tx)) !== null
      ) {
        unsettled = true;
        continue;
      }
      moving.push(record);
    }
    if (unsettled) blockers.push('SERVICE_UNSETTLED');
    const walletAmount = balance > 0n ? balance : 0n;
    if (moving.length === 0 && walletAmount === 0n) blockers.push('NOTHING_TO_MOVE');

    if (
      destination !== null &&
      destination.id !== source.id &&
      (await this.deps.repository.isReseller(scope, destination.id, tx))
    ) {
      warnings.push('DESTINATION_IS_RESELLER');
    }
    if (trials > 0) warnings.push('TRIAL_SERVICES_STAY');
    const overrides =
      facts.trialOverride ||
      facts.locationOverride ||
      source.channelMembershipExemptAt !== null ||
      source.phoneNumber !== null ||
      // The promotional opt-out is the source's own setting too (Codex review of #146).
      source.marketingOptOutAt !== null;
    if (overrides) warnings.push('SOURCE_OVERRIDES_STAY');
    if (facts.openTickets > 0) warnings.push('OPEN_TICKETS_STAY');
    // Credits tied to the source's history keep landing on the source (audit §5).
    if (facts.referredCustomers > 0) warnings.push('REFERRAL_CREDITS_STAY');
    if (facts.confirmedPayments > 0) warnings.push('REFUNDS_CREDIT_SOURCE');

    return {
      source,
      destination,
      moves: { services: moving, walletAmount, currency },
      stays: {
        closedServices: closed,
        trialServices: trials,
        orders: facts.orders,
        payments: facts.payments,
        referredCustomers: facts.referredCustomers,
        referredBy: facts.referredBy,
        openTickets: facts.openTickets,
        trialOverride: facts.trialOverride,
        locationOverride: facts.locationOverride,
        channelExemption: source.channelMembershipExemptAt !== null,
        verifiedPhone: source.phoneNumber !== null,
      },
      blockers,
      warnings,
      fingerprint: hashRequest({
        source: source.id,
        destination: destination?.id ?? null,
        services: moving.map((service) => service.id),
        walletAmount: walletAmount.toString(),
        currency,
      }),
    };
  }

  // --- internals ---------------------------------------------------------------------------

  private replayOf(
    record: AccountTransferRecord,
    sourceId: UserId,
    input: { readonly fingerprint: string },
  ): AccountTransferResult {
    if (record.fromCustomerId !== sourceId || record.fingerprint !== input.fingerprint) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That idempotency key already transferred a different account.',
      );
    }
    return { transfer: record, replayed: true };
  }

  /** The customer of THIS tenant with that exact numeric id — the admin search's lookup. */
  private async findByTelegramId(
    scope: TenantContext,
    raw: string,
    tx?: unknown,
  ): Promise<CustomerRecord | null> {
    const parsed = telegramUserIdSchema.safeParse(asciiDigits(raw));
    if (!parsed.success) return null;
    const page = await this.deps.customers.list(
      scope,
      { telegramUserId: parsed.data },
      1,
      null,
      tx,
    );
    return page.items[0] ?? null;
  }

  private customerId(candidate: string): UserId {
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    return parsed.data;
  }
}

function refused(blockers: readonly CustomerTransferBlocker[]) {
  return errors.conflict(
    COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_REFUSED,
    'This account cannot be transferred now.',
    { blockers: [...blockers] },
  );
}

/** The live states a service may be moved from: decided on its panel, nothing undecided. */
const SETTLED_STATES: ReadonlySet<string> = new Set(['ACTIVE', 'SUSPENDED']);

/** States in which a service still exists on a panel for somebody. */
const LIVE_STATES: ReadonlySet<string> = new Set([
  'PENDING_PROVISION',
  'UNRECONCILED',
  'ACTIVE',
  'SUSPENDED',
]);

/** Persian and Arabic-Indic digits read as ASCII, whitespace dropped. */
function asciiDigits(text: string): string {
  return text
    .trim()
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660));
}
