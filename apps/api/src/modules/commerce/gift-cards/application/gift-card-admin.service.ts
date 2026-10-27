import {
  COMMERCE_ERROR_CODES,
  GIFT_CARD_EXPIRY_MAX_LEAD_MS,
  GIFT_CARD_EXPIRY_MIN_LEAD_MS,
  GIFT_CARD_EXPORT_TTL_MS,
  PAYMENT_AMOUNT_MAX_MINOR,
  errors,
  money,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
  type MutationDenial,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import { readWalletCurrency } from '../../../control/settings/application/signup-gift-terms.guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { generateGiftCardCode, giftCardLast4, hashGiftCardCode } from '../domain/gift-card-code.js';
import type {
  GiftCardBatchCounts,
  GiftCardBatchCursor,
  GiftCardBatchRecord,
  GiftCardCsvRenderer,
  GiftCardExportSealer,
  GiftCardRepository,
  NewGiftCardCode,
} from './ports.js';

export const GIFT_CARDS_VIEW_PERMISSION: PermissionKey = 'gift_cards.view';
export const GIFT_CARDS_CREATE_PERMISSION: PermissionKey = 'gift_cards.create';
export const GIFT_CARDS_EXPORT_PERMISSION: PermissionKey = 'gift_cards.export';
export const GIFT_CARDS_DISABLE_PERMISSION: PermissionKey = 'gift_cards.disable';

/** An operator's writes are keyed in the Web Admin's namespace. */
const WEB_NAMESPACE = 'WEB';

export const GIFT_CARD_BATCH_CREATE_ACTION = 'gift_card.batch.create';
export const GIFT_CARD_BATCH_EXPORT_ACTION = 'gift_card.batch.export';
export const GIFT_CARD_BATCH_DISABLE_ACTION = 'gift_card.batch.disable';

export interface GiftCardAdminServiceDeps {
  readonly repository: GiftCardRepository;
  readonly sealer: GiftCardExportSealer;
  readonly csv: GiftCardCsvRenderer;
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
  /** The code generator; the CSPRNG by default, injectable so a test can mint known codes. */
  readonly generateCode?: () => string;
}

export interface GiftCardBatchCreateCommand {
  readonly idempotencyKey: string;
  readonly label: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly count: number;
  readonly expiresAt: Date;
  readonly perCustomerLimit: number | null;
  readonly reason: string;
  /** The face total the operator was shown: amount × count. */
  readonly expectedTotalMinor: bigint;
  /** The count, typed back. */
  readonly typedCount: number;
}

/** A batch as an operator reads it: the row, its counts and whether the codes can be downloaded. */
export interface GiftCardBatchView {
  readonly batch: GiftCardBatchRecord;
  readonly counts: GiftCardBatchCounts;
  /** `export_expires_at` while the sealed export exists and the window is open; null after. */
  readonly exportAvailableUntil: Date | null;
  /** The face value of every redeemed code: what the batch has credited so far. */
  readonly redeemedTotal: Money;
}

export interface GiftCardExport {
  readonly batch: GiftCardBatchRecord;
  readonly count: number;
  readonly fileName: string;
  /** The CSV. Plaintext codes: the caller sends it and keeps nothing. */
  readonly content: string;
}

/**
 * The operator's side of gift cards (R10 D4): mint a batch, download its codes once, disable
 * what has not been redeemed, list. Every write follows the seven steps: the actor, the
 * tenant scope, the guard (denials audited by `runAuthorizedMutation`), the typed command,
 * the idempotency key in the WEB namespace, one transaction holding the change, its audit row
 * and its outbox event, and the projection by the relay.
 *
 * ## The plaintext exists once
 *
 * A batch's codes are generated here, hashed for the code rows and sealed together for the
 * export, all BEFORE the transaction opens (CPU work, no I/O, so nothing is held while it
 * runs). The audit row and the event carry counts, never a code. A replayed create returns the
 * batch it made; the codes are fetched from the export endpoint, so a lost response loses no
 * codes while the 24-hour window is open.
 */
export class GiftCardAdminService {
  constructor(private readonly deps: GiftCardAdminServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: { readonly limit?: number; readonly cursor?: GiftCardBatchCursor },
  ): Promise<{
    readonly items: readonly GiftCardBatchView[];
    readonly next: GiftCardBatchCursor | null;
    readonly walletCurrency: CurrencyCode;
    readonly enabled: boolean;
  }> {
    await this.deps.guard.check(scope, actor, GIFT_CARDS_VIEW_PERMISSION);
    const page = await this.deps.repository.listBatches(scope, {
      limit: query.limit ?? 25,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const [walletCurrency, enabled] = await Promise.all([
      readWalletCurrency(this.deps.settings, scope),
      this.deps.features.isEnabled(scope, 'gift_cards'),
    ]);
    const now = this.deps.clock.now();
    return {
      items: page.items.map((item) => this.view(item.batch, item.counts, now)),
      next: page.next,
      walletCurrency,
      enabled,
    };
  }

  async get(
    scope: TenantContext,
    actor: ActorContext,
    batchId: string,
  ): Promise<GiftCardBatchView> {
    await this.deps.guard.check(scope, actor, GIFT_CARDS_VIEW_PERMISSION);
    return this.readView(scope, batchId);
  }

  async create(
    scope: TenantContext,
    actor: ActorContext,
    command: GiftCardBatchCreateCommand,
  ): Promise<GiftCardBatchView> {
    const denial = {
      action: GIFT_CARD_BATCH_CREATE_ACTION,
      entityType: 'GiftCardBatch',
      entityId: null,
    };
    // Before anything is generated; a refusal is audited DENIED like the transaction's own.
    await this.authorize(scope, actor, GIFT_CARDS_CREATE_PERMISSION, denial);
    const requestHash = hashRequest({
      label: command.label,
      amountMinor: command.amountMinor.toString(),
      currency: command.currency,
      count: command.count,
      expiresAt: command.expiresAt.toISOString(),
      perCustomerLimit: command.perCustomerLimit,
      reason: command.reason,
      expectedTotalMinor: command.expectedTotalMinor.toString(),
      typedCount: command.typedCount,
    });
    const replay = await this.deps.idempotency.find<{ batchId: string }>(
      scope,
      WEB_NAMESPACE,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.readView(scope, replay.result.batchId);

    // The confirmation binds to what the operator saw, before anything is generated.
    if (
      command.typedCount !== command.count ||
      command.expectedTotalMinor !== command.amountMinor * BigInt(command.count)
    ) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.GIFT_CARD_CONFIRMATION_MISMATCH,
        'The typed count or the face total does not match the batch.',
      );
    }
    if (command.amountMinor <= 0n || command.amountMinor > PAYMENT_AMOUNT_MAX_MINOR) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.GIFT_CARD_BATCH_INVALID,
        'A face value is positive and at most the payment ceiling.',
        { problem: 'AMOUNT' },
      );
    }
    const now = this.deps.clock.now();
    const lead = command.expiresAt.getTime() - now.getTime();
    if (lead < GIFT_CARD_EXPIRY_MIN_LEAD_MS || lead > GIFT_CARD_EXPIRY_MAX_LEAD_MS) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.GIFT_CARD_BATCH_INVALID,
        'The expiry is between one hour and five years from now.',
        { problem: 'EXPIRY' },
      );
    }

    // CPU work before the transaction: the codes, their hashes, the sealed export.
    const tenantId = scope.tenantId;
    const batchId = this.deps.ids.uuid();
    const generate = this.deps.generateCode ?? (() => generateGiftCardCode());
    const plain = new Set<string>();
    while (plain.size < command.count) plain.add(generate());
    const codes = [...plain];
    const rows: NewGiftCardCode[] = codes.map((code) => ({
      id: this.deps.ids.uuid(),
      codeHash: hashGiftCardCode(tenantId, code),
      last4: giftCardLast4(code),
    }));
    const sealedExport = this.deps.sealer.seal(scope, batchId, codes);

    const created = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      GIFT_CARDS_CREATE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        if (!(await this.deps.features.isEnabled(scope, 'gift_cards', tx))) {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.GIFT_CARDS_DISABLED,
            'Gift cards are switched off.',
          );
        }
        // A batch is minted in the currency the wallet keeps, never converted later.
        const walletCurrency = await readWalletCurrency(this.deps.settings, scope, tx);
        if (command.currency !== walletCurrency) {
          throw errors.validation(
            COMMERCE_ERROR_CODES.GIFT_CARD_BATCH_INVALID,
            'A batch is minted in the wallet currency.',
            { problem: 'CURRENCY', walletCurrency },
          );
        }
        const at = this.deps.clock.now();
        await this.deps.repository.insertBatch(
          scope,
          {
            id: batchId,
            label: command.label,
            amount: money(command.amountMinor, command.currency),
            codeCount: command.count,
            perCustomerLimit: command.perCustomerLimit,
            expiresAt: command.expiresAt,
            reason: command.reason,
            createdByAdminId: adminIdOf(actor),
            createdAt: at,
            exportExpiresAt: new Date(at.getTime() + GIFT_CARD_EXPORT_TTL_MS),
            sealedExport,
          },
          rows,
          tx,
        );
        const faceTotalMinor = (command.amountMinor * BigInt(command.count)).toString();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: GIFT_CARD_BATCH_CREATE_ACTION,
            entityType: 'GiftCardBatch',
            entityId: batchId,
            before: null,
            // Counts and amounts only: never a code, never a hash.
            after: {
              label: command.label,
              amountMinor: command.amountMinor.toString(),
              currency: command.currency,
              count: command.count,
              faceTotalMinor,
              perCustomerLimit: command.perCustomerLimit,
              expiresAt: command.expiresAt.toISOString(),
              reason: command.reason,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'GiftCardBatchCreated',
          aggregateType: 'GiftCardBatch',
          aggregateId: batchId,
          payload: {
            batchId,
            count: command.count,
            amountMinor: command.amountMinor.toString(),
            currency: command.currency,
            expiresAt: command.expiresAt.toISOString(),
          },
        });
        await rememberOnce(
          this.deps.idempotency,
          scope,
          WEB_NAMESPACE,
          command.idempotencyKey,
          requestHash,
          { batchId },
          tx,
        );
        return batchId;
      },
    );
    return this.readView(scope, created);
  }

  /**
   * The batch's codes, decrypted, for the CSV — while the 24-hour window is open. Every
   * download is audited (the count, never a code). After the window the export is gone and the
   * codes cannot be recovered: they are stored hashed.
   */
  async exportCodes(
    scope: TenantContext,
    actor: ActorContext,
    batchId: string,
  ): Promise<GiftCardExport> {
    const denial = {
      action: GIFT_CARD_BATCH_EXPORT_ACTION,
      entityType: 'GiftCardBatch',
      entityId: batchId,
    };
    const opened = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      GIFT_CARDS_EXPORT_PERMISSION,
      denial,
      async (tx) => {
        const batch = await this.deps.repository.findBatch(scope, batchId, {}, tx);
        if (batch === null) throw notFound();
        const now = this.deps.clock.now();
        if (batch.sealedExport === null || now.getTime() >= batch.exportExpiresAt.getTime()) {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.GIFT_CARD_EXPORT_GONE,
            'The codes of this batch can no longer be downloaded.',
          );
        }
        const codes = this.deps.sealer.open(scope, batch.id, batch.sealedExport);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: GIFT_CARD_BATCH_EXPORT_ACTION,
            entityType: 'GiftCardBatch',
            entityId: batch.id,
            before: null,
            after: { count: codes.length, state: batch.state },
            result: 'SUCCESS',
          },
          tx,
        );
        return { batch, codes };
      },
    );
    const file = await this.deps.csv.render(scope, opened.batch, opened.codes);
    return { batch: opened.batch, count: opened.codes.length, ...file };
  }

  /** The dry run of a disable: the unredeemed codes it would stop, counted now. */
  async disablePreview(
    scope: TenantContext,
    actor: ActorContext,
    batchId: string,
  ): Promise<{ readonly batch: GiftCardBatchRecord; readonly unredeemed: number }> {
    await this.deps.guard.check(scope, actor, GIFT_CARDS_VIEW_PERMISSION);
    const batch = await this.deps.repository.findBatch(scope, batchId, {});
    if (batch === null) throw notFound();
    const counts = await this.deps.repository.counts(scope, batchId);
    return { batch, unredeemed: batch.state === 'ACTIVE' ? counts.unredeemed : 0 };
  }

  /**
   * Stops the batch's UNREDEEMED codes. Confirmed against the count the operator previewed; a
   * redemption that landed in between changes the count, and the operator confirms again.
   * Redeemed codes are untouched: their money already moved and is not taken back here.
   */
  async disable(
    scope: TenantContext,
    actor: ActorContext,
    batchId: string,
    command: {
      readonly idempotencyKey: string;
      readonly reason: string;
      readonly expectedUnredeemed: number;
    },
  ): Promise<{
    readonly view: GiftCardBatchView;
    readonly codesDisabled: number;
    readonly changed: boolean;
  }> {
    const denial = {
      action: GIFT_CARD_BATCH_DISABLE_ACTION,
      entityType: 'GiftCardBatch',
      entityId: batchId,
    };
    await this.authorize(scope, actor, GIFT_CARDS_DISABLE_PERMISSION, denial);
    const requestHash = hashRequest({
      batchId,
      reason: command.reason,
      expectedUnredeemed: command.expectedUnredeemed,
    });
    const replay = await this.deps.idempotency.find<{ codesDisabled: number; changed: boolean }>(
      scope,
      WEB_NAMESPACE,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return {
        view: await this.readView(scope, batchId),
        codesDisabled: replay.result.codesDisabled,
        changed: replay.result.changed,
      };
    }
    const outcome = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      GIFT_CARDS_DISABLE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const batch = await this.deps.repository.findBatch(scope, batchId, { lock: 'update' }, tx);
        if (batch === null) throw notFound();
        let result = { codesDisabled: 0, changed: false };
        if (batch.state === 'ACTIVE') {
          // Counted under the batch's FOR UPDATE: no redemption (which holds FOR SHARE) can
          // land between this count and the UPDATE below.
          const counts = await this.deps.repository.counts(scope, batchId, tx);
          if (counts.unredeemed !== command.expectedUnredeemed) {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.GIFT_CARD_CONFIRMATION_MISMATCH,
              'The number of unredeemed codes changed since the preview.',
              { unredeemed: counts.unredeemed },
            );
          }
          result = await this.deps.repository.disableBatch(
            scope,
            batchId,
            { adminId: adminIdOf(actor), now: this.deps.clock.now() },
            tx,
          );
        }
        if (result.changed) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: GIFT_CARD_BATCH_DISABLE_ACTION,
              entityType: 'GiftCardBatch',
              entityId: batchId,
              before: { state: 'ACTIVE' },
              after: {
                state: 'DISABLED',
                codesDisabled: result.codesDisabled,
                reason: command.reason,
              },
              result: 'SUCCESS',
            },
            tx,
          );
          await this.deps.outbox.write(tx, actor, {
            eventType: 'GiftCardBatchDisabled',
            aggregateType: 'GiftCardBatch',
            aggregateId: batchId,
            payload: { batchId, codesDisabled: result.codesDisabled },
          });
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          WEB_NAMESPACE,
          command.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
    return { view: await this.readView(scope, batchId), ...outcome };
  }

  private async readView(scope: TenantContext, batchId: string): Promise<GiftCardBatchView> {
    const batch = await this.deps.repository.findBatch(scope, batchId, {});
    if (batch === null) throw notFound();
    const counts = await this.deps.repository.counts(scope, batchId);
    return this.view(batch, counts, this.deps.clock.now());
  }

  private view(
    batch: GiftCardBatchRecord,
    counts: GiftCardBatchCounts,
    now: Date,
  ): GiftCardBatchView {
    const open = batch.sealedExport !== null && now.getTime() < batch.exportExpiresAt.getTime();
    return {
      batch,
      counts,
      exportAvailableUntil: open ? batch.exportExpiresAt : null,
      redeemedTotal: money(
        batch.amount.amountMinor * BigInt(counts.redeemed),
        batch.amount.currency,
      ),
    };
  }

  /** The guard before the transaction, with the denial audited as the transaction's would be. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: MutationDenial,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.deps, scope, actor, permission, denial, error);
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
}

function notFound() {
  return errors.notFound(
    COMMERCE_ERROR_CODES.GIFT_CARD_BATCH_NOT_FOUND,
    'Unknown gift card batch.',
  );
}

/** The acting administrator's id, for the row's `created_by` / `disabled_by`. */
function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' && actor.id !== null ? actor.id : null;
}
