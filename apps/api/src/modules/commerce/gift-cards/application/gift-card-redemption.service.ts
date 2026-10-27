import {
  COMMERCE_ERROR_CODES,
  GIFT_CARD_FAILED_WINDOW_MS,
  GIFT_CARD_MAX_FAILED_ATTEMPTS,
  errors,
  giftCardReference,
  money,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type GiftCardRejection,
  type IdGenerator,
  type IdempotencyNamespace,
  type IdempotencyStore,
  type Money,
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
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import { readWalletCurrency } from '../../../control/settings/application/signup-gift-terms.guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { hashGiftCardCode, normaliseGiftCardCode } from '../domain/gift-card-code.js';
import type { GiftCardRepository } from './ports.js';

/**
 * The permission every customer-initiated write charges (`ORDER_PLACE_PERMISSION`, the
 * capture windows): the customer is the actor and the wallet is their own, but the guard
 * still runs, deny by default, for every actor type.
 */
export const GIFT_CARD_REDEEM_PERMISSION: PermissionKey = 'maintenance.run';
export const GIFT_CARD_REDEEM_ACTION = 'gift_card.redeem';

export interface GiftCardRedemptionServiceDeps {
  readonly repository: GiftCardRepository;
  readonly wallet: Pick<WalletRepository, 'append' | 'lockCustomer' | 'balanceOf'>;
  readonly settings: SettingsResolver;
  readonly features: FeatureFlagResolver;
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

export type GiftCardRedeemResult =
  | {
      readonly outcome: 'REDEEMED';
      readonly amount: Money;
      /** The wallet balance after the credit, derived from the ledger in the same transaction. */
      readonly balance: Money;
      readonly batchId: string;
      readonly codeId: string;
      readonly entryId: string;
    }
  /**
   * Refused. `rejection` is for the attempt row, the tests and the operator; a surface shows
   * ONE sentence whatever it says, so the endpoint is no oracle for which codes exist.
   */
  | { readonly outcome: 'REJECTED'; readonly rejection: GiftCardRejection }
  /** Too many refusals in the window: the code was not read. */
  | { readonly outcome: 'RATE_LIMITED' };

/** What the idempotency store keeps. A bigint does not survive `jsonb`. */
type ReplayRecord =
  | {
      readonly outcome: 'REDEEMED';
      readonly amountMinor: string;
      readonly balanceMinor: string;
      readonly currency: CurrencyCode;
      readonly batchId: string;
      readonly codeId: string;
      readonly entryId: string;
    }
  | { readonly outcome: 'REJECTED'; readonly rejection: GiftCardRejection }
  | { readonly outcome: 'RATE_LIMITED' };

/**
 * A customer redeeming a gift card (R10 D4): the bot's capture window and the mini app's
 * wallet field both call `redeem`, so the two surfaces cannot disagree.
 *
 * ## One transaction, in this lock order
 *
 * 1. The customer's wallet lock (`lockCustomer`, the customer row FOR UPDATE). Every decision
 *    about THIS customer — the failed-attempt count, the per-customer limit — is made under
 *    it, so two concurrent requests of one customer are serialised and neither can slip under
 *    a limit the other is about to reach.
 * 2. The failed-attempt limiter, BEFORE the code is looked up: a customer over the limit is
 *    refused without the code being read, so a guesser learns nothing more once limited.
 * 3. The batch, FOR SHARE: any number of customers redeem one batch at once, and a disable
 *    (FOR UPDATE on the batch) waits for them, so a batch disabled after the check below
 *    cannot have its code redeemed by a transaction that read it ACTIVE.
 * 4. The code row's conditional UPDATE — the decision that the code is spent. Zero rows is
 *    USED (another redeemer won). Whether it was already redeemed is decided by this UPDATE
 *    alone, never by an earlier read, which would mask its predicate.
 * 5. The ledger append under `giftcard:<codeId>`: unique per tenant, so even a writer that
 *    forgot step 4 cannot credit a code twice. An append that finds the entry already there
 *    while the UPDATE said "unspent" is a contradiction, and the transaction rolls back.
 *
 * Then the events (`WalletEntryRecorded`, `GiftCardRedeemed`) and the audit row, in the same
 * transaction. A refusal commits only its attempt row (and the idempotency record), so the
 * limiter counts it; the customer's balance and the code are untouched.
 *
 * Neither a top-up gift nor cashback is earned (no payment stands behind the credit), and a
 * negative wallet may redeem: a credit is never refused for the balance it lands on.
 */
export class GiftCardRedemptionService {
  constructor(private readonly deps: GiftCardRedemptionServiceDeps) {}

  /** Whether the feature is on — what the bot and the mini app read before drawing the entry. */
  isEnabled(scope: TenantContext, tx?: unknown): Promise<boolean> {
    return this.deps.features.isEnabled(scope, 'gift_cards', tx);
  }

  async redeem(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      /** As typed. Never stored, never logged: only its tenant-bound hash leaves this method. */
      readonly code: string;
      readonly idempotencyKey: string;
    },
  ): Promise<GiftCardRedeemResult> {
    const namespace: IdempotencyNamespace = actor.surface === 'MINI_APP' ? 'MINI_APP' : 'TELEGRAM';
    const normalised = normaliseGiftCardCode(input.code);
    const codeHash = normalised === null ? null : hashGiftCardCode(scope.tenantId, normalised);
    // The request hash names the code by its HASH, never by its text.
    const requestHash = hashRequest({
      customerId: input.customerId,
      codeHash,
      purpose: 'GIFT_CARD_REDEMPTION',
    });
    const denial = {
      action: GIFT_CARD_REDEEM_ACTION,
      entityType: 'Customer',
      entityId: input.customerId,
    };
    try {
      await this.deps.guard.check(scope, actor, GIFT_CARD_REDEEM_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.deps,
        scope,
        actor,
        GIFT_CARD_REDEEM_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    const replay = await this.deps.idempotency.find<ReplayRecord>(
      scope,
      namespace,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return fromReplay(replay.result);

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
      GIFT_CARD_REDEEM_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        if (!(await this.isEnabled(scope, tx))) {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.GIFT_CARDS_DISABLED,
            'Gift cards are switched off.',
          );
        }
        // 1. The customer's wallet lock, before anything is decided about them.
        if (!(await this.deps.wallet.lockCustomer(scope, input.customerId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        const now = this.deps.clock.now();

        // 2. The limiter, before the code is read.
        const failed = await this.deps.repository.countFailedSince(
          scope,
          input.customerId,
          new Date(now.getTime() - GIFT_CARD_FAILED_WINDOW_MS),
          tx,
        );
        if (failed >= GIFT_CARD_MAX_FAILED_ATTEMPTS) {
          return this.finish(scope, namespace, input.idempotencyKey, requestHash, tx, {
            outcome: 'RATE_LIMITED',
          });
        }

        const decided = await this.decide(scope, actor, input.customerId, codeHash, now, tx);
        if (decided.outcome === 'REJECTED') {
          await this.deps.repository.recordAttempt(
            scope,
            {
              id: this.deps.ids.uuid(),
              customerId: input.customerId,
              at: now,
              outcome: decided.rejection,
              codeId: decided.codeId,
            },
            tx,
          );
          return this.finish(scope, namespace, input.idempotencyKey, requestHash, tx, {
            outcome: 'REJECTED',
            rejection: decided.rejection,
          });
        }
        return this.finish(scope, namespace, input.idempotencyKey, requestHash, tx, decided.result);
      },
    );
  }

  /** Steps 3–5, inside the transaction and under the customer's lock. */
  private async decide(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    codeHash: string | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<
    | {
        readonly outcome: 'REJECTED';
        readonly rejection: GiftCardRejection;
        readonly codeId: string | null;
      }
    | { readonly outcome: 'REDEEMED'; readonly result: ReplayRecord }
  > {
    if (codeHash === null) return { outcome: 'REJECTED', rejection: 'MALFORMED', codeId: null };
    const code = await this.deps.repository.findCodeByHash(scope, codeHash, tx);
    if (code === null) return { outcome: 'REJECTED', rejection: 'UNKNOWN', codeId: null };
    const reject = (rejection: GiftCardRejection) =>
      ({ outcome: 'REJECTED', rejection, codeId: code.id }) as const;

    // 3. The batch, FOR SHARE.
    const batch = await this.deps.repository.findBatch(scope, code.batchId, { lock: 'share' }, tx);
    if (batch === null) return reject('UNKNOWN');
    if (batch.state !== 'ACTIVE') return reject('DISABLED');
    // Half-open: redeemable while now < expires_at, and not at the instant itself.
    if (now.getTime() >= batch.expiresAt.getTime()) return reject('EXPIRED');
    // A batch minted before `sales.currency` changed is refused, never converted: no rate
    // exists to convert it at, and a credit the wallet does not sum is a credit nobody sees.
    const walletCurrency = await readWalletCurrency(this.deps.settings, scope, tx);
    if (batch.amount.currency !== walletCurrency) return reject('CURRENCY_MISMATCH');
    // Counted under the customer's lock (step 1), so it is a decision and not an estimate.
    if (batch.perCustomerLimit !== null) {
      const used = await this.deps.repository.countRedeemedBy(scope, batch.id, customerId, tx);
      if (used >= batch.perCustomerLimit) return reject('LIMIT_REACHED');
    }

    // 4. The conditional UPDATE decides that the code is spent.
    const entryId = this.deps.ids.uuid();
    const stamped = await this.deps.repository.redeemCode(
      scope,
      { codeId: code.id, customerId, entryId, now },
      tx,
    );
    if (!stamped) return reject('USED');

    // 5. The credit, under the code's own reference.
    const { entry, inserted } = await this.deps.wallet.append(
      scope,
      {
        id: entryId,
        customerId,
        direction: 'CREDIT',
        reason: 'GIFT_CARD_REDEMPTION',
        amount: batch.amount,
        reference: giftCardReference(code.id),
        now,
      },
      tx,
    );
    if (!inserted) {
      /*
       * The code row said unspent and the ledger already holds its credit: a writer reached
       * the ledger without the stamp. Loud, and the transaction rolls back with the stamp,
       * because the alternative is a second credit for one code.
       */
      throw new Error(
        `gift card ${code.id} already has ledger entry ${entry.id} although it was not redeemed`,
      );
    }
    await this.deps.outbox.write(tx, actor, {
      eventType: 'WalletEntryRecorded',
      aggregateType: 'Wallet',
      aggregateId: entry.customerId,
      payload: {
        customerId: entry.customerId,
        entryId: entry.id,
        direction: entry.direction,
        reason: entry.reason,
        amountMinor: entry.amount.amountMinor.toString(),
        currency: entry.amount.currency,
      },
    });
    await this.deps.outbox.write(tx, actor, {
      eventType: 'GiftCardRedeemed',
      aggregateType: 'Wallet',
      aggregateId: entry.customerId,
      payload: {
        batchId: batch.id,
        codeId: code.id,
        customerId,
        entryId: entry.id,
        amountMinor: entry.amount.amountMinor.toString(),
        currency: entry.amount.currency,
      },
    });
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: GIFT_CARD_REDEEM_ACTION,
        entityType: 'GiftCardCode',
        entityId: code.id,
        before: null,
        // The code's id and last four symbols: enough for support, never the code.
        after: {
          batchId: batch.id,
          customerId,
          last4: code.last4,
          entryId: entry.id,
          amountMinor: entry.amount.amountMinor.toString(),
          currency: entry.amount.currency,
        },
        result: 'SUCCESS',
      },
      tx,
    );
    const balance = await this.deps.wallet.balanceOf(scope, customerId, entry.amount.currency, tx);
    return {
      outcome: 'REDEEMED',
      result: {
        outcome: 'REDEEMED',
        amountMinor: entry.amount.amountMinor.toString(),
        balanceMinor: balance.amountMinor.toString(),
        currency: entry.amount.currency,
        batchId: batch.id,
        codeId: code.id,
        entryId: entry.id,
      },
    };
  }

  private async finish(
    scope: TenantContext,
    namespace: IdempotencyNamespace,
    key: string,
    requestHash: string,
    tx: TransactionScope,
    record: ReplayRecord,
  ): Promise<GiftCardRedeemResult> {
    await rememberOnce(this.deps.idempotency, scope, namespace, key, requestHash, record, tx);
    return fromReplay(record);
  }
}

function fromReplay(record: ReplayRecord): GiftCardRedeemResult {
  if (record.outcome !== 'REDEEMED') return record;
  return {
    outcome: 'REDEEMED',
    amount: money(BigInt(record.amountMinor), record.currency),
    balance: money(BigInt(record.balanceMinor), record.currency),
    batchId: record.batchId,
    codeId: record.codeId,
    entryId: record.entryId,
  };
}
