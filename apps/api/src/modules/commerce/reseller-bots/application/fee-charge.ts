import {
  hostedBotFeeReference,
  money,
  type ActorContext,
  type IdGenerator,
  type ResellerBotChargeKind,
  type TenantContext,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { canCover, shortfallMinor } from '../../wallet/domain/balance.js';
import type { ResellerBotRepository, ResellerBotRequestRecord } from './ports.js';

export interface FeeChargeDeps {
  readonly wallet: Pick<WalletRepository, 'lockCustomer' | 'balanceOf' | 'append'>;
  readonly repository: Pick<ResellerBotRepository, 'insertCharge'>;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
}

export type FeeChargeOutcome =
  | {
      readonly kind: 'CHARGED';
      readonly entryId: string;
      readonly reference: string;
      /** False when the period's entry already existed (a replay): nothing moved now. */
      readonly inserted: boolean;
    }
  | { readonly kind: 'SHORT'; readonly balanceMinor: bigint; readonly shortfallMinor: bigint }
  | { readonly kind: 'NO_CUSTOMER' };

/**
 * Debits ONE period of a dedicated bot's fee, inside the caller's transaction.
 *
 * The customer's row is locked FIRST and the balance read AFTER, on this transaction's
 * connection (`WalletService.adjust`'s order): two debits cannot both see a balance that
 * omits the other. `canCover` with no allowance — there is no reseller credit, so a wallet is
 * never taken below zero, and a wallet already below zero covers nothing.
 *
 * The entry's reference is derived from the request and the period
 * (`hosted-bot-fee:<request>:<period>`): an approval replay, two renewal runs and the
 * reseller's own pay racing the job all name ONE entry, and the unique reference makes the
 * second a re-read (`inserted: false`), never a second debit. The charge row's
 * `(request, period)` key states the same rule about the subscription.
 */
export async function chargePeriod(
  deps: FeeChargeDeps,
  scope: TenantContext,
  actor: ActorContext,
  input: {
    readonly request: ResellerBotRequestRecord;
    readonly period: number;
    readonly start: Date;
    readonly end: Date;
    readonly kind: ResellerBotChargeKind;
    readonly now: Date;
  },
  tx: TransactionScope,
): Promise<FeeChargeOutcome> {
  const { request } = input;
  if (!(await deps.wallet.lockCustomer(scope, request.customerId, tx))) {
    return { kind: 'NO_CUSTOMER' };
  }
  const reference = hostedBotFeeReference(request.id, input.period);
  const balance = await deps.wallet.balanceOf(scope, request.customerId, request.feeCurrency, tx);
  if (!canCover(balance.amountMinor, request.feeAmountMinor)) {
    return {
      kind: 'SHORT',
      balanceMinor: balance.amountMinor,
      shortfallMinor: shortfallMinor(balance.amountMinor, request.feeAmountMinor),
    };
  }
  const { entry, inserted } = await deps.wallet.append(
    scope,
    {
      id: deps.ids.uuid(),
      customerId: request.customerId,
      direction: 'DEBIT',
      reason: 'HOSTED_BOT_FEE',
      amount: money(request.feeAmountMinor, request.feeCurrency),
      reference,
      now: input.now,
    },
    tx,
  );
  await deps.repository.insertCharge(
    scope,
    {
      id: deps.ids.uuid(),
      requestId: request.id,
      period: input.period,
      kind: input.kind,
      walletEntryId: entry.id,
      amountMinor: entry.amount.amountMinor,
      currency: entry.amount.currency,
      periodStart: input.start,
      periodEnd: input.end,
      now: input.now,
    },
    tx,
  );
  if (inserted) {
    await deps.outbox.write(tx, actor, {
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
  }
  return { kind: 'CHARGED', entryId: entry.id, reference, inserted };
}
