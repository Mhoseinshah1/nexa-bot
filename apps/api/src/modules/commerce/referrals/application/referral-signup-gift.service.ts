import {
  COMMERCE_ERROR_CODES,
  errors,
  money,
  referralSignupGiftReference,
  referralSignupGiftShares,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type ReferralSignupGiftSide,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import {
  readSignupGiftTerms,
  readWalletCurrency,
  signupGiftTermsProblem,
} from '../../../control/settings/application/signup-gift-terms.guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { REFERRAL_WEBHOOK_PERMISSION } from './referral-program.js';
import type {
  ReferralRepository,
  ReferralSignupGiftRecord,
  ReferralSignupGiftRepository,
} from './ports.js';

const REFERRAL_NAMESPACE = 'TELEGRAM';

export interface ReferralSignupGiftServiceDeps {
  readonly gifts: ReferralSignupGiftRepository;
  readonly referrals: Pick<ReferralRepository, 'countReferredBy'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly wallet: Pick<WalletRepository, 'append' | 'lockCustomer'>;
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

/** The gift's terms as they stand, read in one place so no caller decides "active" alone. */
export interface ReferralSignupGiftTerms {
  readonly active: boolean;
  readonly total: Money;
  readonly referrerPercent: number;
  readonly referredPercent: number;
}

/** One side of one referral the customer could be paid for now. */
export interface ClaimableSignupGift {
  readonly referralId: string;
  readonly side: ReferralSignupGiftSide;
}

export interface SignupGiftClaimResult {
  /** The sum credited to THIS customer by this call. Zero when nothing was owed. */
  readonly credited: Money;
  readonly claimedCount: number;
}

export interface ReferralStats {
  readonly referralCount: number;
  readonly referredPurchaseCount: number;
  readonly referredPurchaseTotal: Money;
  readonly commissionReceivedTotal: Money;
}

/** What the idempotency store keeps of a claim. A bigint does not survive `jsonb`. */
interface ClaimReplayRecord {
  readonly creditedMinor: string;
  readonly currency: CurrencyCode;
  readonly claimedCount: number;
}

/**
 * The membership gift a valid referral pays, once per side
 * (`docs/customer-ux-completion-audit.md` §I).
 *
 * Independent of the purchase commission: the amounts come from settings, never from a
 * ledger entry, so nothing here can compound. Each share is ONE `REFERRAL_SIGNUP_GIFT`
 * credit whose reference is unique per (referral, side) — the database's backstop for a
 * writer that forgets the lock — and the gift row's `<side>_claimed_at` is the decision
 * that a share has been paid.
 *
 * ## Lock order
 *
 * The claimant's referral rows in id order, then each gift row, then — only once there is
 * a share to pay — the claimant's wallet lock, immediately before the first ledger append.
 * The REFERRAL row is the serialisation point: two taps by one customer and two claimants
 * sharing one referral all meet there, holding nothing else.
 *
 * The wallet lock is deliberately NOT taken first. The gift row's two foreign keys take
 * `FOR KEY SHARE` on BOTH parties' customer rows at insert, and `lockCustomer` is
 * `FOR UPDATE`, which conflicts with it: a referee holding its own wallet and the referral
 * row would wait for the referrer's customer row while the referrer's concurrent claim
 * held that row and waited for the referral — a deadlock the first version of this
 * service produced. Taken last, the wallet lock is only ever waited for by a transaction
 * that already holds the referral row, and the writers that hold a wallet lock (the
 * commission lane, refunds) never take a referral row, so there is no cycle.
 */
export class ReferralSignupGiftService {
  constructor(private readonly deps: ReferralSignupGiftServiceDeps) {}

  /**
   * ACTIVE only when both flags are on, the total is positive and the shares make a
   * whole. The guards keep the terms in that shape while the flag is on; this re-reads
   * them anyway, because a claim must decide from the values it can see, not from a
   * guard having run earlier.
   */
  async terms(scope: TenantContext, tx?: unknown): Promise<ReferralSignupGiftTerms> {
    const [gift, referrals, terms, walletCurrency] = await Promise.all([
      this.deps.features.isEnabled(scope, 'referral_signup_gift', tx),
      this.deps.features.isEnabled(scope, 'referrals', tx),
      readSignupGiftTerms(this.deps.settings, scope, tx),
      readWalletCurrency(this.deps.settings, scope, tx),
    ]);
    // Inactive, not merely refused, when the total is in a currency the wallet does not
    // keep: no button is drawn for a gift that could only be paid where nobody can see it.
    return {
      active: gift && referrals && signupGiftTermsProblem(terms, walletCurrency) === null,
      total: terms.total,
      referrerPercent: terms.referrerPercent,
      referredPercent: terms.referredPercent,
    };
  }

  /**
   * What the customer could be paid for now, as referee and as referrer.
   *
   * Decides whether the claim button is drawn and lets "nothing to claim" be said
   * truthfully. A side whose share is zero — snapshotted, or under the current terms when
   * no row exists yet — is not claimable: there is nothing to pay, and the schema pins a
   * stamped side to a ledger entry, so a zero share is never stamped either.
   */
  async claimableFor(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<readonly ClaimableSignupGift[]> {
    const terms = await this.terms(scope, tx);
    if (!terms.active) return [];
    const shares = referralSignupGiftShares(terms.total.amountMinor, terms.referrerPercent);
    const open = await this.deps.gifts.openSides(scope, customerId, tx);
    return open
      .filter((side) => {
        // A row snapshotted in a currency the wallet no longer keeps is not offered: the
        // claim skips it for the same reason, and a button that leads to nothing lies.
        if (side.snapshotCurrency !== null && side.snapshotCurrency !== terms.total.currency) {
          return false;
        }
        const amount =
          side.snapshotAmount ?? (side.side === 'REFEREE' ? shares.referee : shares.referrer);
        return amount > 0n;
      })
      .map((side) => ({ referralId: side.referralId, side: side.side }));
  }

  /**
   * Pays the customer every share they are owed, in one transaction.
   *
   * The gift row is written on the FIRST claim of either side with the terms snapshotted,
   * so the other side later receives the complement of the same total whatever the
   * settings say by then. For each side owed: the conditional stamp FIRST, and the ledger
   * entry only when the stamp changed a row. That order is what makes a replay and a race
   * yield exactly one entry per side — the stamp's row count is the decision, and a
   * transaction that finds the row already stamped writes nothing, rather than writing an
   * entry and then discovering it must not have. Both are inside one transaction, so an
   * entry whose stamp failed cannot exist, and the unique reference is the backstop for a
   * path that forgets the lock.
   */
  async claim(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<SignupGiftClaimResult> {
    const claimant = customerId as UserId;
    const requestHash = hashRequest({ customerId: claimant, purpose: 'REFERRAL_SIGNUP_GIFT' });
    const denial = {
      action: 'referral.signup_gift.claim',
      entityType: 'Customer',
      entityId: claimant,
    };
    await this.deps.guard.check(scope, actor, REFERRAL_WEBHOOK_PERMISSION);

    const replay = await this.deps.idempotency.find<ClaimReplayRecord>(
      scope,
      REFERRAL_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return {
        credited: money(BigInt(replay.result.creditedMinor), replay.result.currency),
        claimedCount: replay.result.claimedCount,
      };
    }

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
      REFERRAL_WEBHOOK_PERMISSION,
      denial,
      async (tx): Promise<SignupGiftClaimResult> => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const terms = await this.terms(scope, tx);
        if (!terms.active) {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.REFERRAL_GIFT_DISABLED,
            'The signup gift is not being paid.',
          );
        }

        // Existence, unlocked: the lock comes last (see the lock order above), and a
        // customer of another tenant is NOT FOUND here rather than "nothing to claim".
        if ((await this.deps.customers.findById(scope, claimant, tx)) === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        const now = this.deps.clock.now();
        const currency = terms.total.currency;
        const shares = referralSignupGiftShares(terms.total.amountMinor, terms.referrerPercent);
        const paid: {
          referralId: string;
          side: ReferralSignupGiftSide;
          amountMinor: string;
          entryId: string;
        }[] = [];
        let credited = 0n;
        let walletLocked = false;

        for (const referral of await this.deps.gifts.lockReferralsOf(scope, claimant, tx)) {
          // The database forbids it (`referrals_not_self_check`); re-checked so a row that
          // somehow carries it pays nobody twice for being both parties.
          if (referral.referrerId === referral.refereeId) continue;
          const side: ReferralSignupGiftSide =
            referral.refereeId === claimant ? 'REFEREE' : 'REFERRER';

          const gift = await this.giftFor(scope, referral, terms.total, shares, now, tx);
          /*
           * A gift snapshotted before `sales.currency` changed is in a currency the wallet
           * no longer sums. Paying it would stamp the side claimed and write a credit the
           * customer can neither see nor spend, so the row is left as it is — unstamped,
           * unpaid, and visible to an operator as an open side under the old currency.
           */
          if (gift.total.currency !== currency) continue;
          // The snapshotted currency is the gift's; a total changed to another currency
          // since the first claim does not change what the second side is owed.
          const amount = side === 'REFEREE' ? gift.refereeAmount : gift.referrerAmount;
          // `wallet_entries` requires a positive amount, and a stamp requires an entry: a
          // zero share is neither paid nor stamped, and `claimableFor` never offers it.
          // Whether the side is ALREADY claimed is decided by `claimSide`'s conditional
          // UPDATE alone — not re-read here first. A read before the write is the copy
          // that masks the write's predicate: with both present, reverting either left
          // the suite green, so neither could be told from the other (falsification
          // record, UX-06).
          if (amount <= 0n) continue;

          const entryId = this.deps.ids.uuid();
          const stamped = await this.deps.gifts.claimSide(
            scope,
            gift.id,
            side,
            { entryId, now },
            tx,
          );
          if (!stamped) continue;

          // The wallet lock, once, before the first append and after every row above.
          if (!walletLocked) {
            if (!(await this.deps.wallet.lockCustomer(scope, claimant, tx))) {
              throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
            }
            walletLocked = true;
          }

          const { entry, inserted } = await this.deps.wallet.append(
            scope,
            {
              id: entryId,
              customerId: claimant,
              direction: 'CREDIT',
              reason: 'REFERRAL_SIGNUP_GIFT',
              amount: money(amount, gift.total.currency),
              reference: referralSignupGiftReference(referral.id, side),
              now,
            },
            tx,
          );
          if (!inserted) {
            /*
             * The stamp said unclaimed and the ledger already holds this side's entry:
             * the two disagree, and the backstop has just caught a writer that reached
             * the ledger without the stamp. Loud, and the transaction rolls back with the
             * stamp, because the alternative is a second credit for one share.
             */
            throw new Error(
              `signup gift ${referral.id}/${side} already has ledger entry ${entry.id} ` +
                'although its side was not stamped claimed',
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
          paid.push({ referralId: referral.id, side, amountMinor: amount.toString(), entryId });
          // A share snapshotted in another currency was paid, but it is not summed into a
          // figure denominated in today's — no rate exists to add them with.
          if (entry.amount.currency === currency) credited += amount;
        }

        if (paid.length > 0) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'referral.signup_gift.claim',
              entityType: 'Customer',
              entityId: claimant,
              before: null,
              after: {
                claimedCount: paid.length,
                creditedMinor: credited.toString(),
                currency,
                shares: paid,
              },
              result: 'SUCCESS',
            },
            tx,
          );
        }

        const result: ClaimReplayRecord = {
          creditedMinor: credited.toString(),
          currency,
          claimedCount: paid.length,
        };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          REFERRAL_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return { credited: money(credited, currency), claimedCount: paid.length };
      },
    );
  }

  /**
   * The customer's referral figures: how many joined through them, what those customers
   * have bought and had delivered, and the commission they have kept net of reversals.
   * Purchases and commission are summed in the tenant's sales currency only.
   */
  async stats(scope: TenantContext, customerId: string, tx?: unknown): Promise<ReferralStats> {
    const currency = await this.deps.settings.valueOf<CurrencyCode>(scope, 'sales.currency', tx);
    const [referralCount, purchases, commission] = await Promise.all([
      this.deps.referrals.countReferredBy(scope, customerId, tx),
      this.deps.gifts.referredPurchases(scope, customerId, currency, tx),
      this.deps.gifts.netCommission(scope, customerId, currency, tx),
    ]);
    return {
      referralCount,
      referredPurchaseCount: purchases.count,
      referredPurchaseTotal: money(purchases.total, currency),
      commissionReceivedTotal: money(commission, currency),
    };
  }

  /**
   * The referral's gift row, locked — created with the terms snapshotted when this is the
   * first claim of either side. A concurrent first claim by the other side loses the
   * insert on the unique index and re-reads the winner's row, so both sides always come
   * from ONE snapshot.
   */
  private async giftFor(
    scope: TenantContext,
    referral: { readonly id: string; readonly referrerId: string; readonly refereeId: string },
    total: Money,
    shares: { readonly referrer: bigint; readonly referee: bigint },
    now: Date,
    tx: TransactionScope,
  ): Promise<ReferralSignupGiftRecord> {
    const existing = await this.deps.gifts.findByReferral(
      scope,
      referral.id,
      { forUpdate: true },
      tx,
    );
    if (existing !== null) return existing;
    await this.deps.gifts.insert(
      scope,
      {
        id: this.deps.ids.uuid(),
        referralId: referral.id,
        referrerId: referral.referrerId,
        refereeId: referral.refereeId,
        total,
        referrerAmount: shares.referrer,
        refereeAmount: shares.referee,
        now,
      },
      tx,
    );
    const written = await this.deps.gifts.findByReferral(
      scope,
      referral.id,
      { forUpdate: true },
      tx,
    );
    if (written === null) {
      // Inserted or conflicted, a row with this referral id exists by the unique index;
      // not finding it means a constraint other than that one refused the insert.
      throw new Error(`signup gift row for referral ${referral.id} could not be written or read`);
    }
    return written;
  }
}
