import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import {
  money,
  type CurrencyCode,
  type ResellerRequestAnswer,
  type ResellerRequestListFilter,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  resellerRequestDrafts,
  resellerRequestMessages,
  resellerRequestQuestions,
  resellerRequests,
} from '../../../../infrastructure/persistence/schema.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import type {
  AskedQuestion,
  CustomerFacts,
  DraftRecord,
  MessageRecord,
  QuestionRecord,
  RequestCounts,
  RequestListItem,
  RequestRecord,
  ResellerRequestRepository,
} from '../application/ports.js';

/** One tenant's question edits, serialised. 'RQ'. */
export const RESELLER_REQUEST_QUESTIONS_LOCK_CLASS = 0x5251;
/** One customer's submits, serialised. 'RC'. */
export const RESELLER_REQUEST_CUSTOMER_LOCK_CLASS = 0x5243;

type RequestRow = typeof resellerRequests.$inferSelect;
type MessageRow = typeof resellerRequestMessages.$inferSelect;
type DraftRow = typeof resellerRequestDrafts.$inferSelect;

function toRequest(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    number: row.number,
    customerId: row.customerId,
    botInstanceId: row.botInstanceId,
    answers: row.answers as ResellerRequestAnswer[],
    status: row.status as RequestRecord['status'],
    decidedByAdminId: row.decidedByAdminId,
    tierId: row.tierId,
    reason: row.reason,
    openingKey: row.openingKey,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    lastMessageAt: row.lastMessageAt,
  };
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    requestId: row.requestId,
    senderType: row.senderType as MessageRecord['senderType'],
    authorAdminId: row.authorAdminId,
    body: row.body,
    attachment:
      row.attachmentKind === null ||
      row.attachmentBotInstanceId === null ||
      row.attachmentFileId === null ||
      row.attachmentFileUniqueId === null
        ? null
        : {
            kind: row.attachmentKind as 'PHOTO',
            botInstanceId: row.attachmentBotInstanceId,
            fileId: row.attachmentFileId,
            fileUniqueId: row.attachmentFileUniqueId,
            mimeType: row.attachmentMimeType,
            fileSize: row.attachmentFileSize,
          },
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    createdAt: row.createdAt,
  };
}

function toDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    botInstanceId: row.botInstanceId,
    questions: row.questions as AskedQuestion[],
    answers: row.answers as (string | null)[],
    position: row.position,
    updatedAt: row.updatedAt,
  };
}

/** The reseller requests of one tenant. Every query carries the tenant. */
@ScopeBound()
export class DrizzleResellerRequestRepository implements ResellerRequestRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  // -- questions ------------------------------------------------------------------------

  async listQuestions(scope: TenantContext, tx?: unknown): Promise<readonly QuestionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequestQuestions)
      .where(
        and(
          eq(resellerRequestQuestions.tenantId, tenantId),
          eq(resellerRequestQuestions.active, true),
        ),
      )
      .orderBy(asc(resellerRequestQuestions.position), asc(resellerRequestQuestions.id));
    return rows.map((row) => ({
      id: row.id,
      position: row.position,
      text: row.text,
      required: row.required,
      maxLength: row.maxLength,
    }));
  }

  async lockTenant(scope: TenantContext, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${RESELLER_REQUEST_QUESTIONS_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }

  async replaceQuestions(
    scope: TenantContext,
    next: readonly (Omit<QuestionRecord, 'position'> & { readonly isNew: boolean })[],
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const exec = this.exec(tx);
    const keep = next.filter((one) => !one.isNew).map((one) => one.id);
    // A question the list drops stays as a record of what was once asked.
    await exec
      .update(resellerRequestQuestions)
      .set({ active: false, updatedAt: now })
      .where(
        and(
          eq(resellerRequestQuestions.tenantId, tenantId),
          eq(resellerRequestQuestions.active, true),
          keep.length === 0
            ? undefined
            : sql`${resellerRequestQuestions.id} NOT IN (${sql.join(
                keep.map((id) => sql`${id}`),
                sql`, `,
              )})`,
        ),
      );
    for (const [position, one] of next.entries()) {
      if (one.isNew) {
        await exec.insert(resellerRequestQuestions).values({
          id: one.id,
          tenantId,
          position,
          text: one.text,
          required: one.required,
          maxLength: one.maxLength,
          active: true,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        await exec
          .update(resellerRequestQuestions)
          .set({
            position,
            text: one.text,
            required: one.required,
            maxLength: one.maxLength,
            updatedAt: now,
          })
          .where(
            and(
              eq(resellerRequestQuestions.tenantId, tenantId),
              eq(resellerRequestQuestions.id, one.id),
            ),
          );
      }
    }
  }

  // -- drafts ---------------------------------------------------------------------------

  async findDraftByCustomer(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<DraftRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequestDrafts)
      .where(
        and(
          eq(resellerRequestDrafts.tenantId, tenantId),
          eq(resellerRequestDrafts.customerId, customerId),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toDraft(rows[0]);
  }

  async putDraft(
    scope: TenantContext,
    draft: {
      readonly id: string;
      readonly customerId: string;
      readonly botInstanceId: string;
      readonly questions: readonly AskedQuestion[];
    },
    now: Date,
    tx: unknown,
  ): Promise<DraftRecord> {
    const tenantId = requireTenantId(scope);
    const exec = this.exec(tx);
    await exec
      .delete(resellerRequestDrafts)
      .where(
        and(
          eq(resellerRequestDrafts.tenantId, tenantId),
          eq(resellerRequestDrafts.customerId, draft.customerId),
        ),
      );
    const rows = await exec
      .insert(resellerRequestDrafts)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        botInstanceId: draft.botInstanceId,
        questions: draft.questions as unknown as Record<string, unknown>[],
        answers: draft.questions.map(() => null),
        position: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toDraft(rows[0] as DraftRow);
  }

  async saveDraft(
    scope: TenantContext,
    id: string,
    patch: { readonly answers: readonly (string | null)[]; readonly position: number },
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .update(resellerRequestDrafts)
      .set({
        answers: patch.answers as unknown as string[],
        position: patch.position,
        updatedAt: now,
      })
      .where(and(eq(resellerRequestDrafts.tenantId, tenantId), eq(resellerRequestDrafts.id, id)));
  }

  async deleteDraft(scope: TenantContext, id: string, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .delete(resellerRequestDrafts)
      .where(and(eq(resellerRequestDrafts.tenantId, tenantId), eq(resellerRequestDrafts.id, id)));
  }

  // -- requests -------------------------------------------------------------------------

  async lockCustomer(scope: TenantContext, customerId: string, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${RESELLER_REQUEST_CUSTOMER_LOCK_CLASS}, hashtext(${tenantId + customerId}))`,
    );
  }

  async insertRequest(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly customerId: string;
      readonly botInstanceId: string;
      readonly answers: readonly ResellerRequestAnswer[];
      readonly openingKey: string;
    },
    now: Date,
    tx: unknown,
  ): Promise<RequestRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(resellerRequests)
      .values({
        id: input.id,
        tenantId,
        customerId: input.customerId,
        botInstanceId: input.botInstanceId,
        answers: input.answers as unknown as Record<string, unknown>[],
        status: 'PENDING',
        openingKey: input.openingKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toRequest(rows[0] as RequestRow);
  }

  async findById(scope: TenantContext, id: string, tx?: unknown): Promise<RequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequests)
      .where(and(eq(resellerRequests.tenantId, tenantId), eq(resellerRequests.id, id)))
      .limit(1);
    return rows[0] === undefined ? null : toRequest(rows[0]);
  }

  async findByIdForUpdate(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<RequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequests)
      .where(and(eq(resellerRequests.tenantId, tenantId), eq(resellerRequests.id, id)))
      .limit(1)
      .for('update');
    return rows[0] === undefined ? null : toRequest(rows[0]);
  }

  async findByOpeningKey(
    scope: TenantContext,
    key: string,
    tx?: unknown,
  ): Promise<RequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequests)
      .where(and(eq(resellerRequests.tenantId, tenantId), eq(resellerRequests.openingKey, key)))
      .limit(1);
    return rows[0] === undefined ? null : toRequest(rows[0]);
  }

  async findPendingByCustomer(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<RequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequests)
      .where(
        and(
          eq(resellerRequests.tenantId, tenantId),
          eq(resellerRequests.customerId, customerId),
          eq(resellerRequests.status, 'PENDING'),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toRequest(rows[0]);
  }

  async findLastRejected(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<RequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequests)
      .where(
        and(
          eq(resellerRequests.tenantId, tenantId),
          eq(resellerRequests.customerId, customerId),
          eq(resellerRequests.status, 'REJECTED'),
        ),
      )
      .orderBy(desc(resellerRequests.decidedAt), desc(resellerRequests.id))
      .limit(1);
    return rows[0] === undefined ? null : toRequest(rows[0]);
  }

  async decide(
    scope: TenantContext,
    id: string,
    to: {
      readonly status: 'REJECTED' | 'APPROVED';
      readonly adminId: string;
      readonly tierId: string | null;
      readonly reason: string | null;
    },
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(resellerRequests)
      .set({
        status: to.status,
        decidedByAdminId: to.adminId,
        tierId: to.tierId,
        reason: to.reason,
        decidedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(resellerRequests.tenantId, tenantId),
          eq(resellerRequests.id, id),
          eq(resellerRequests.status, 'PENDING'),
        ),
      )
      .returning({ id: resellerRequests.id });
    return rows.length === 1;
  }

  async list(
    scope: TenantContext,
    query: {
      readonly filter: ResellerRequestListFilter | null;
      readonly limit: number;
      readonly before: { readonly at: Date; readonly id: string } | null;
    },
  ): Promise<readonly RequestListItem[]> {
    const tenantId = requireTenantId(scope);
    const spoke = sql`EXISTS (SELECT 1 FROM reseller_request_messages m
        WHERE m.tenant_id = ${resellerRequests.tenantId} AND m.request_id = ${resellerRequests.id}
          AND m.sender_type = 'ADMIN')`;
    const filter =
      query.filter === null
        ? undefined
        : query.filter === 'PENDING'
          ? and(eq(resellerRequests.status, 'PENDING'), sql`NOT ${spoke}`)
          : query.filter === 'CONVERSING'
            ? and(eq(resellerRequests.status, 'PENDING'), spoke)
            : eq(resellerRequests.status, query.filter);
    const rows = await this.db
      .select({
        request: resellerRequests,
        firstName: sql<string | null>`c.first_name`,
        lastName: sql<string | null>`c.last_name`,
        username: sql<string | null>`c.username`,
        conversing: sql<boolean>`(${resellerRequests.status} = 'PENDING' AND ${spoke})`,
      })
      .from(resellerRequests)
      .innerJoin(
        sql`customers c`,
        sql`c.tenant_id = ${resellerRequests.tenantId} AND c.id = ${resellerRequests.customerId}`,
      )
      .where(
        and(
          eq(resellerRequests.tenantId, tenantId),
          filter,
          query.before === null
            ? undefined
            : or(
                lt(resellerRequests.createdAt, query.before.at),
                and(
                  eq(resellerRequests.createdAt, query.before.at),
                  lt(resellerRequests.id, query.before.id),
                ),
              ),
        ),
      )
      .orderBy(desc(resellerRequests.createdAt), desc(resellerRequests.id))
      .limit(query.limit);
    return rows.map((row) => ({
      request: toRequest(row.request),
      customerName:
        [row.firstName, row.lastName].filter((part) => part !== null && part !== '').join(' ') ||
        null,
      customerUsername: row.username,
      conversing: row.conversing === true,
    }));
  }

  async counts(scope: TenantContext): Promise<RequestCounts> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT
        count(*) FILTER (WHERE r.status = 'PENDING' AND NOT s.spoke)::int AS pending,
        count(*) FILTER (WHERE r.status = 'PENDING' AND s.spoke)::int AS conversing,
        count(*) FILTER (WHERE r.status = 'APPROVED')::int AS approved,
        count(*) FILTER (WHERE r.status = 'REJECTED')::int AS rejected
      FROM reseller_requests r
      CROSS JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM reseller_request_messages m
                        WHERE m.tenant_id = r.tenant_id AND m.request_id = r.id
                          AND m.sender_type = 'ADMIN') AS spoke
      ) s
      WHERE r.tenant_id = ${tenantId}`);
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    return {
      pending: Number(row.pending ?? 0),
      conversing: Number(row.conversing ?? 0),
      approved: Number(row.approved ?? 0),
      rejected: Number(row.rejected ?? 0),
    };
  }

  async customerFacts(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<CustomerFacts | null> {
    const tenantId = requireTenantId(scope);
    const exec = this.exec(tx);
    const customer = await exec.execute(sql`
      SELECT telegram_user_id, username, first_name, last_name
      FROM customers WHERE tenant_id = ${tenantId} AND id = ${customerId}`);
    const row = customer.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const services = await exec.execute(sql`
      SELECT count(*)::int AS n FROM services WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}`);
    // The selling currencies only (`SALES_CURRENCY_CODES`): a crypto top-up is not "paid".
    const paid = await exec.execute(sql`
      SELECT currency, coalesce(sum(amount), 0)::text AS total
      FROM payments
      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
        AND state = 'CONFIRMED' AND currency IN ('IRT', 'IRR')
      GROUP BY currency ORDER BY sum(amount) DESC LIMIT 1`);
    const top = paid.rows[0] as Record<string, unknown> | undefined;
    const name = [row.first_name, row.last_name]
      .filter((part) => typeof part === 'string' && part !== '')
      .join(' ');
    return {
      displayName: name === '' ? null : name,
      username: typeof row.username === 'string' ? row.username : null,
      telegramUserId: String(row.telegram_user_id),
      servicesCount: Number((services.rows[0] as Record<string, unknown> | undefined)?.n ?? 0),
      totalPaid:
        top === undefined
          ? null
          : money(BigInt(String(top.total)), String(top.currency) as CurrencyCode),
    };
  }

  async adminNames(
    scope: TenantContext,
    ids: readonly string[],
    tx?: unknown,
  ): Promise<ReadonlyMap<string, string>> {
    const tenantId = requireTenantId(scope);
    if (ids.length === 0) return new Map();
    const result = await this.exec(tx).execute(sql`
      SELECT id, display_name FROM admins
      WHERE tenant_id = ${tenantId} AND id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`);
    return new Map(
      (result.rows as Record<string, unknown>[]).map((row) => [
        String(row.id),
        String(row.display_name),
      ]),
    );
  }

  async customerIdOfTelegramUser(
    scope: TenantContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT id FROM customers
      WHERE tenant_id = ${tenantId} AND telegram_user_id = ${telegramUserId} LIMIT 1`);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : String(row.id);
  }

  // -- messages -------------------------------------------------------------------------

  async insertMessage(
    scope: TenantContext,
    input: Parameters<ResellerRequestRepository['insertMessage']>[1],
    now: Date,
    tx: unknown,
  ): Promise<MessageRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(resellerRequestMessages)
      .values({
        id: input.id,
        tenantId,
        requestId: input.requestId,
        senderType: input.senderType,
        authorAdminId: input.authorAdminId,
        body: input.body,
        attachmentKind: input.attachment?.kind ?? null,
        attachmentBotInstanceId: input.attachment?.botInstanceId ?? null,
        attachmentFileId: input.attachment?.fileId ?? null,
        attachmentFileUniqueId: input.attachment?.fileUniqueId ?? null,
        attachmentMimeType: input.attachment?.mimeType ?? null,
        attachmentFileSize: input.attachment?.fileSize ?? null,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: now,
      })
      .returning();
    return toMessage(rows[0] as MessageRow);
  }

  async findMessageByKey(
    scope: TenantContext,
    key: string,
    tx?: unknown,
  ): Promise<MessageRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequestMessages)
      .where(
        and(
          eq(resellerRequestMessages.tenantId, tenantId),
          eq(resellerRequestMessages.idempotencyKey, key),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toMessage(rows[0]);
  }

  async findMessageById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<MessageRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequestMessages)
      .where(
        and(eq(resellerRequestMessages.tenantId, tenantId), eq(resellerRequestMessages.id, id)),
      )
      .limit(1);
    return rows[0] === undefined ? null : toMessage(rows[0]);
  }

  async listMessages(
    scope: TenantContext,
    requestId: string,
    tx?: unknown,
  ): Promise<readonly MessageRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(resellerRequestMessages)
      .where(
        and(
          eq(resellerRequestMessages.tenantId, tenantId),
          eq(resellerRequestMessages.requestId, requestId),
        ),
      )
      .orderBy(asc(resellerRequestMessages.seq));
    return rows.map(toMessage);
  }

  async countMessages(scope: TenantContext, requestId: string, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT count(*)::int AS n FROM reseller_request_messages
      WHERE tenant_id = ${tenantId} AND request_id = ${requestId}`);
    return Number((result.rows[0] as Record<string, unknown> | undefined)?.n ?? 0);
  }

  async touch(scope: TenantContext, requestId: string, now: Date, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .update(resellerRequests)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(and(eq(resellerRequests.tenantId, tenantId), eq(resellerRequests.id, requestId)));
  }
}
