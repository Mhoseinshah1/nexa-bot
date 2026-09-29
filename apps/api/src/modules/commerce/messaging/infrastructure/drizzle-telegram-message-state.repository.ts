import { and, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type {
  BotInstanceId,
  TelegramReviewMessageRole,
  TelegramWizardKind,
  TelegramWizardStep,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  telegramReviewMessages,
  telegramWizards,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  TelegramMessageRef,
  TelegramMessageStateRepository,
  TelegramReviewMessageRecord,
  TelegramWizardLanding,
  TelegramWizardRecord,
  WizardSelector,
} from '../application/telegram-message-state.js';

type WizardRow = typeof telegramWizards.$inferSelect;
type ReviewRow = typeof telegramReviewMessages.$inferSelect;

function wizardOf(row: WizardRow): TelegramWizardRecord {
  return {
    id: row.id,
    botInstanceId: row.botInstanceId as BotInstanceId,
    chatId: row.chatId,
    messageId: row.messageId,
    kind: row.kind as TelegramWizardKind,
    step: row.step as TelegramWizardStep,
    version: row.version,
    subjectId: row.subjectId,
    paymentId: row.paymentId,
    busyUntil: row.busyUntil,
    lastUpdateKey: row.lastUpdateKey,
    updatedAt: row.updatedAt,
  };
}

function reviewOf(row: ReviewRow): TelegramReviewMessageRecord {
  return {
    id: row.id,
    botInstanceId: row.botInstanceId as BotInstanceId,
    chatId: row.chatId,
    messageId: row.messageId,
    paymentId: row.paymentId,
    role: row.role as TelegramReviewMessageRole,
    hasMedia: row.hasMedia,
    finalisedAt: row.finalisedAt,
  };
}

/**
 * R2: the two tables of Telegram messages edited in place. Every write is conditional —
 * see `TelegramMessageStateRepository` — and none of them waits on a lock another turn holds
 * for longer than one statement: a claim is a lease column, not a held row lock.
 */
export class DrizzleTelegramMessageStateRepository implements TelegramMessageStateRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private wizardAt(tenantId: string, ref: TelegramMessageRef): SQL | undefined {
    return and(
      eq(telegramWizards.tenantId, tenantId),
      eq(telegramWizards.botInstanceId, ref.botInstanceId),
      eq(telegramWizards.chatId, ref.chatId),
      eq(telegramWizards.messageId, ref.messageId),
    );
  }

  private reviewAt(tenantId: string, ref: TelegramMessageRef): SQL | undefined {
    return and(
      eq(telegramReviewMessages.tenantId, tenantId),
      eq(telegramReviewMessages.botInstanceId, ref.botInstanceId),
      eq(telegramReviewMessages.chatId, ref.chatId),
      eq(telegramReviewMessages.messageId, ref.messageId),
    );
  }

  async adoptWizard(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly ref: TelegramMessageRef;
      readonly kind: TelegramWizardKind;
      readonly step: TelegramWizardStep;
      readonly subjectId: string | null;
      readonly paymentId: string | null;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.exec(tx)
      .insert(telegramWizards)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        botInstanceId: row.ref.botInstanceId,
        chatId: row.ref.chatId,
        messageId: row.ref.messageId,
        kind: row.kind,
        step: row.step,
        version: 0,
        subjectId: row.subjectId,
        paymentId: row.paymentId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  async findWizard(
    scope: TenantContext,
    ref: TelegramMessageRef,
    tx?: TransactionScope,
  ): Promise<TelegramWizardRecord | null> {
    const rows = await this.exec(tx)
      .select()
      .from(telegramWizards)
      .where(this.wizardAt(requireTenantId(scope), ref))
      .limit(1);
    return rows[0] === undefined ? null : wizardOf(rows[0]);
  }

  async claimWizard(
    scope: TenantContext,
    where: {
      readonly ref?: TelegramMessageRef;
      readonly id?: string;
      readonly kind: TelegramWizardKind | null;
      readonly from: readonly TelegramWizardStep[];
      readonly updateKey?: string;
    },
    now: Date,
    leaseUntil: Date,
    tx: TransactionScope,
  ): Promise<TelegramWizardRecord | null> {
    const tenantId = requireTenantId(scope);
    const target =
      where.id !== undefined
        ? and(eq(telegramWizards.tenantId, tenantId), eq(telegramWizards.id, where.id))
        : where.ref !== undefined
          ? this.wizardAt(tenantId, where.ref)
          : undefined;
    if (target === undefined || where.from.length === 0) return null;
    /*
     * ONE statement, so two turns on one message cannot both pass: the second blocks on the
     * row lock the first's UPDATE holds, re-evaluates this predicate against the committed
     * row — whose lease is now set — and updates nothing.
     */
    const rows = await this.exec(tx)
      .update(telegramWizards)
      .set({
        version: sql`${telegramWizards.version} + 1`,
        busyUntil: leaseUntil,
        updatedAt: now,
      })
      .where(
        and(
          target,
          where.updateKey === undefined
            ? inArray(telegramWizards.step, [...where.from])
            : or(
                inArray(telegramWizards.step, [...where.from]),
                eq(telegramWizards.lastUpdateKey, where.updateKey),
              ),
          where.kind === null ? undefined : eq(telegramWizards.kind, where.kind),
          or(isNull(telegramWizards.busyUntil), lte(telegramWizards.busyUntil, now)),
        ),
      )
      .returning();
    return rows[0] === undefined ? null : wizardOf(rows[0]);
  }

  async landWizard(
    scope: TenantContext,
    id: string,
    version: number,
    landing: TelegramWizardLanding,
    now: Date,
    busyUntil: Date | null,
    tx: TransactionScope,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .update(telegramWizards)
      .set({
        kind: landing.kind,
        step: landing.step,
        subjectId: landing.subjectId,
        paymentId: landing.paymentId,
        ...(landing.updateKey === undefined ? {} : { lastUpdateKey: landing.updateKey }),
        version: sql`${telegramWizards.version} + 1`,
        busyUntil,
        updatedAt: now,
      })
      .where(
        and(
          eq(telegramWizards.tenantId, requireTenantId(scope)),
          eq(telegramWizards.id, id),
          eq(telegramWizards.version, version),
        ),
      )
      .returning({ id: telegramWizards.id });
    return rows.length > 0;
  }

  async releaseWizard(
    scope: TenantContext,
    id: string,
    version: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .update(telegramWizards)
      .set({ busyUntil: null, updatedAt: now })
      .where(
        and(
          eq(telegramWizards.tenantId, requireTenantId(scope)),
          eq(telegramWizards.id, id),
          eq(telegramWizards.version, version),
        ),
      )
      .returning({ id: telegramWizards.id });
    return rows.length > 0;
  }

  async moveWizard(
    scope: TenantContext,
    id: string,
    messageId: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    /*
     * A message already tracked under the new id wins: the unique key refuses the move, and
     * the old row keeps pointing at the message whose edit failed — whose buttons then answer
     * as stale, which is the safe side.
     */
    const tenantId = requireTenantId(scope);
    const moving = await this.exec(tx)
      .select()
      .from(telegramWizards)
      .where(and(eq(telegramWizards.tenantId, tenantId), eq(telegramWizards.id, id)))
      .limit(1);
    const row = moving[0];
    if (row === undefined) return false;
    const taken = await this.exec(tx)
      .select({ id: telegramWizards.id })
      .from(telegramWizards)
      .where(
        this.wizardAt(tenantId, {
          botInstanceId: row.botInstanceId as BotInstanceId,
          chatId: row.chatId,
          messageId,
        }),
      )
      .limit(1);
    if (taken.length > 0) return false;
    const rows = await this.exec(tx)
      .update(telegramWizards)
      .set({ messageId, updatedAt: now })
      .where(and(eq(telegramWizards.tenantId, tenantId), eq(telegramWizards.id, id)))
      .returning({ id: telegramWizards.id });
    return rows.length > 0;
  }

  async latestWizard(
    scope: TenantContext,
    where: {
      readonly botInstanceId: BotInstanceId;
      readonly chatId: string;
      readonly kind: TelegramWizardKind;
      readonly steps: readonly TelegramWizardStep[];
      readonly subjectId: string | null;
    },
    now: Date,
    tx?: TransactionScope,
  ): Promise<TelegramWizardRecord | null> {
    if (where.steps.length === 0) return null;
    const rows = await this.exec(tx)
      .select()
      .from(telegramWizards)
      .where(
        and(
          eq(telegramWizards.tenantId, requireTenantId(scope)),
          eq(telegramWizards.botInstanceId, where.botInstanceId),
          eq(telegramWizards.chatId, where.chatId),
          eq(telegramWizards.kind, where.kind),
          inArray(telegramWizards.step, [...where.steps]),
          where.subjectId === null ? undefined : eq(telegramWizards.subjectId, where.subjectId),
          or(isNull(telegramWizards.busyUntil), lte(telegramWizards.busyUntil, now)),
        ),
      )
      .orderBy(desc(telegramWizards.updatedAt), desc(telegramWizards.messageId))
      .limit(1);
    return rows[0] === undefined ? null : wizardOf(rows[0]);
  }

  async moveWizards(
    scope: TenantContext,
    where: WizardSelector,
    from: readonly TelegramWizardStep[],
    to: TelegramWizardStep,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly TelegramWizardRecord[]> {
    if (
      from.length === 0 ||
      (where.paymentId === undefined && where.subjectId === undefined && where.id === undefined)
    ) {
      return [];
    }
    /*
     * Deliberately NOT conditional on the lease: the worker that moves an invoice screen has
     * the fresher truth than a turn still rendering the old one, and bumping `version` is
     * what makes that turn's `landWizard` fail — so the turn drops its now-stale edit rather
     * than overwriting the one this caller is about to make.
     */
    const rows = await this.exec(tx)
      .update(telegramWizards)
      .set({
        step: to,
        version: sql`${telegramWizards.version} + 1`,
        busyUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(telegramWizards.tenantId, requireTenantId(scope)),
          where.paymentId === undefined
            ? undefined
            : eq(telegramWizards.paymentId, where.paymentId),
          where.subjectId === undefined
            ? undefined
            : eq(telegramWizards.subjectId, where.subjectId),
          where.id === undefined ? undefined : eq(telegramWizards.id, where.id),
          inArray(telegramWizards.step, [...from]),
        ),
      )
      .returning();
    return rows.map(wizardOf);
  }

  async recordReviewMessage(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly ref: TelegramMessageRef;
      readonly paymentId: string;
      readonly role: TelegramReviewMessageRole;
      readonly hasMedia: boolean;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.exec(tx)
      .insert(telegramReviewMessages)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        botInstanceId: row.ref.botInstanceId,
        chatId: row.ref.chatId,
        messageId: row.ref.messageId,
        paymentId: row.paymentId,
        role: row.role,
        hasMedia: row.hasMedia,
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  async findReviewMessage(
    scope: TenantContext,
    ref: TelegramMessageRef,
  ): Promise<TelegramReviewMessageRecord | null> {
    const rows = await this.db
      .select()
      .from(telegramReviewMessages)
      .where(this.reviewAt(requireTenantId(scope), ref))
      .limit(1);
    return rows[0] === undefined ? null : reviewOf(rows[0]);
  }

  async finaliseReviewMessages(
    scope: TenantContext,
    where: {
      readonly paymentId?: string;
      /** With `paymentId`: only this chat's messages (a block decides nothing for others). */
      readonly chatId?: string;
      readonly ref?: TelegramMessageRef;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly TelegramReviewMessageRecord[]> {
    const tenantId = requireTenantId(scope);
    const target =
      where.ref !== undefined
        ? this.reviewAt(tenantId, where.ref)
        : where.paymentId !== undefined
          ? and(
              eq(telegramReviewMessages.tenantId, tenantId),
              eq(telegramReviewMessages.paymentId, where.paymentId),
              where.chatId === undefined
                ? undefined
                : eq(telegramReviewMessages.chatId, where.chatId),
            )
          : undefined;
    if (target === undefined) return [];
    const rows = await this.exec(tx)
      .update(telegramReviewMessages)
      .set({ finalisedAt: now })
      .where(and(target, isNull(telegramReviewMessages.finalisedAt)))
      .returning();
    return rows.map(reviewOf);
  }

  async unfinaliseReviewMessage(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<void> {
    await this.exec(tx)
      .update(telegramReviewMessages)
      .set({ finalisedAt: null })
      .where(
        and(
          eq(telegramReviewMessages.tenantId, requireTenantId(scope)),
          eq(telegramReviewMessages.id, id),
        ),
      );
  }
}
