import { createHash } from 'node:crypto';
import {
  TICKET_MESSAGE_MAX_LENGTH,
  TICKET_SUBJECT_MAX_LENGTH,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  GapTally,
  MATERIALIZE_PAGE,
  assertScopeActive,
  at,
  bounded,
  customerOf,
  mirzaInstant,
  text,
  type HistoryRecord,
  type MaterializeDeps,
} from './materialize-support.js';
import type {
  ExactMatchRow,
  MaterializeContext,
  MaterializeStep,
  MaterializeStepOutcome,
} from './ports.js';

/**
 * Mirza support history into `tickets` and `ticket_messages` (plan §3, §5-2).
 *
 * Every imported ticket is CLOSED, at the time of its last message, whatever Mirza's own
 * status was: history is not re-opened (the converter's rule, `OPEN` items "never
 * re-opened"), so no operator inbox, SLA timer, escalation or auto-close ever sees one. Mirza's
 * own status stays in the archive record. Nothing is announced: a ticket and its messages are
 * written by repository, with no outbox event and no customer notification.
 *
 * Two shapes come from the package:
 * - `support_message` (the documented table): one row per message holding the customer's
 *   text and, when answered, the admin's answer. Rows have no parent, so a thread is the
 *   converter's inferred group (customer + department, `thread_ref`). A row becomes a
 *   CUSTOMER message and, if it carries an answer, an ADMIN message right after it.
 * - the fork's `ticket` / `ticket_message` (no public DDL): a message is carried only when the
 *   sender and the text can be read from columns named like `sender` / `message`; otherwise it
 *   is counted as `TICKET_MESSAGE_SHAPE_UNPROVEN` and stays in the archive.
 *
 * An ADMIN message needs an author (`ticket_messages_shape_check`), so the answers are signed
 * by one system admin, `mirza-import`: DISABLED, with a password hash nothing can verify and
 * no role — it cannot sign in and holds no permission. It is created only when an answer is
 * written.
 */

export const TICKET_HISTORY_STEP = 'ticket-history';
export const SUPPORT_THREAD_REF_PREFIX = 'support-thread';
export const SUPPORT_MESSAGE_REF_PREFIX = 'support-msg';
export const ANSWER_REF_SUFFIX = ':answer';
export const FORK_TICKET_REF_PREFIX = 'ticket';
export const FORK_MESSAGE_REF_PREFIX = 'ticket-msg';
export const MIRZA_IMPORT_ADMIN_USERNAME = 'mirza-import';
/**
 * The imported tickets' category, as the ticket pages show it. Neutral wording (owner rule
 * 2026-10-18: no previous-bot name outside the one-time import page).
 */
export const MIRZA_TICKET_CATEGORY_TITLE = 'منتقل‌شده از ربات قبلی';
/**
 * The title an earlier release wrote. A resumed or re-run import on a database that already
 * holds it reuses that row, never a second category beside it.
 */
export const LEGACY_MIRZA_TICKET_CATEGORY_TITLE = 'Mirza (imported)';
/** The import's disabled system identity, as an author name in ticket history. */
export const MIRZA_IMPORT_ADMIN_DISPLAY_NAME = 'انتقال از ربات قبلی (سیستم)';

const THREAD_REF_PREFIX = 'legacy:support:thread:';

export interface TicketMessageWrite {
  readonly sourceRef: string;
  readonly sender: 'CUSTOMER' | 'ADMIN';
  readonly body: string;
  readonly at: Date;
}

export interface TicketWrite {
  readonly sourceRef: string;
  readonly customerId: string;
  readonly subject: string | null;
  readonly createdAt: Date;
  readonly closedAt: Date;
  readonly messages: readonly TicketMessageWrite[];
}

export const bodyDigest = (body: string): string => createHash('sha256').update(body).digest('hex');

export function ticketFingerprint(t: {
  readonly customerId: string;
  readonly subject: string | null;
  readonly createdAt: Date;
  readonly closedAt: Date;
}): string {
  return [t.customerId, t.subject ?? '-', t.createdAt.toISOString(), t.closedAt.toISOString()].join(
    '|',
  );
}

export function messageFingerprint(m: {
  readonly sender: string;
  readonly at: Date;
  readonly bodyDigest: string;
}): string {
  return [m.sender, m.at.toISOString(), m.bodyDigest].join('|');
}

/** What a thread became, and the counts the exact-match report needs even for a gap. */
export interface ThreadPlan {
  readonly write: TicketWrite | null;
  readonly gapReason: string | null;
  /** Mirza message rows of the thread. */
  readonly messageRows: number;
  /** Rows of the thread that carry an answer (support_message only). */
  readonly answerRows: number;
  /** Rows inside a carried thread that contributed no message, by reason. */
  readonly rowGaps: Readonly<Record<string, number>>;
  /** The same for the answer part of the rows (support_message only). */
  readonly answerGaps?: Readonly<Record<string, number>>;
  /** Set only on the one pseudo-plan for fork messages whose ticket is not in the package. */
  readonly orphanMessagesOnly?: boolean;
}

/** A body the CHECK accepts: bounded to its length, in code points. */
const body = (value: unknown): string | null => bounded(value, TICKET_MESSAGE_MAX_LENGTH);

/** Mirza's answer column is `0` when nobody has answered. */
function answerOf(value: unknown): string | null {
  const t = text(value);
  return t === null || t.trim() === '0' || t.trim() === '' ? null : body(t);
}

/** Message times: the row's own, else the previous message's, so the order is never broken. */
function sequenceTimes(times: readonly (Date | null)[]): (Date | null)[] {
  const firstKnown = times.find((t): t is Date => t !== null) ?? null;
  let previous: Date | null = firstKnown;
  return times.map((t) => {
    if (t !== null) previous = t;
    return previous;
  });
}

export function threadSourceRef(threadRef: string): string | null {
  if (!threadRef.startsWith(THREAD_REF_PREFIX)) return null;
  const hash = threadRef.slice(THREAD_REF_PREFIX.length);
  return /^[0-9a-f]{8,64}$/.test(hash) ? `${SUPPORT_THREAD_REF_PREFIX}:${hash}` : null;
}

/** One `support_message` thread, records in the converter's `seq` order. */
export function planSupportThread(
  threadRef: string,
  records: readonly HistoryRecord[],
  customers: ReadonlyMap<string, string>,
): ThreadPlan {
  const sourceRef = threadSourceRef(threadRef);
  const customerId =
    records.length === 0 ? null : customerOf(records[0] as HistoryRecord, customers);
  const answerRows = records.filter((r) => answerOf(r.payload['admin_answer']) !== null).length;
  const base = { messageRows: records.length, answerRows };
  const gap = (reason: string): ThreadPlan => ({
    write: null,
    gapReason: reason,
    rowGaps: {},
    ...base,
  });
  if (sourceRef === null) return gap('SOURCE_ID_UNUSABLE');
  if (customerId === null) return gap('CUSTOMER_NOT_IMPORTED');

  const times = sequenceTimes(records.map((r) => mirzaInstant(r.payload['sent_at'])));
  if (times.every((t) => t === null)) return gap('UNPARSEABLE_TIME');
  const messages: TicketMessageWrite[] = [];
  const rowGaps: Record<string, number> = {};
  const answerGaps: Record<string, number> = {};
  const bump = (into: Record<string, number>, reason: string): void => {
    into[reason] = (into[reason] ?? 0) + 1;
  };
  records.forEach((record, i) => {
    const pk = pkOf(record);
    const when = times[i] ?? null;
    const question = body(record.payload['customer_text']);
    const answer = answerOf(record.payload['admin_answer']);
    if (
      pk === null ||
      `${SUPPORT_MESSAGE_REF_PREFIX}:${pk}${ANSWER_REF_SUFFIX}`.length > 128 ||
      when === null
    ) {
      bump(rowGaps, 'SOURCE_ID_UNUSABLE');
      if (answer !== null) bump(answerGaps, 'SOURCE_ID_UNUSABLE');
      return;
    }
    const ref = `${SUPPORT_MESSAGE_REF_PREFIX}:${pk}`;
    if (question === null) bump(rowGaps, 'NO_CUSTOMER_TEXT');
    else messages.push({ sourceRef: ref, sender: 'CUSTOMER', body: question, at: when });
    if (answer !== null) {
      messages.push({
        sourceRef: `${ref}${ANSWER_REF_SUFFIX}`,
        sender: 'ADMIN',
        body: answer,
        at: when,
      });
    }
  });
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (first === undefined || last === undefined) return gap('NO_MESSAGE_TEXT');
  return {
    write: {
      sourceRef,
      customerId,
      subject: bounded(records[0]?.payload['department_name'], TICKET_SUBJECT_MAX_LENGTH),
      createdAt: first.at,
      closedAt: last.at,
      messages,
    },
    gapReason: null,
    rowGaps,
    answerGaps,
    ...base,
  };
}

// --- the fork's ticket / ticket_message --------------------------------------------------

const SENDER_COLUMNS = ['sender', 'from', 'role', 'author', 'by', 'type'] as const;
const BODY_COLUMNS = ['message', 'text', 'body', 'content', 'msg'] as const;
const SUBJECT_COLUMNS = ['subject', 'title', 'topic'] as const;
const CUSTOMER_SENDERS = new Set(['user', 'customer', 'client', 'member']);
const ADMIN_SENDERS = new Set(['admin', 'support', 'staff', 'agent', 'operator']);

function column(fields: unknown, names: readonly string[]): unknown {
  if (fields === null || typeof fields !== 'object') return undefined;
  const map = fields as Record<string, unknown>;
  const key = names.find((name) => Object.hasOwn(map, name));
  return key === undefined ? undefined : map[key];
}

/** The fork message as `{sender, body}`, or null when either cannot be read from its columns. */
export function readForkMessage(
  record: HistoryRecord,
): { readonly sender: 'CUSTOMER' | 'ADMIN'; readonly body: string } | null {
  const fields = record.payload['fields_raw'];
  const sender = text(column(fields, SENDER_COLUMNS))?.trim().toLowerCase() ?? null;
  const content = body(column(fields, BODY_COLUMNS));
  if (sender === null || content === null) return null;
  if (CUSTOMER_SENDERS.has(sender)) return { sender: 'CUSTOMER', body: content };
  if (ADMIN_SENDERS.has(sender)) return { sender: 'ADMIN', body: content };
  return null;
}

/** The Mirza primary key of a support / engagement record: top level, else provenance. */
export function pkOf(record: HistoryRecord): string | null {
  const direct = record.payload['source_pk'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (typeof direct === 'number') return String(direct);
  return text(at(record.payload, 'provenance', 'source_pk'));
}

export function forkTicketKey(record: HistoryRecord): string | null {
  return pkOf(record);
}

export function forkMessageTicketKey(record: HistoryRecord): string | null {
  return text(at(record.payload, 'ticket_ref', 'raw'));
}

export function planForkTicket(
  ticket: HistoryRecord,
  messages: readonly HistoryRecord[],
  customers: ReadonlyMap<string, string>,
): ThreadPlan {
  const pk = forkTicketKey(ticket);
  const customerId = customerOf(ticket, customers);
  const base = { messageRows: messages.length, answerRows: 0 };
  const gap = (reason: string): ThreadPlan => ({
    write: null,
    gapReason: reason,
    rowGaps: {},
    ...base,
  });
  if (pk === null || `${FORK_TICKET_REF_PREFIX}:${pk}`.length > 128)
    return gap('SOURCE_ID_UNUSABLE');
  if (customerId === null) return gap('CUSTOMER_NOT_IMPORTED');
  const times = sequenceTimes(messages.map((m) => mirzaInstant(m.payload['sent_at'])));
  const written: TicketMessageWrite[] = [];
  const rowGaps: Record<string, number> = {};
  const skip = (reason: string): void => {
    rowGaps[reason] = (rowGaps[reason] ?? 0) + 1;
  };
  messages.forEach((m, i) => {
    const mpk = pkOf(m);
    const read = readForkMessage(m);
    const when = times[i] ?? null;
    if (mpk === null || `${FORK_MESSAGE_REF_PREFIX}:${mpk}`.length > 128)
      return skip('SOURCE_ID_UNUSABLE');
    if (read === null) return skip('TICKET_MESSAGE_SHAPE_UNPROVEN');
    if (when === null) return skip('UNPARSEABLE_TIME');
    written.push({ sourceRef: `${FORK_MESSAGE_REF_PREFIX}:${mpk}`, ...read, at: when });
  });
  const created =
    mirzaInstant(at(ticket.payload, 'fields_raw', 'created_at')) ?? written[0]?.at ?? null;
  const last = written[written.length - 1];
  if (created === null) return gap('UNPARSEABLE_TIME');
  const closedAt = last === undefined || last.at < created ? created : last.at;
  return {
    write: {
      sourceRef: `${FORK_TICKET_REF_PREFIX}:${pk}`,
      customerId,
      subject: bounded(
        column(ticket.payload['fields_raw'], SUBJECT_COLUMNS),
        TICKET_SUBJECT_MAX_LENGTH,
      ),
      createdAt: created,
      closedAt,
      messages: written,
    },
    gapReason: null,
    rowGaps,
    ...base,
  };
}

// --- the repository and the step --------------------------------------------------------

export interface TicketHistoryRepository {
  /** The tenant's bot to attribute tickets to: an ACTIVE one first, else the oldest. */
  resolveBot(scope: TenantContext, tx?: TransactionScope): Promise<string | null>;
  /** The inactive category imported tickets are filed under; created once. */
  ensureCategory(
    scope: TenantContext,
    now: Date,
    tx: TransactionScope,
  ): Promise<{ readonly id: string; readonly title: string }>;
  /** The system admin that signs imported answers; created once, never able to sign in. */
  ensureImportAdmin(scope: TenantContext, now: Date, tx: TransactionScope): Promise<string>;
  existingTickets(
    scope: TenantContext,
    sourceRefs: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, { readonly id: string; readonly fingerprint: string }>>;
  existingMessages(
    scope: TenantContext,
    sourceRefs: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;
  /** Inserts the ticket and its messages in order; false when the ticket's ref is taken. */
  insertThread(
    scope: TenantContext,
    thread: TicketWrite,
    context: {
      readonly botInstanceId: string;
      readonly category: { readonly id: string; readonly title: string };
      readonly adminId: string | null;
    },
    tx: TransactionScope,
  ): Promise<boolean>;
  /** Tickets / messages / answers of source MIRZA, by `source_ref` prefix. */
  countTickets(scope: TenantContext, prefix: string): Promise<number>;
  countMessages(
    scope: TenantContext,
    prefix: string,
    part: 'PRIMARY' | 'ANSWER' | 'ALL',
  ): Promise<number>;
}

const BATCH_THREADS = 50;

interface IndexEntry {
  readonly id: string;
  readonly group: string | null;
  readonly seq: number;
}

export class TicketHistoryStep implements MaterializeStep {
  readonly name = TICKET_HISTORY_STEP;

  constructor(
    private readonly deps: MaterializeDeps,
    private readonly repository: TicketHistoryRepository,
  ) {}

  /** (id, group, seq) of every record of a type: the only thing held for the whole table. */
  private async index(
    ctx: MaterializeContext,
    recordType: string,
    group: (record: HistoryRecord) => string | null,
  ): Promise<IndexEntry[]> {
    const out: IndexEntry[] = [];
    let after: string | null = null;
    for (;;) {
      const page: readonly HistoryRecord[] = await this.deps.records.page(
        ctx.scope,
        ctx.packageImportId,
        recordType,
        after,
        MATERIALIZE_PAGE,
      );
      for (const record of page) {
        const seq = Number(record.payload['seq']);
        out.push({
          id: record.id,
          group: group(record),
          seq: Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER,
        });
      }
      if (page.length < MATERIALIZE_PAGE) break;
      after = (page[page.length - 1] as HistoryRecord).id;
    }
    return out.sort(
      (a, b) =>
        (a.group ?? '').localeCompare(b.group ?? '') || a.seq - b.seq || a.id.localeCompare(b.id),
    );
  }

  private groups(entries: readonly IndexEntry[]): Map<string | null, string[]> {
    const map = new Map<string | null, string[]>();
    for (const entry of entries) {
      const ids = map.get(entry.group) ?? [];
      ids.push(entry.id);
      map.set(entry.group, ids);
    }
    return map;
  }

  /** Every thread, in batches, with its plan. `tx` is set when applying. */
  private async *threads(ctx: MaterializeContext): AsyncGenerator<
    readonly {
      readonly kind: 'SUPPORT' | 'FORK';
      readonly plan: ThreadPlan;
    }[]
  > {
    const scope = ctx.scope;
    // Support threads.
    const support = this.groups(
      await this.index(ctx, 'support_message', (r) => text(r.payload['thread_ref'])),
    );
    const supportKeys = [...support.keys()];
    for (let i = 0; i < supportKeys.length; i += BATCH_THREADS) {
      const keys = supportKeys.slice(i, i + BATCH_THREADS);
      const records = await this.deps.records.byIds(
        scope,
        ctx.packageImportId,
        keys.flatMap((k) => support.get(k) ?? []),
      );
      const byId = new Map(records.map((r) => [r.id, r]));
      const customers = await this.deps.records.customersByLegacyUser(
        scope,
        records.flatMap((r) => (r.legacyUserId === null ? [] : [r.legacyUserId])),
      );
      yield keys.map((key) => ({
        kind: 'SUPPORT' as const,
        plan: planSupportThread(
          key ?? '',
          (support.get(key) ?? []).flatMap((id) => {
            const r = byId.get(id);
            return r === undefined ? [] : [r];
          }),
          customers,
        ),
      }));
    }
    // The fork's tickets and their messages.
    const messageGroups = this.groups(
      await this.index(ctx, 'ticket_message', (r) => forkMessageTicketKey(r)),
    );
    const tickets = await this.index(ctx, 'ticket', () => null);
    const seenTicketKeys = new Set<string>();
    for (let i = 0; i < tickets.length; i += BATCH_THREADS) {
      const batch = tickets.slice(i, i + BATCH_THREADS);
      const ticketRecords = await this.deps.records.byIds(
        scope,
        ctx.packageImportId,
        batch.map((t) => t.id),
      );
      const keyed = ticketRecords.map((r) => ({ record: r, key: forkTicketKey(r) }));
      for (const { key } of keyed) if (key !== null) seenTicketKeys.add(key);
      const messageIds = keyed.flatMap(({ key }) =>
        key === null ? [] : (messageGroups.get(key) ?? []),
      );
      const messages = await this.deps.records.byIds(scope, ctx.packageImportId, messageIds);
      const msgById = new Map(messages.map((m) => [m.id, m]));
      const customers = await this.deps.records.customersByLegacyUser(
        scope,
        ticketRecords.flatMap((r) => (r.legacyUserId === null ? [] : [r.legacyUserId])),
      );
      yield keyed.map(({ record, key }) => ({
        kind: 'FORK' as const,
        plan: planForkTicket(
          record,
          (key === null ? [] : (messageGroups.get(key) ?? [])).flatMap((id) => {
            const m = msgById.get(id);
            return m === undefined ? [] : [m];
          }),
          customers,
        ),
      }));
    }
    // Messages whose ticket is not in the package at all.
    const orphans = [...messageGroups]
      .filter(([key]) => key === null || !seenTicketKeys.has(key))
      .reduce((n, [, ids]) => n + ids.length, 0);
    if (orphans > 0) {
      yield [
        {
          kind: 'FORK' as const,
          plan: {
            write: null,
            gapReason: 'TICKET_NOT_IN_PACKAGE',
            messageRows: orphans,
            answerRows: 0,
            rowGaps: {},
            orphanMessagesOnly: true,
          },
        },
      ];
    }
  }

  async apply(ctx: MaterializeContext): Promise<MaterializeStepOutcome> {
    const skipped = new GapTally();
    let written = 0;
    let alreadyPresent = 0;
    let diverged = 0;
    const bot = await this.repository.resolveBot(ctx.scope);
    for await (const batch of this.threads(ctx)) {
      await this.deps.uow.run(ctx.scope, async (tx) => {
        await assertScopeActive(this.deps, ctx, tx);
        const carried = batch.filter((t) => t.plan.write !== null);
        for (const t of batch) {
          if (t.plan.write === null && !isOrphanOnly(t.plan)) {
            skipped.add(t.plan.gapReason ?? 'UNKNOWN', null);
          } else if (isOrphanOnly(t.plan)) {
            skipped.addRows('TICKET_NOT_IN_PACKAGE', t.plan.messageRows);
          }
          for (const [reason, n] of Object.entries(t.plan.rowGaps)) skipped.addRows(reason, n);
          for (const [reason, n] of Object.entries(t.plan.answerGaps ?? {})) {
            skipped.addRows(`ANSWER_${reason}`, n);
          }
        }
        if (carried.length === 0) return;
        if (bot === null) {
          // No bot to attribute a ticket to: nothing is written and the reason is counted,
          // so a rerun after the bot exists writes them.
          skipped.addRows('NO_BOT_INSTANCE', carried.length);
          return;
        }
        const writes = carried.map((t) => t.plan.write as TicketWrite);
        const existing = await this.repository.existingTickets(
          ctx.scope,
          writes.map((w) => w.sourceRef),
          tx,
        );
        const fresh = writes.filter((w) => !existing.has(w.sourceRef));
        const category =
          fresh.length > 0 ? await this.repository.ensureCategory(ctx.scope, ctx.now, tx) : null;
        const needsAdmin = fresh.some((w) => w.messages.some((m) => m.sender === 'ADMIN'));
        const adminId = needsAdmin
          ? await this.repository.ensureImportAdmin(ctx.scope, ctx.now, tx)
          : null;
        for (const w of writes) {
          const stored = existing.get(w.sourceRef);
          if (stored !== undefined) {
            const same = stored.fingerprint === ticketFingerprint(w);
            const storedMessages = await this.repository.existingMessages(
              ctx.scope,
              w.messages.map((m) => m.sourceRef),
              tx,
            );
            if (same) alreadyPresent += 1;
            else diverged += 1;
            for (const m of w.messages) {
              const fp = storedMessages.get(m.sourceRef);
              if (
                fp ===
                messageFingerprint({ sender: m.sender, at: m.at, bodyDigest: bodyDigest(m.body) })
              ) {
                alreadyPresent += 1;
              } else diverged += 1;
            }
            continue;
          }
          const inserted = await this.repository.insertThread(
            ctx.scope,
            w,
            { botInstanceId: bot, category: category as { id: string; title: string }, adminId },
            tx,
          );
          if (inserted) written += 1 + w.messages.length;
          else diverged += 1;
        }
      });
    }
    return {
      step: TICKET_HISTORY_STEP,
      written,
      alreadyPresent,
      diverged,
      skipped: skipped.asRecord(),
    };
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    const bot = await this.repository.resolveBot(ctx.scope);
    const t = {
      support: tally(),
      supportMsg: tally(),
      supportAns: tally(),
      fork: tally(),
      forkMsg: tally(),
    };
    for await (const batch of this.threads(ctx)) {
      for (const { kind, plan } of batch) {
        const orphan = isOrphanOnly(plan);
        const carried = plan.write !== null && bot !== null;
        const reason = plan.write === null ? (plan.gapReason ?? 'UNKNOWN') : 'NO_BOT_INSTANCE';
        if (kind === 'SUPPORT') {
          t.support.rows += 1;
          t.supportMsg.rows += plan.messageRows;
          t.supportAns.rows += plan.answerRows;
          if (!carried) {
            t.support.gaps.add(reason, null);
            t.supportMsg.gaps.addRows(reason, plan.messageRows);
            t.supportAns.gaps.addRows(reason, plan.answerRows);
          } else {
            for (const [r, n] of Object.entries(plan.rowGaps)) t.supportMsg.gaps.addRows(r, n);
            for (const [r, n] of Object.entries(plan.answerGaps ?? {}))
              t.supportAns.gaps.addRows(r, n);
          }
        } else if (orphan) {
          t.forkMsg.rows += plan.messageRows;
          t.forkMsg.gaps.addRows('TICKET_NOT_IN_PACKAGE', plan.messageRows);
        } else {
          t.fork.rows += 1;
          t.forkMsg.rows += plan.messageRows;
          if (!carried) {
            t.fork.gaps.add(reason, null);
            t.forkMsg.gaps.addRows(
              reason === 'NO_BOT_INSTANCE' ? reason : 'TICKET_NOT_CARRIED',
              plan.messageRows,
            );
          } else {
            for (const [r, n] of Object.entries(plan.rowGaps)) t.forkMsg.gaps.addRows(r, n);
          }
        }
      }
    }
    const scope = ctx.scope;
    const row = (
      mirzaTable: string,
      nexaTable: string,
      x: { rows: number; gaps: GapTally },
      nexaRows: number,
    ): ExactMatchRow => ({
      mirzaTable,
      nexaTable,
      mirzaRows: x.rows,
      nexaRows,
      mirzaSumMinor: null,
      nexaSumMinor: null,
      explained: x.gaps.explained(),
    });
    return [
      row(
        'support_message (threads)',
        'tickets',
        t.support,
        await this.repository.countTickets(scope, `${SUPPORT_THREAD_REF_PREFIX}:`),
      ),
      row(
        'support_message (customer text)',
        'ticket_messages',
        t.supportMsg,
        await this.repository.countMessages(scope, `${SUPPORT_MESSAGE_REF_PREFIX}:`, 'PRIMARY'),
      ),
      row(
        'support_message (admin answer)',
        'ticket_messages',
        t.supportAns,
        await this.repository.countMessages(scope, `${SUPPORT_MESSAGE_REF_PREFIX}:`, 'ANSWER'),
      ),
      row(
        'ticket',
        'tickets',
        t.fork,
        await this.repository.countTickets(scope, `${FORK_TICKET_REF_PREFIX}:`),
      ),
      row(
        'ticket_message',
        'ticket_messages',
        t.forkMsg,
        await this.repository.countMessages(scope, `${FORK_MESSAGE_REF_PREFIX}:`, 'ALL'),
      ),
    ];
  }
}

function tally(): { rows: number; gaps: GapTally } {
  return { rows: 0, gaps: new GapTally() };
}

function isOrphanOnly(plan: ThreadPlan): boolean {
  return plan.orphanMessagesOnly === true;
}
