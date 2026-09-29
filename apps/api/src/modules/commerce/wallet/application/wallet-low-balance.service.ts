import {
  WALLET_LOW_BALANCE_SWEEP_LIMIT,
  type Clock,
  type CurrencyCode,
  type FeatureFlagKey,
  type IdGenerator,
  type MoneyWire,
  type ScopeContext,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';

/** A wallet that fell below the threshold and has not been told about this fall. */
export interface WalletCrossing {
  readonly customerId: UserId;
  /** The ledger entry that took the running balance below the threshold. */
  readonly crossingEntryId: string;
  /** That entry's `created_at`, exactly as the database rendered it. */
  readonly crossedAt: string;
}

/**
 * The low-balance lane's storage. Read the ledger, write an occurrence; never a balance.
 */
export interface WalletThresholdAlertRepository {
  /**
   * Wallets whose DERIVED balance in `currency` is below `threshold` NOW, that were at or
   * above it at some point, and that have no alert raised since they were last at or above
   * it. The newest such fall is the crossing returned.
   */
  listCrossings(
    scope: TenantContext,
    wallet: { readonly currency: CurrencyCode; readonly threshold: bigint },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly WalletCrossing[]>;
  /** One occurrence, or `false` when another writer recorded this crossing first. */
  raise(
    scope: TenantContext,
    alert: {
      readonly id: string;
      readonly customerId: UserId;
      readonly currency: CurrencyCode;
      readonly threshold: bigint;
      readonly crossingEntryId: string;
      readonly crossedAt: string;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
}

export interface WalletLowBalanceDeps {
  readonly alerts: WalletThresholdAlertRepository;
  /** Readers only: a background loop that can write a setting could turn itself on. */
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
  };
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly notifier: CustomerNotifier;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * WP-A9: "your wallet balance is low" — once per fall, re-armed only by a recovery.
 *
 * ## Disabled until an operator says otherwise
 *
 * `wallet_low_balance_reminders` is OFF by default and `wallet.low_balance.threshold` is
 * zero by default. Either one alone sends nothing, and a pass with either one off runs no
 * query at all. The threshold is compared only in the currency this installation SELLS in:
 * a stored threshold in another currency (the sales currency changed after it was set) is
 * a configuration that names no wallet, so it sends nothing rather than comparing amounts
 * across currencies at a rate nobody chose.
 *
 * ## Once per crossing, derived from the ledger
 *
 * There is no balance column and no "armed" flag. The repository derives, per wallet, the
 * running balance after every entry; a wallet is a candidate when it is below the threshold
 * now, was at or above it at some earlier entry, and has no alert recorded since that last
 * entry at or above it. The crossing is the entry right after it, and the alert is unique
 * on that entry:
 *
 *   - a restart, a retry and a second replica derive the same crossing, and one insert wins;
 *   - a wallet that stays low has an alert since its last high point, so it is not a
 *     candidate and an idle pass writes nothing;
 *   - a customer who has never had the threshold in their wallet is never "low" — telling
 *     every new customer with an empty wallet that their balance is low is the spam this
 *     rule exists to prevent;
 *   - a top-up back to the threshold is a new high point, so the NEXT fall is a new
 *     crossing, a new row and a new message. Nothing is deleted or updated to re-arm.
 *
 * The send-time re-check (the lane's subject reader) supersedes an alert whose wallet was
 * topped up back to the recorded threshold before the message left.
 */
export class WalletLowBalanceService {
  constructor(private readonly deps: WalletLowBalanceDeps) {}

  async runOnce(scope: TenantContext): Promise<{ readonly alerts: number }> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return { alerts: 0 };
      if (!(await this.deps.features.isEnabled(scope, 'wallet_low_balance_reminders', tx))) {
        return { alerts: 0 };
      }
      const [threshold, selling] = await Promise.all([
        this.deps.settings.valueOf<MoneyWire>(scope, 'wallet.low_balance.threshold', tx),
        this.deps.settings.valueOf<CurrencyCode>(scope, 'sales.currency', tx),
      ]);
      const amount = BigInt(threshold.amountMinor);
      if (amount <= 0n || threshold.currency !== selling) return { alerts: 0 };

      const crossings = await this.deps.alerts.listCrossings(
        scope,
        { currency: selling, threshold: amount },
        WALLET_LOW_BALANCE_SWEEP_LIMIT,
        tx,
      );
      let told = 0;
      for (const crossing of crossings) {
        const id = this.deps.ids.uuid();
        const written = await this.deps.alerts.raise(
          scope,
          {
            id,
            customerId: crossing.customerId,
            currency: selling,
            threshold: amount,
            crossingEntryId: crossing.crossingEntryId,
            crossedAt: crossing.crossedAt,
          },
          now,
          tx,
        );
        if (!written) continue;
        /*
         * The row is written whether or not the customer can be reached, so a wallet with
         * no bot link is not re-derived on every pass; `notify` answers `false` for it.
         */
        if (
          await this.deps.notifier.notify(
            scope,
            crossing.customerId,
            'WALLET_LOW_BALANCE',
            id,
            now,
            tx,
          )
        ) {
          told += 1;
        }
      }
      return { alerts: told };
    });
  }
}
