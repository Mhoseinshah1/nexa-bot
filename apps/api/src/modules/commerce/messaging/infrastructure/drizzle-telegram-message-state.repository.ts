import { and, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  OPERATION_STATES,
  OPERATION_TERMINAL_STATES,
  ORDER_SETTLED_STATES,
  ORDER_TERMINAL_STATES,
  PAYMENT_TERMINAL_STATES,
} from '@nexa/contracts';
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
  telegramMessageHorizons,
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

/** A literal list for `IN (...)`, from a contract's closed set. */
function literals(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/** A payment no longer open: nothing will move a wizard or decide a review of it again. */
const PAYMENT_DONE = literals(PAYMENT_TERMINAL_STATES);
/**
 * An order nothing will settle or close through its wizard again: paid (a refund edits no
 * wizard) or ended. Named as the DONE states, so a state added later is retained by default.
 */
const ORDER_DONE = literals([...ORDER_SETTLED_STATES, ...ORDER_TERMINAL_STATES]);
/**
 * A provisioning operation still running — derived from the contract, so a state added later
 * is "still running" by default. Spelled as the open list rather than `NOT IN terminal` so
 * the planner can use the operations table's partial indexes on those states.
 */
const OPERATION_OPEN = literals(
  OPERATION_STATES.filter(
    (state) => !(OPERATION_TERMINAL_STATES as readonly string[]).includes(state),
  ),
);

interface PurgedRow {
  readonly bot_instance_id: string;
  readonly chat_id: string;
  readonly message_id: string | number;
}

function refOf(row: PurgedRow): TelegramMessageRef {
  return {
    botInstanceId: row.bot_instance_id as BotInstanceId,
    chatId: row.chat_id,
    messageId: Number(row.message_id),
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
    leftBehindId: string,
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
    if (rows.length === 0) return false;
    /*
     * The message the wizard LEFT still carries its keyboard. Untracked, its next tap would
     * be adopted as a fresh wizard at the gate's first step and claimed — an old button
     * moving the flow backward. So it keeps a row of its own, CLOSED, which honours nothing:
     * no order, no payment, no update key, so neither a move nor a redelivery reopens it.
     * Same transaction as the move, which has just vacated its identity.
     */
    await this.exec(tx)
      .insert(telegramWizards)
      .values({
        id: leftBehindId,
        tenantId,
        botInstanceId: row.botInstanceId,
        chatId: row.chatId,
        messageId: row.messageId,
        kind: row.kind,
        step: 'CLOSED',
        version: 0,
        subjectId: null,
        paymentId: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    return true;
  }

  async latestWizard(
    scope: TenantContext,
    where: {
      readonly botInstanceId: BotInstanceId;
      readonly chatId: string;
      readonly kind: TelegramWizardKind | null;
      readonly steps: readonly TelegramWizardStep[];
      readonly subjectId: string | null;
      readonly paymentId?: string | null;
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
          where.kind === null ? undefined : eq(telegramWizards.kind, where.kind),
          inArray(telegramWizards.step, [...where.steps]),
          where.subjectId === null ? undefined : eq(telegramWizards.subjectId, where.subjectId),
          where.paymentId === undefined || where.paymentId === null
            ? undefined
            : eq(telegramWizards.paymentId, where.paymentId),
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
        updatedAt: now,
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
      .set({ finalisedAt: now, updatedAt: now })
      .where(and(target, isNull(telegramReviewMessages.finalisedAt)))
      .returning();
    return rows.map(reviewOf);
  }

  async isWithinPurgedHorizon(
    scope: TenantContext,
    ref: TelegramMessageRef,
    tx?: TransactionScope,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .select({ through: telegramMessageHorizons.purgedThroughMessageId })
      .from(telegramMessageHorizons)
      .where(
        and(
          eq(telegramMessageHorizons.tenantId, requireTenantId(scope)),
          eq(telegramMessageHorizons.botInstanceId, ref.botInstanceId),
          eq(telegramMessageHorizons.chatId, ref.chatId),
          gte(telegramMessageHorizons.purgedThroughMessageId, ref.messageId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async purgeWizards(
    scope: TenantContext,
    where: { readonly cutoff: Date; readonly now: Date; readonly limit: number },
    tx: TransactionScope,
  ): Promise<readonly TelegramMessageRef[]> {
    const tenantId = requireTenantId(scope);
    /*
     * The candidates are a MATERIALIZED CTE, evaluated exactly once. Written as
     * `id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` the subquery can be re-run per
     * outer row, and a re-run skips the rows this very statement has just deleted and
     * returns the NEXT n — the bound silently becomes "everything" (the batching test caught
     * exactly that: a limit of 3 deleted 7).
     *
     * Oldest first, bounded, and SKIP LOCKED: a row a turn's claim or a worker's move is
     * writing right now is skipped rather than waited on — and once that write commits its
     * `updated_at` is fresh, so it is not a candidate any more. The outer predicate repeats
     * the age and the lease, so the DELETE judges the row it removes, not the one the
     * subquery read. The tenant is named in both, so another tenant's rows are never read.
     */
    /*
     * A DELAYED writer must still find its row (Codex review of #131). Two reach a wizard
     * after the business fact that would otherwise make it eligible has committed:
     *
     *   - the gateway worker's `refresh(paymentId)`, right after a payment's outcome commits,
     *     and a reviewer's decision on a long-pending receipt — so a payment or an order that
     *     CHANGED within the retention period keeps its wizards (`updated_at` is bumped by
     *     every state transition of both);
     *   - the renewal result's `closeOrder`, sent by the notification lane only once the
     *     order's RENEW operation has succeeded AND been announced AND its notification
     *     delivered — which can be days after the order was paid, if the operation went
     *     UNKNOWN. So an order with an operation still running, a terminal one not yet
     *     announced, or a pending customer notification about one of its operations keeps
     *     its wizards too (`busy_orders`, each branch on an existing partial index).
     */
    const result = await this.exec(tx).execute(sql`
      WITH busy_orders AS MATERIALIZED (
           SELECT op.order_id FROM provisioning_operations AS op
            WHERE op.tenant_id = ${tenantId} AND op.order_id IS NOT NULL
              AND op.state IN (${OPERATION_OPEN})
           UNION
           SELECT op.order_id FROM provisioning_operations AS op
            WHERE op.tenant_id = ${tenantId} AND op.order_id IS NOT NULL
              AND op.announced_at IS NULL AND op.state IN ('SUCCEEDED', 'ABANDONED')
           UNION
           SELECT op.order_id FROM customer_notifications AS n
             JOIN provisioning_operations AS op
               ON op.tenant_id = n.tenant_id AND op.id = n.subject_id
            WHERE n.tenant_id = ${tenantId} AND n.state = 'PENDING'
              AND op.order_id IS NOT NULL),
      victims AS MATERIALIZED (
           SELECT c.id FROM telegram_wizards AS c
            WHERE c.tenant_id = ${tenantId}
              AND c.updated_at < ${where.cutoff}
              AND (c.busy_until IS NULL OR c.busy_until <= ${where.now})
              AND NOT EXISTS (
                SELECT 1 FROM payments AS p
                 WHERE p.tenant_id = c.tenant_id AND p.id = c.payment_id
                   AND (p.state NOT IN (${PAYMENT_DONE}) OR p.updated_at >= ${where.cutoff}))
              AND NOT (c.kind = 'ORDER' AND EXISTS (
                SELECT 1 FROM orders AS o
                 WHERE o.tenant_id = c.tenant_id AND o.id = c.subject_id
                   AND (o.state NOT IN (${ORDER_DONE}) OR o.updated_at >= ${where.cutoff})))
              AND NOT (c.kind = 'ORDER' AND c.subject_id IN (SELECT order_id FROM busy_orders))
            ORDER BY c.updated_at ASC, c.id ASC
            LIMIT ${Math.max(1, where.limit)}
            FOR UPDATE OF c SKIP LOCKED)
      DELETE FROM telegram_wizards AS w
       USING victims
       WHERE w.id = victims.id
         AND w.tenant_id = ${tenantId}
         AND w.updated_at < ${where.cutoff}
         AND (w.busy_until IS NULL OR w.busy_until <= ${where.now})
      RETURNING w.bot_instance_id, w.chat_id, w.message_id`);
    return (result.rows as unknown as PurgedRow[]).map(refOf);
  }

  async purgeReviewMessages(
    scope: TenantContext,
    where: { readonly cutoff: Date; readonly limit: number },
    tx: TransactionScope,
  ): Promise<readonly TelegramMessageRef[]> {
    const tenantId = requireTenantId(scope);
    /*
     * Only a TERMINAL payment's rows: nothing decides it again, so nothing will edit its
     * messages again. `PENDING` (a block leaves the receipt in the queue) and `UNKNOWN`
     * (reconciliation is still to come) keep theirs. The payment is read, never locked.
     *
     * And only once BOTH have been quiet for the retention period (Codex review of #131):
     * the payment's `updated_at`, because a decision commits the payment's terminal state
     * BEFORE `finaliseReview` stamps and edits its messages, and a row deleted in between
     * leaves the receipt card looking actionable; and the row's own `updated_at`, because
     * a stamp cleared after a failed edit (`unfinaliseReviewMessage`) is a retry still owed,
     * not an old row.
     */
    const result = await this.exec(tx).execute(sql`
      WITH victims AS MATERIALIZED (
           SELECT c.id FROM telegram_review_messages AS c
             JOIN payments AS p ON p.tenant_id = c.tenant_id AND p.id = c.payment_id
            WHERE c.tenant_id = ${tenantId}
              AND c.updated_at < ${where.cutoff}
              AND p.state IN (${PAYMENT_DONE})
              AND p.updated_at < ${where.cutoff}
            ORDER BY c.updated_at ASC, c.id ASC
            LIMIT ${Math.max(1, where.limit)}
            FOR UPDATE OF c SKIP LOCKED)
      DELETE FROM telegram_review_messages AS r
       USING victims
       WHERE r.id = victims.id
         AND r.tenant_id = ${tenantId}
         AND r.updated_at < ${where.cutoff}
      RETURNING r.bot_instance_id, r.chat_id, r.message_id`);
    return (result.rows as unknown as PurgedRow[]).map(refOf);
  }

  async raisePurgedHorizons(
    scope: TenantContext,
    refs: readonly TelegramMessageRef[],
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const highest = new Map<string, TelegramMessageRef>();
    for (const ref of refs) {
      const key = `${ref.botInstanceId}\u0000${ref.chatId}`;
      const known = highest.get(key);
      if (known === undefined || ref.messageId > known.messageId) highest.set(key, ref);
    }
    if (highest.size === 0) return;
    /*
     * One row per chat (an upsert may not touch a row twice), in key order, so two sweeps
     * raising overlapping chats take the row locks in the same order and cannot deadlock.
     */
    const ordered = [...highest.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, ref]) => ref);
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .insert(telegramMessageHorizons)
      .values(
        ordered.map((ref) => ({
          tenantId,
          botInstanceId: ref.botInstanceId,
          chatId: ref.chatId,
          purgedThroughMessageId: ref.messageId,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          telegramMessageHorizons.tenantId,
          telegramMessageHorizons.botInstanceId,
          telegramMessageHorizons.chatId,
        ],
        set: {
          purgedThroughMessageId: sql`GREATEST(${telegramMessageHorizons.purgedThroughMessageId}, excluded.purged_through_message_id)`,
          updatedAt: now,
        },
      });
  }

  async unfinaliseReviewMessage(
    scope: TenantContext,
    id: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.exec(tx)
      .update(telegramReviewMessages)
      // `updated_at` too: a stamp cleared for a retry is the row's newest write, and the
      // retention sweep ages the row by it — never by the creation the clear exposes.
      .set({ finalisedAt: null, updatedAt: now })
      .where(
        and(
          eq(telegramReviewMessages.tenantId, requireTenantId(scope)),
          eq(telegramReviewMessages.id, id),
        ),
      );
  }
}
