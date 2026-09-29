import { sql, type SQL } from 'drizzle-orm';
import {
  canonicalAudienceDefinition,
  type BroadcastButton,
  type BroadcastContentKind,
  type BroadcastCounts,
  type BroadcastMediaMimeType,
  type BroadcastPauseReason,
  type BroadcastRecipientState,
  type BroadcastState,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  audienceCustomersQuery,
  fingerprintOf,
  type AudienceEvaluation,
} from '../../audience/infrastructure/audience-sql.js';
import type {
  BroadcastContent,
  BroadcastDraftInput,
  BroadcastMediaInput,
  BroadcastMediaSource,
  BroadcastRecord,
  BroadcastRepository,
  ClaimedRecipient,
  RecipientOutcome,
  RecipientPageRow,
} from '../application/ports.js';

interface BroadcastRow {
  id: string;
  title: string;
  state: BroadcastState;
  pause_reason: BroadcastPauseReason | null;
  content_kind: BroadcastContentKind;
  body: string;
  buttons: BroadcastButton[];
  audience_definition: unknown;
  audience_hash: string;
  audience_as_of: Date | string | null;
  recipient_count: number | null;
  audience_fingerprint: string | null;
  scheduled_at: Date | string | null;
  version: number;
  created_by_id: string | null;
  created_by_username: string | null;
  launched_by_id: string | null;
  launched_by_username: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  launched_at: Date | string | null;
  started_at: Date | string | null;
  paused_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  media_kind: string | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  media_byte_length: number | null;
  media_available: boolean | null;
}

const date = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const maybeDate = (value: Date | string | null): Date | null =>
  value === null ? null : date(value);

function toRecord(row: BroadcastRow): BroadcastRecord {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    pauseReason: row.pause_reason,
    contentKind: row.content_kind,
    body: row.body,
    buttons: row.buttons,
    audienceDefinition: canonicalAudienceDefinition(row.audience_definition),
    audienceHash: row.audience_hash,
    audienceAsOf: maybeDate(row.audience_as_of),
    recipientCount: row.recipient_count,
    audienceFingerprint: row.audience_fingerprint,
    scheduledAt: maybeDate(row.scheduled_at),
    version: row.version,
    createdBy:
      row.created_by_id === null
        ? null
        : { id: row.created_by_id, username: row.created_by_username ?? '' },
    launchedBy:
      row.launched_by_id === null
        ? null
        : { id: row.launched_by_id, username: row.launched_by_username ?? '' },
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    launchedAt: maybeDate(row.launched_at),
    startedAt: maybeDate(row.started_at),
    pausedAt: maybeDate(row.paused_at),
    completedAt: maybeDate(row.completed_at),
    cancelledAt: maybeDate(row.cancelled_at),
    media:
      row.media_kind === null
        ? null
        : {
            kind: row.media_kind as Exclude<BroadcastContentKind, 'TEXT'>,
            mimeType: row.media_mime_type as BroadcastMediaMimeType,
            fileName: row.media_file_name ?? '',
            byteLength: row.media_byte_length ?? 0,
            available: row.media_available === true,
          },
  };
}

const EMPTY_COUNTS: BroadcastCounts = {
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  unconfirmed: 0,
  failed: 0,
  unreachable: 0,
  skipped: 0,
  cancelled: 0,
};

/**
 * The broadcast tables (round N). Every query carries the tenant; every state change is a
 * conditional UPDATE naming its `from` states; nothing here talks to Telegram.
 */
export class DrizzleBroadcastRepository implements BroadcastRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private async rows<T>(query: SQL, tx?: unknown): Promise<T[]> {
    const result = await this.exec(tx).execute<T & Record<string, unknown>>(query);
    return result.rows as T[];
  }

  private selectBroadcast(where: SQL, suffix: SQL = sql``): SQL {
    return sql`SELECT b.id, b.title, b.state, b.pause_reason, b.content_kind, b.body, b.buttons,
                      b.audience_definition, b.audience_hash, b.audience_as_of, b.recipient_count,
                      b.audience_fingerprint, b.scheduled_at, b.version,
                      b.created_by_admin_id AS created_by_id, ca.username AS created_by_username,
                      b.launched_by_admin_id AS launched_by_id, la.username AS launched_by_username,
                      b.created_at, b.updated_at, b.launched_at, b.started_at, b.paused_at,
                      b.completed_at, b.cancelled_at,
                      m.kind AS media_kind, m.mime_type AS media_mime_type,
                      m.file_name AS media_file_name, m.byte_length AS media_byte_length,
                      (m.content IS NOT NULL) AS media_available
                 FROM broadcasts b
                 LEFT JOIN admins ca ON ca.id = b.created_by_admin_id
                 LEFT JOIN admins la ON la.id = b.launched_by_admin_id
                 LEFT JOIN broadcast_media m ON m.tenant_id = b.tenant_id AND m.broadcast_id = b.id
                WHERE ${where} ${suffix}`;
  }

  async create(scope: TenantContext, draft: BroadcastDraftInput, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(sql`
      INSERT INTO broadcasts (id, tenant_id, title, state, content_kind, body, buttons,
                              audience_definition, audience_hash, version, created_by_admin_id,
                              created_at, updated_at)
      VALUES (${draft.id}::uuid, ${tenantId}::uuid, ${draft.title}, 'DRAFT', ${draft.contentKind},
              ${draft.body}, ${JSON.stringify(draft.buttons)}::jsonb, ${draft.audienceJson}::jsonb,
              ${draft.audienceHash}, 1, ${draft.createdByAdminId}::uuid,
              ${draft.now.toISOString()}::timestamptz, ${draft.now.toISOString()}::timestamptz)`);
  }

  async find(scope: TenantContext, id: string, tx?: unknown): Promise<BroadcastRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<BroadcastRow>(
      this.selectBroadcast(sql`b.tenant_id = ${tenantId}::uuid AND b.id = ${id}::uuid`),
      tx,
    );
    return row === undefined ? null : toRecord(row);
  }

  async lock(scope: TenantContext, id: string, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT 1 FROM broadcasts WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`,
    );
    return this.find(scope, id, tx);
  }

  async updateDraft(
    scope: TenantContext,
    id: string,
    expectedVersion: number,
    input: Omit<BroadcastDraftInput, 'id' | 'createdByAdminId'>,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows<{ id: string }>(
      sql`UPDATE broadcasts
             SET title = ${input.title}, content_kind = ${input.contentKind}, body = ${input.body},
                 buttons = ${JSON.stringify(input.buttons)}::jsonb,
                 audience_definition = ${input.audienceJson}::jsonb,
                 audience_hash = ${input.audienceHash}, version = version + 1,
                 updated_at = ${input.now.toISOString()}::timestamptz
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid
             AND state = 'DRAFT' AND version = ${expectedVersion}
       RETURNING id`,
      tx,
    );
    return rows.length === 1;
  }

  async dropMismatchedMedia(scope: TenantContext, id: string, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(sql`
      DELETE FROM broadcast_media m
       USING broadcasts b
       WHERE m.tenant_id = ${tenantId}::uuid AND m.broadcast_id = ${id}::uuid
         AND b.tenant_id = m.tenant_id AND b.id = m.broadcast_id
         AND b.content_kind <> m.kind`);
  }

  async lockStaging(scope: TenantContext, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('broadcast_media:' || ${tenantId}))`,
    );
  }

  async stagedBytes(scope: TenantContext, excluding: string, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<{ total: string | null }>(
      sql`SELECT coalesce(sum(byte_length), 0)::text AS total FROM broadcast_media
           WHERE tenant_id = ${tenantId}::uuid AND content IS NOT NULL
             AND broadcast_id <> ${excluding}::uuid`,
      tx,
    );
    return Number(row?.total ?? 0);
  }

  async putMedia(
    scope: TenantContext,
    id: string,
    media: BroadcastMediaInput,
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const at = media.now.toISOString();
    // A replaced file invalidates every handle Telegram gave for the previous one.
    await this.exec(tx).execute(sql`
      DELETE FROM broadcast_media_handles
       WHERE tenant_id = ${tenantId}::uuid AND broadcast_id = ${id}::uuid`);
    await this.exec(tx).execute(sql`
      INSERT INTO broadcast_media (tenant_id, broadcast_id, kind, mime_type, file_name, byte_length,
                                   sha256, content, purged_at, created_at)
      VALUES (${tenantId}::uuid, ${id}::uuid, ${media.kind}, ${media.mimeType}, ${media.fileName},
              ${media.bytes.length}, ${media.sha256}, ${Buffer.from(media.bytes)}, NULL,
              ${at}::timestamptz)
      ON CONFLICT (tenant_id, broadcast_id) DO UPDATE
        SET kind = excluded.kind, mime_type = excluded.mime_type, file_name = excluded.file_name,
            byte_length = excluded.byte_length, sha256 = excluded.sha256,
            content = excluded.content, purged_at = NULL, created_at = excluded.created_at`);
  }

  async removeMedia(scope: TenantContext, id: string, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(sql`
      DELETE FROM broadcast_media_handles
       WHERE tenant_id = ${tenantId}::uuid AND broadcast_id = ${id}::uuid`);
    const rows = await this.rows<{ broadcast_id: string }>(
      sql`DELETE FROM broadcast_media WHERE tenant_id = ${tenantId}::uuid
            AND broadcast_id = ${id}::uuid RETURNING broadcast_id`,
      tx,
    );
    return rows.length > 0;
  }

  async bumpVersion(scope: TenantContext, id: string, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(sql`
      UPDATE broadcasts SET version = version + 1, updated_at = ${now.toISOString()}::timestamptz
       WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`);
  }

  async mediaSource(
    scope: TenantContext,
    id: string,
    botInstanceId: string,
    tx?: unknown,
  ): Promise<BroadcastMediaSource | null> {
    const tenantId = requireTenantId(scope);
    const [handle] = await this.rows<{ telegram_file_id: string }>(
      sql`SELECT telegram_file_id FROM broadcast_media_handles
           WHERE tenant_id = ${tenantId}::uuid AND broadcast_id = ${id}::uuid
             AND bot_instance_id = ${botInstanceId}::uuid`,
      tx,
    );
    if (handle !== undefined) return { kind: 'FILE_ID', fileId: handle.telegram_file_id };
    const [media] = await this.rows<{
      content: Buffer | null;
      file_name: string;
      mime_type: BroadcastMediaMimeType;
    }>(
      sql`SELECT content, file_name, mime_type FROM broadcast_media
           WHERE tenant_id = ${tenantId}::uuid AND broadcast_id = ${id}::uuid`,
      tx,
    );
    if (media === undefined || media.content === null) return null;
    return {
      kind: 'BYTES',
      bytes: new Uint8Array(media.content),
      fileName: media.file_name,
      mimeType: media.mime_type,
    };
  }

  async rememberHandle(
    scope: TenantContext,
    id: string,
    botInstanceId: string,
    fileId: string,
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(sql`
      INSERT INTO broadcast_media_handles (tenant_id, broadcast_id, bot_instance_id, telegram_file_id)
      VALUES (${tenantId}::uuid, ${id}::uuid, ${botInstanceId}::uuid, ${fileId})
      ON CONFLICT DO NOTHING`);
  }

  async materialise(
    scope: TenantContext,
    id: string,
    evaluation: AudienceEvaluation,
    now: Date,
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const at = now.toISOString();
    /*
     * The recipient identity is frozen HERE: the customer, the bot the message will go
     * through and the chat. A customer who never wrote to a bot is recorded UNREACHABLE at
     * once — part of the confirmed count, never silently dropped from it.
     */
    await this.exec(tx).execute(sql`
      INSERT INTO broadcast_recipients (tenant_id, broadcast_id, customer_id, bot_instance_id,
                                        chat_id, state, resolved_at, error_code, created_at,
                                        updated_at)
      SELECT ${tenantId}::uuid, ${id}::uuid, a.customer_id, a.bot_instance_id, a.chat_id,
             CASE WHEN a.bot_instance_id IS NULL THEN 'UNREACHABLE' ELSE 'PENDING' END,
             CASE WHEN a.bot_instance_id IS NULL THEN ${at}::timestamptz END,
             CASE WHEN a.bot_instance_id IS NULL THEN 'broadcast.no_bot_recorded' END,
             ${at}::timestamptz, ${at}::timestamptz
        FROM (${audienceCustomersQuery(evaluation)}) a`);
    const [row] = await this.rows<{ count: number; fingerprint: string }>(
      sql`SELECT count(*)::int AS count, ${fingerprintOf(sql`r.customer_id`)} AS fingerprint
            FROM broadcast_recipients r
           WHERE r.tenant_id = ${tenantId}::uuid AND r.broadcast_id = ${id}::uuid`,
      tx,
    );
    return { count: row?.count ?? 0, fingerprint: row?.fingerprint ?? '' };
  }

  async markLaunched(
    scope: TenantContext,
    id: string,
    input: {
      readonly to: 'SENDING' | 'SCHEDULED';
      readonly scheduledAt: Date | null;
      readonly asOf: Date;
      readonly count: number;
      readonly fingerprint: string;
      readonly launchedByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const at = input.now.toISOString();
    const rows = await this.rows<{ id: string }>(
      sql`UPDATE broadcasts
             SET state = ${input.to}, scheduled_at = ${input.scheduledAt?.toISOString() ?? null}::timestamptz,
                 audience_as_of = ${input.asOf.toISOString()}::timestamptz,
                 recipient_count = ${input.count}, audience_fingerprint = ${input.fingerprint},
                 launched_by_admin_id = ${input.launchedByAdminId}::uuid,
                 launched_at = ${at}::timestamptz,
                 started_at = CASE WHEN ${input.to} = 'SENDING' THEN ${at}::timestamptz END,
                 updated_at = ${at}::timestamptz
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND state = 'DRAFT'
       RETURNING id`,
      tx,
    );
    return rows.length === 1;
  }

  async transition(
    scope: TenantContext,
    id: string,
    from: readonly BroadcastState[],
    to: BroadcastState,
    input: { readonly now: Date; readonly pauseReason?: BroadcastPauseReason },
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const at = sql`${input.now.toISOString()}::timestamptz`;
    const rows = await this.rows<{ id: string }>(
      sql`UPDATE broadcasts
             SET state = ${to},
                 pause_reason = ${to === 'PAUSED' ? (input.pauseReason ?? 'OPERATOR') : null},
                 paused_at = CASE WHEN ${to} = 'PAUSED' THEN ${at} ELSE paused_at END,
                 started_at = CASE WHEN ${to} = 'SENDING' THEN coalesce(started_at, ${at})
                                   ELSE started_at END,
                 completed_at = CASE WHEN ${to} = 'COMPLETED' THEN ${at} END,
                 cancelled_at = CASE WHEN ${to} = 'CANCELLED' THEN ${at} END,
                 updated_at = ${at}
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid
             AND state = ANY(${sql.param([...from])}::text[])
       RETURNING id`,
      tx,
    );
    return rows.length === 1;
  }

  async cancelPending(scope: TenantContext, id: string, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows<{ customer_id: string }>(
      sql`UPDATE broadcast_recipients
             SET state = 'CANCELLED', resolved_at = ${now.toISOString()}::timestamptz,
                 lease_until = NULL, updated_at = ${now.toISOString()}::timestamptz
           WHERE tenant_id = ${tenantId}::uuid AND broadcast_id = ${id}::uuid AND state = 'PENDING'
       RETURNING customer_id`,
      tx,
    );
    return rows.length;
  }

  async requeueFailed(scope: TenantContext, id: string, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows<{ customer_id: string }>(
      sql`UPDATE broadcast_recipients
             SET state = 'PENDING', resolved_at = NULL, attempts = 0, next_attempt_at = NULL,
                 lease_until = NULL, send_started_at = NULL, error_code = NULL,
                 updated_at = ${now.toISOString()}::timestamptz
           WHERE tenant_id = ${tenantId}::uuid AND broadcast_id = ${id}::uuid AND state = 'FAILED'
       RETURNING customer_id`,
      tx,
    );
    return rows.length;
  }

  async counts(scope: TenantContext, ids: readonly string[]) {
    const tenantId = requireTenantId(scope);
    const result = new Map<string, BroadcastCounts>();
    if (ids.length === 0) return result;
    const rows = await this.rows<{ broadcast_id: string; state: string; n: number }>(
      sql`SELECT broadcast_id, state, count(*)::int AS n FROM broadcast_recipients
           WHERE tenant_id = ${tenantId}::uuid
             AND broadcast_id = ANY(${sql.param([...ids])}::uuid[])
           GROUP BY broadcast_id, state`,
    );
    for (const id of ids) result.set(id, { ...EMPTY_COUNTS });
    for (const row of rows) {
      const current = result.get(row.broadcast_id) ?? { ...EMPTY_COUNTS };
      const key = row.state.toLowerCase() as keyof BroadcastCounts;
      result.set(row.broadcast_id, {
        ...current,
        [key]: row.n,
        total: current.total + row.n,
      });
    }
    return result;
  }

  async list(
    scope: TenantContext,
    limit: number,
    cursor: { readonly createdAt: Date; readonly id: string } | null,
  ) {
    const tenantId = requireTenantId(scope);
    const after =
      cursor === null
        ? sql`true`
        : sql`(b.created_at, b.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
    const rows = await this.rows<BroadcastRow>(
      this.selectBroadcast(
        sql`b.tenant_id = ${tenantId}::uuid AND ${after}`,
        sql`ORDER BY b.created_at DESC, b.id DESC LIMIT ${limit}`,
      ),
    );
    return rows.map(toRecord);
  }

  async recipients(
    scope: TenantContext,
    id: string,
    input: {
      readonly state: BroadcastRecipientState | null;
      readonly limit: number;
      readonly after: string | null;
    },
  ): Promise<readonly RecipientPageRow[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows<{
      customer_id: string;
      first_name: string | null;
      username: string | null;
      state: BroadcastRecipientState;
      attempts: number;
      error_code: string | null;
      resolved_at: Date | string | null;
    }>(
      sql`SELECT r.customer_id, c.first_name, c.username, r.state, r.attempts, r.error_code,
                 r.resolved_at
            FROM broadcast_recipients r
            JOIN customers c ON c.tenant_id = r.tenant_id AND c.id = r.customer_id
           WHERE r.tenant_id = ${tenantId}::uuid AND r.broadcast_id = ${id}::uuid
             AND ${input.state === null ? sql`true` : sql`r.state = ${input.state}`}
             AND ${input.after === null ? sql`true` : sql`r.customer_id > ${input.after}::uuid`}
           ORDER BY r.customer_id
           LIMIT ${input.limit}`,
    );
    return rows.map((row) => ({
      customerId: row.customer_id,
      firstName: row.first_name,
      username: row.username,
      state: row.state,
      attempts: row.attempts,
      errorCode: row.error_code,
      resolvedAt: maybeDate(row.resolved_at),
    }));
  }

  async testTargetFor(scope: TenantContext, adminId: string) {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<{
      customer_id: string;
      chat_id: string;
      bot_instance_id: string;
    }>(
      sql`SELECT c.id AS customer_id, c.telegram_user_id AS chat_id,
                 c.first_bot_instance_id AS bot_instance_id
            FROM admins a
            JOIN customers c ON c.tenant_id = a.tenant_id AND c.telegram_user_id = a.telegram_user_id
           WHERE a.tenant_id = ${tenantId}::uuid AND a.id = ${adminId}::uuid
             AND a.telegram_user_id IS NOT NULL AND c.first_bot_instance_id IS NOT NULL`,
    );
    return row === undefined
      ? null
      : { customerId: row.customer_id, chatId: row.chat_id, botInstanceId: row.bot_instance_id };
  }

  // --- the dispatcher's half ----------------------------------------------------------

  async startDue(scope: TenantContext, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const rows = await this.rows<{ id: string }>(
      sql`UPDATE broadcasts SET state = 'SENDING', started_at = coalesce(started_at, ${at}),
                                updated_at = ${at}
           WHERE tenant_id = ${tenantId}::uuid AND state = 'SCHEDULED' AND scheduled_at <= ${at}
       RETURNING id`,
      tx,
    );
    return rows.map((row) => row.id);
  }

  async reapStranded(scope: TenantContext, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    /*
     * At most once: a stamped send whose answer was never recorded MAY have been delivered,
     * so it is resolved UNCONFIRMED and never put back on the queue.
     */
    const rows = await this.rows<{ customer_id: string }>(
      sql`UPDATE broadcast_recipients
             SET state = 'UNCONFIRMED', resolved_at = ${at}, lease_until = NULL,
                 error_code = 'broadcast.send_interrupted', updated_at = ${at}
           WHERE tenant_id = ${tenantId}::uuid AND state = 'SENDING' AND lease_until <= ${at}
       RETURNING customer_id`,
      tx,
    );
    return rows.length;
  }

  async botsWithWork(scope: TenantContext, now: Date) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    /*
     * The tenant's bots (a handful of rows), each asked whether ONE due recipient exists — an
     * EXISTS that stops at the first row `broadcast_recipients_due_idx` yields, rather than a
     * DISTINCT over every waiting recipient every second.
     */
    const rows = await this.rows<{ id: string }>(
      sql`SELECT bi.id FROM bot_instances bi
           WHERE bi.tenant_id = ${tenantId}::uuid
             AND EXISTS (
               SELECT 1 FROM broadcast_recipients r
                 JOIN broadcasts b ON b.tenant_id = r.tenant_id AND b.id = r.broadcast_id
                WHERE r.tenant_id = bi.tenant_id AND r.bot_instance_id = bi.id
                  AND r.state = 'PENDING' AND b.state = 'SENDING'
                  AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ${at})
                  AND (r.lease_until IS NULL OR r.lease_until <= ${at}))`,
    );
    return rows.map((row) => row.id);
  }

  async claimForBot(
    scope: TenantContext,
    botInstanceId: string,
    input: {
      readonly now: Date;
      readonly leaseUntil: Date;
      readonly max: number;
      readonly perSecond: number;
    },
    scopeTx: TransactionScope,
  ): Promise<readonly ClaimedRecipient[]> {
    const tenantId = requireTenantId(scope);
    const at = sql`${input.now.toISOString()}::timestamptz`;
    const tx = scopeTx.tx;
    {
      /*
       * The pacing row FIRST, under its lock: every worker replica that wants this bot's
       * budget queues here, so two replicas share one budget rather than each spending it.
       */
      await tx.execute(sql`
        INSERT INTO broadcast_bot_pacing (tenant_id, bot_instance_id, window_started_at,
                                          sent_in_window, updated_at)
        VALUES (${tenantId}::uuid, ${botInstanceId}::uuid, ${at}, 0, ${at})
        ON CONFLICT DO NOTHING`);
      const pacing = await tx.execute<{
        window_started_at: Date | string;
        sent_in_window: number;
        hold_until: Date | string | null;
      }>(sql`
        SELECT window_started_at, sent_in_window, hold_until FROM broadcast_bot_pacing
         WHERE tenant_id = ${tenantId}::uuid AND bot_instance_id = ${botInstanceId}::uuid
         FOR UPDATE`);
      const row = pacing.rows[0];
      if (row === undefined) return [];
      if (row.hold_until !== null && date(row.hold_until).getTime() > input.now.getTime()) {
        return [];
      }
      const fresh = date(row.window_started_at).getTime() <= input.now.getTime() - 1000;
      const used = fresh ? 0 : row.sent_in_window;
      const take = Math.min(input.max, input.perSecond - used);
      if (take <= 0) return [];
      const claimed = await tx.execute<{
        broadcast_id: string;
        customer_id: string;
        bot_instance_id: string;
        chat_id: string;
        attempts: number;
      }>(sql`
        UPDATE broadcast_recipients r
           SET lease_until = ${input.leaseUntil.toISOString()}::timestamptz, updated_at = ${at}
          FROM (
            SELECT r2.tenant_id, r2.broadcast_id, r2.customer_id
              FROM broadcast_recipients r2
              JOIN broadcasts b ON b.tenant_id = r2.tenant_id AND b.id = r2.broadcast_id
             WHERE r2.tenant_id = ${tenantId}::uuid AND r2.bot_instance_id = ${botInstanceId}::uuid
               AND r2.state = 'PENDING' AND b.state = 'SENDING'
               AND (r2.next_attempt_at IS NULL OR r2.next_attempt_at <= ${at})
               AND (r2.lease_until IS NULL OR r2.lease_until <= ${at})
             ORDER BY r2.broadcast_id, r2.customer_id
             LIMIT ${take}
             FOR UPDATE OF r2 SKIP LOCKED
          ) due
         WHERE r.tenant_id = due.tenant_id AND r.broadcast_id = due.broadcast_id
           AND r.customer_id = due.customer_id
     RETURNING r.broadcast_id, r.customer_id, r.bot_instance_id, r.chat_id, r.attempts`);
      await tx.execute(sql`
        UPDATE broadcast_bot_pacing
           SET window_started_at = CASE WHEN ${fresh} THEN ${at} ELSE window_started_at END,
               sent_in_window = ${used + claimed.rows.length}, updated_at = ${at}
         WHERE tenant_id = ${tenantId}::uuid AND bot_instance_id = ${botInstanceId}::uuid`);
      return claimed.rows.map((recipient) => ({
        broadcastId: recipient.broadcast_id,
        customerId: recipient.customer_id,
        botInstanceId: recipient.bot_instance_id,
        chatId: recipient.chat_id,
        attempts: recipient.attempts,
        leaseUntil: input.leaseUntil,
      }));
    }
  }

  async content(scope: TenantContext, id: string): Promise<BroadcastContent | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<{
      id: string;
      state: BroadcastState;
      content_kind: BroadcastContentKind;
      body: string;
      buttons: BroadcastButton[];
      customer_status: string | null;
    }>(
      sql`SELECT id, state, content_kind, body, buttons,
                 audience_definition ->> 'customerStatus' AS customer_status
            FROM broadcasts WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`,
    );
    if (row === undefined) return null;
    return {
      id: row.id,
      state: row.state,
      contentKind: row.content_kind,
      body: row.body,
      buttons: row.buttons,
      requiresActiveCustomer: row.customer_status === 'ACTIVE',
    };
  }

  async customerStatus(scope: TenantContext, customerId: string) {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<{ status: string }>(
      sql`SELECT status FROM customers WHERE tenant_id = ${tenantId}::uuid AND id = ${customerId}::uuid`,
    );
    return row?.status ?? null;
  }

  private recipientKey(tenantId: string, recipient: ClaimedRecipient): SQL {
    return sql`tenant_id = ${tenantId}::uuid AND broadcast_id = ${recipient.broadcastId}::uuid
               AND customer_id = ${recipient.customerId}::uuid`;
  }

  async skip(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    errorCode: string,
    now: Date,
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const rows = await this.rows<{ customer_id: string }>(
      sql`UPDATE broadcast_recipients
             SET state = 'SKIPPED', resolved_at = ${at}, lease_until = NULL,
                 error_code = ${errorCode}, updated_at = ${at}
           WHERE ${this.recipientKey(tenantId, recipient)} AND state = 'PENDING'
       RETURNING customer_id`,
      tx,
    );
    return rows.length === 1;
  }

  async stamp(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    input: { readonly now: Date; readonly leaseUntil: Date },
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const at = sql`${input.now.toISOString()}::timestamptz`;
    /*
     * Only the lease THIS pass took, only while still PENDING, and only while the broadcast
     * is SENDING — so a pause or a cancel that committed after the claim stops the send
     * here, and a second worker that took the row after a lapsed lease cannot also send it.
     */
    const rows = await this.rows<{ customer_id: string }>(
      sql`UPDATE broadcast_recipients r
             SET state = 'SENDING', send_started_at = ${at},
                 lease_until = ${input.leaseUntil.toISOString()}::timestamptz, updated_at = ${at}
           WHERE r.tenant_id = ${tenantId}::uuid AND r.broadcast_id = ${recipient.broadcastId}::uuid
             AND r.customer_id = ${recipient.customerId}::uuid AND r.state = 'PENDING'
             AND r.lease_until = ${recipient.leaseUntil.toISOString()}::timestamptz
             AND EXISTS (SELECT 1 FROM broadcasts b
                          WHERE b.tenant_id = r.tenant_id AND b.id = r.broadcast_id
                            AND b.state = 'SENDING')
       RETURNING r.customer_id`,
      tx,
    );
    return rows.length === 1;
  }

  async record(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    stampedAt: Date,
    outcome: RecipientOutcome,
    now: Date,
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const mine = sql`${this.recipientKey(tenantId, recipient)} AND state = 'SENDING'
                     AND send_started_at = ${stampedAt.toISOString()}::timestamptz`;
    let update: SQL;
    switch (outcome.to) {
      case 'SENT':
        update = sql`state = 'SENT', resolved_at = ${at}, lease_until = NULL, error_code = NULL,
                     attempts = attempts + 1`;
        break;
      case 'UNCONFIRMED':
      case 'UNREACHABLE':
      case 'FAILED':
        update = sql`state = ${outcome.to}, resolved_at = ${at}, lease_until = NULL,
                     error_code = ${outcome.errorCode}, attempts = attempts + 1`;
        break;
      case 'RETRY':
        // A definite refusal that may pass: an attempt spent, back on the queue.
        update = sql`state = 'PENDING', send_started_at = NULL, lease_until = NULL,
                     error_code = ${outcome.errorCode}, attempts = attempts + 1,
                     next_attempt_at = ${outcome.nextAttemptAt.toISOString()}::timestamptz`;
        break;
      case 'DEFER':
        // Telegram declined (429): nothing was sent and no attempt is spent.
        update = sql`state = 'PENDING', send_started_at = NULL, lease_until = NULL,
                     error_code = ${outcome.errorCode},
                     next_attempt_at = ${outcome.nextAttemptAt.toISOString()}::timestamptz`;
        break;
    }
    const rows = await this.rows<{ customer_id: string }>(
      sql`UPDATE broadcast_recipients SET ${update}, updated_at = ${at}
           WHERE ${mine} RETURNING customer_id`,
      tx,
    );
    return rows.length === 1;
  }

  async holdBot(
    scope: TenantContext,
    botInstanceId: string,
    until: Date,
    now: Date,
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(sql`
      UPDATE broadcast_bot_pacing
         SET hold_until = GREATEST(coalesce(hold_until, ${until.toISOString()}::timestamptz),
                                   ${until.toISOString()}::timestamptz),
             updated_at = ${now.toISOString()}::timestamptz
       WHERE tenant_id = ${tenantId}::uuid AND bot_instance_id = ${botInstanceId}::uuid`);
  }

  async completeFinished(scope: TenantContext, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const rows = await this.rows<{ id: string; recipient_count: number | null }>(
      sql`UPDATE broadcasts b SET state = 'COMPLETED', completed_at = ${at}, updated_at = ${at}
           WHERE b.tenant_id = ${tenantId}::uuid AND b.state = 'SENDING'
             AND NOT EXISTS (SELECT 1 FROM broadcast_recipients r
                              WHERE r.tenant_id = b.tenant_id AND r.broadcast_id = b.id
                                AND r.state IN ('PENDING', 'SENDING'))
       RETURNING b.id, b.recipient_count`,
      tx,
    );
    return rows.map((row) => ({ id: row.id, count: row.recipient_count }));
  }

  async purgeMedia(
    scope: TenantContext,
    input: { readonly terminalBefore: Date; readonly draftBefore: Date; readonly now: Date },
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows<{ broadcast_id: string }>(
      sql`UPDATE broadcast_media m
             SET content = NULL, purged_at = ${input.now.toISOString()}::timestamptz
            FROM broadcasts b
           WHERE m.tenant_id = ${tenantId}::uuid AND m.content IS NOT NULL
             AND b.tenant_id = m.tenant_id AND b.id = m.broadcast_id
             AND ((b.state = 'COMPLETED'
                   AND b.completed_at < ${input.terminalBefore.toISOString()}::timestamptz)
               OR (b.state = 'CANCELLED'
                   AND b.cancelled_at < ${input.terminalBefore.toISOString()}::timestamptz)
               OR (b.state = 'DRAFT'
                   AND b.updated_at < ${input.draftBefore.toISOString()}::timestamptz))
       RETURNING m.broadcast_id`,
      tx,
    );
    return rows.length;
  }
}
