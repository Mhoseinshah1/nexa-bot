import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import type { IdGenerator, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  admins,
  botInstances,
  ticketCategories,
  ticketMessages,
  tickets,
} from '../../../../infrastructure/persistence/schema.js';
import { MIRZA_SOURCE } from '../application/materialize-support.js';
import {
  ANSWER_REF_SUFFIX,
  LEGACY_MIRZA_TICKET_CATEGORY_TITLE,
  MIRZA_IMPORT_ADMIN_DISPLAY_NAME,
  MIRZA_IMPORT_ADMIN_USERNAME,
  MIRZA_TICKET_CATEGORY_TITLE,
  bodyDigest,
  messageFingerprint,
  ticketFingerprint,
  type TicketHistoryRepository,
  type TicketWrite,
} from '../application/ticket-history.step.js';

/**
 * A password hash that is not one: `ScryptPasswordHasher.verify` parses the stored value
 * first and answers false for anything that does not parse, so no password opens this admin.
 */
const UNUSABLE_PASSWORD_HASH = 'locked$mirza-import$no-login';

/**
 * Tickets and messages of source MIRZA, written directly: no outbox row, no notification,
 * no SLA timer. A message's `seq` is the table's identity, so the order messages are inserted
 * in is the order of the conversation.
 */
/**
 * An administrator named `mirza-import` exists and is not the import's own system identity.
 * The ticket step stops rather than attribute Mirza's support answers to a real person; the
 * owner renames that administrator and resumes the import.
 */
export class MirzaImportAdminCollision extends Error {
  constructor() {
    super(
      `an administrator named "${MIRZA_IMPORT_ADMIN_USERNAME}" already exists and is not the import's disabled system identity; rename it and resume the import`,
    );
    this.name = 'MirzaImportAdminCollision';
  }
}

export class DrizzleTicketHistoryRepository implements TicketHistoryRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async resolveBot(scope: TenantContext, tx?: TransactionScope): Promise<string | null> {
    const rows = await this.exec(tx)
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(eq(botInstances.tenantId, requireTenantId(scope)))
      // ACTIVE sorts first ('ACTIVE' < 'DISABLED' < 'STOPPED'), then the oldest.
      .orderBy(asc(botInstances.status), asc(botInstances.createdAt), asc(botInstances.id))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async ensureCategory(scope: TenantContext, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    // A category an earlier release created under the old title is the same category.
    await this.retitleLegacyCategory(scope, now, tx);
    const existing = await this.findCategory(tenantId, tx);
    if (existing !== undefined) return existing;
    await this.exec(tx)
      .insert(ticketCategories)
      .values({
        id: this.ids.uuid(),
        tenantId,
        title: MIRZA_TICKET_CATEGORY_TITLE,
        sortOrder: 0,
        // A customer is never offered it: imported tickets are history, not a place to file.
        isActive: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [ticketCategories.tenantId, ticketCategories.title] });
    const row = await this.findCategory(tenantId, tx);
    if (row === undefined) throw new Error('the Mirza ticket category was not found after insert');
    return row;
  }

  /**
   * Brings the category an earlier release wrote ('Mirza (imported)') to the neutral title,
   * with the title its tickets carry. Idempotent, and a no-op once no such category is left.
   *
   * - No neutral category yet: the old row is renamed IN PLACE, so its id, and every ticket
   *   filed under it, stay as they are.
   * - A neutral one already exists (the title is unique per tenant, so the rename would
   *   collide): the old row's tickets are re-pointed to the neutral one, and the old row,
   *   which then holds no ticket, is removed. No ticket is lost or copied: the move is one
   *   UPDATE of `category_id` inside the caller's transaction.
   */
  async retitleLegacyCategory(scope: TenantContext, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: ticketCategories.id, title: ticketCategories.title })
      .from(ticketCategories)
      .where(
        and(
          eq(ticketCategories.tenantId, tenantId),
          inArray(ticketCategories.title, [
            MIRZA_TICKET_CATEGORY_TITLE,
            LEGACY_MIRZA_TICKET_CATEGORY_TITLE,
          ]),
        ),
      )
      .for('update');
    const legacy = rows.find((r) => r.title === LEGACY_MIRZA_TICKET_CATEGORY_TITLE);
    if (legacy === undefined) return;
    const neutral = rows.find((r) => r.title === MIRZA_TICKET_CATEGORY_TITLE);
    const target = neutral?.id ?? legacy.id;
    if (neutral === undefined) {
      await this.exec(tx)
        .update(ticketCategories)
        .set({ title: MIRZA_TICKET_CATEGORY_TITLE, updatedAt: now })
        .where(
          and(
            eq(ticketCategories.tenantId, tenantId),
            eq(ticketCategories.id, legacy.id),
            eq(ticketCategories.title, LEGACY_MIRZA_TICKET_CATEGORY_TITLE),
          ),
        );
    }
    // The title is snapshotted on each ticket, so the pages read it from there.
    await this.exec(tx)
      .update(tickets)
      .set({ categoryId: target, categoryTitle: MIRZA_TICKET_CATEGORY_TITLE })
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.categoryId, legacy.id)));
    if (neutral !== undefined) {
      await this.exec(tx)
        .delete(ticketCategories)
        .where(
          and(
            eq(ticketCategories.tenantId, tenantId),
            eq(ticketCategories.id, legacy.id),
            eq(ticketCategories.title, LEGACY_MIRZA_TICKET_CATEGORY_TITLE),
            sql`NOT EXISTS (SELECT 1 FROM ${tickets} WHERE ${tickets.tenantId} = ${tenantId} AND ${tickets.categoryId} = ${legacy.id})`,
          ),
        );
    }
  }

  /** The import's category, under its neutral title. */
  private async findCategory(tenantId: string, tx: TransactionScope) {
    const [row] = await this.exec(tx)
      .select({ id: ticketCategories.id, title: ticketCategories.title })
      .from(ticketCategories)
      .where(
        and(
          eq(ticketCategories.tenantId, tenantId),
          eq(ticketCategories.title, MIRZA_TICKET_CATEGORY_TITLE),
        ),
      );
    return row;
  }

  async ensureImportAdmin(scope: TenantContext, now: Date, tx: TransactionScope): Promise<string> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .insert(admins)
      .values({
        id: this.ids.uuid(),
        tenantId,
        username: MIRZA_IMPORT_ADMIN_USERNAME,
        displayName: MIRZA_IMPORT_ADMIN_DISPLAY_NAME,
        passwordHash: UNUSABLE_PASSWORD_HASH,
        passwordUpdatedAt: now,
        status: 'DISABLED',
        disabledAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [admins.tenantId, admins.username] });
    const [row] = await this.exec(tx)
      .select({ id: admins.id, status: admins.status, passwordHash: admins.passwordHash })
      .from(admins)
      .where(and(eq(admins.tenantId, tenantId), eq(admins.username, MIRZA_IMPORT_ADMIN_USERNAME)));
    if (row === undefined) throw new Error('the mirza-import admin was not found after insert');
    // The name is an ordinary admin username, so an operator may already have taken it. Only
    // the identity this step creates — DISABLED, with a hash no password verifies — may sign
    // Mirza's answers; a real administrator is never made their author (Codex on #288).
    if (row.status !== 'DISABLED' || row.passwordHash !== UNUSABLE_PASSWORD_HASH) {
      throw new MirzaImportAdminCollision();
    }
    return row.id;
  }

  async existingTickets(scope: TenantContext, sourceRefs: readonly string[], tx: TransactionScope) {
    const out = new Map<string, { id: string; fingerprint: string }>();
    if (sourceRefs.length === 0) return out;
    const rows = await this.exec(tx)
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, requireTenantId(scope)),
          inArray(tickets.sourceRef, [...sourceRefs]),
        ),
      );
    for (const row of rows) {
      if (row.sourceRef === null) continue;
      out.set(row.sourceRef, {
        id: row.id,
        fingerprint: ticketFingerprint({
          customerId: row.customerId,
          subject: row.subject,
          createdAt: row.createdAt,
          closedAt: row.closedAt ?? row.createdAt,
        }),
      });
    }
    return out;
  }

  async existingMessages(
    scope: TenantContext,
    sourceRefs: readonly string[],
    tx: TransactionScope,
  ) {
    const out = new Map<string, string>();
    if (sourceRefs.length === 0) return out;
    const rows = await this.exec(tx)
      .select()
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.tenantId, requireTenantId(scope)),
          inArray(ticketMessages.sourceRef, [...sourceRefs]),
        ),
      );
    for (const row of rows) {
      if (row.sourceRef === null) continue;
      out.set(
        row.sourceRef,
        messageFingerprint({
          sender: row.senderType,
          at: row.createdAt,
          bodyDigest: bodyDigest(row.body ?? ''),
        }),
      );
    }
    return out;
  }

  async insertThread(
    scope: TenantContext,
    thread: TicketWrite,
    context: {
      readonly botInstanceId: string;
      readonly category: { readonly id: string; readonly title: string };
      readonly adminId: string | null;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const ticketId = this.ids.uuid();
    const done = await this.exec(tx)
      .insert(tickets)
      .values({
        id: ticketId,
        tenantId,
        customerId: thread.customerId,
        botInstanceId: context.botInstanceId,
        categoryId: context.category.id,
        categoryTitle: context.category.title,
        subject: thread.subject,
        status: 'CLOSED',
        priority: 'NORMAL',
        openingKey: `legacy:${thread.sourceRef}`,
        origin: 'BOT',
        createdAt: thread.createdAt,
        updatedAt: thread.closedAt,
        lastMessageAt: thread.closedAt,
        closedAt: thread.closedAt,
        source: MIRZA_SOURCE,
        sourceRef: thread.sourceRef,
      })
      .onConflictDoNothing()
      .returning({ id: tickets.id });
    if (done.length === 0) return false;
    // One INSERT per message, in order: `seq` is an identity, assigned as rows are inserted.
    for (const m of thread.messages) {
      await this.exec(tx)
        .insert(ticketMessages)
        .values({
          id: this.ids.uuid(),
          tenantId,
          ticketId,
          senderType: m.sender,
          authorAdminId: m.sender === 'ADMIN' ? context.adminId : null,
          body: m.body,
          idempotencyKey: `legacy:${m.sourceRef}`,
          requestHash: bodyDigest(m.body),
          createdAt: m.at,
          source: MIRZA_SOURCE,
          sourceRef: m.sourceRef,
        });
    }
    return true;
  }

  async countTickets(scope: TenantContext, prefix: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, requireTenantId(scope)),
          eq(tickets.source, MIRZA_SOURCE),
          like(tickets.sourceRef, `${prefix}%`),
        ),
      );
    return row?.n ?? 0;
  }

  async countMessages(
    scope: TenantContext,
    prefix: string,
    part: 'PRIMARY' | 'ANSWER' | 'ALL',
  ): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.tenantId, requireTenantId(scope)),
          eq(ticketMessages.source, MIRZA_SOURCE),
          like(ticketMessages.sourceRef, `${prefix}%`),
          part === 'ALL'
            ? undefined
            : part === 'ANSWER'
              ? like(ticketMessages.sourceRef, `%${ANSWER_REF_SUFFIX}`)
              : sql`${ticketMessages.sourceRef} NOT LIKE ${'%' + ANSWER_REF_SUFFIX}`,
        ),
      );
    return row?.n ?? 0;
  }
}
