import {
  COMMERCE_ERROR_CODES,
  CUSTOMER_NOTE_PAGE_DEFAULT,
  CUSTOMER_NOTE_PAGE_MAX,
  CUSTOMER_TAGS_PER_TENANT_MAX,
  customerNoteBodySchema,
  customerTagLabelSchema,
  errors,
  userIdSchema,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CustomerTagColor,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import { CUSTOMER_VIEW_PERMISSION } from './customer.service.js';
import type { CustomerRepository } from './ports.js';
import type {
  CustomerAssignedTagRecord,
  CustomerCrmRepository,
  CustomerNoteCursor,
  CustomerNotePage,
  CustomerNoteRecord,
  CustomerTagRecord,
} from './customer-crm-ports.js';

export const NOTES_VIEW_PERMISSION: PermissionKey = 'users.notes.view';
export const NOTES_WRITE_PERMISSION: PermissionKey = 'users.notes.write';
export const TAGS_ASSIGN_PERMISSION: PermissionKey = 'users.tags.assign';
export const TAGS_MANAGE_PERMISSION: PermissionKey = 'users.tags.manage';

/** The unique index that IS the duplicate-name policy (schema.ts, `customerTags`). */
const ACTIVE_LABEL_INDEX = 'customer_tags_active_label_key';

export interface CustomerCrmDeps {
  readonly crm: CustomerCrmRepository;
  readonly customers: Pick<CustomerRepository, 'findById'>;
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

/**
 * Customer notes and tags (program §8, `docs/customer-notes-tags.md`): operator-only CRM
 * metadata on a customer.
 *
 * TAGS are the tenant's own, defined in a catalogue (`users.tags.manage`) and put on or taken
 * off a customer (`users.tags.assign`). A tag's id is its identity; its label is editable
 * text, unique case-insensitively among the tenant's ACTIVE tags (the unique index decides,
 * under the catalogue lock). An archived tag stays where it is assigned and is never newly
 * assigned. Reading tags is `users.view`.
 *
 * NOTES are append-only (`users.notes.view` / `users.notes.write`): there is no edit and no
 * delete, here or in the database (`nexa_reject_mutation`). No customer surface holds this
 * service — `tests/unit/customer-crm-privacy.test.ts` asserts it over the source tree.
 *
 * Every write follows the one skeleton Customer 360's controls use: the permission through
 * the guard (a denial audited), the idempotency key under the ACTOR's surface (a replay
 * answers from what is stored now), and ONE transaction holding the scope-activity read, the
 * write, the audit row, the outbox event when something changed, and the remembered key. A
 * write that changed nothing is audited `changed: false` and answered as success.
 */
export class CustomerCrmService {
  constructor(private readonly deps: CustomerCrmDeps) {}

  // --- Tag catalogue --------------------------------------------------------------------

  /** The tenant's whole catalogue (bounded by `CUSTOMER_TAGS_PER_TENANT_MAX`). `users.view`. */
  async listTags(scope: TenantContext, actor: ActorContext): Promise<readonly CustomerTagRecord[]> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
    return this.deps.crm.listTags(scope);
  }

  async createTag(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly label: string;
      readonly color: CustomerTagColor | null;
    },
  ): Promise<{ readonly tag: CustomerTagRecord; readonly changed: boolean }> {
    const denial = { action: 'customer_tag.create', entityType: 'CustomerTag', entityId: null };
    await this.authorize(scope, actor, TAGS_MANAGE_PERMISSION, denial);
    const label = this.label(input.label);
    const result = await this.mutate<{ tagId: string; changed: boolean }>(scope, actor, {
      permission: TAGS_MANAGE_PERMISSION,
      denial,
      idempotencyKey: input.idempotencyKey,
      request: { action: denial.action, label, color: input.color },
      work: async (tx, now) => {
        await this.deps.crm.lockCatalogue(scope, tx);
        if ((await this.deps.crm.countTags(scope, tx)) >= CUSTOMER_TAGS_PER_TENANT_MAX) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.CUSTOMER_TAG_LIMIT,
            `A tenant defines at most ${String(CUSTOMER_TAGS_PER_TENANT_MAX)} tags.`,
          );
        }
        await this.refuseTakenLabel(scope, label, null, tx);
        const tag = await this.insertTag(scope, label, input.color, now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'CustomerTag',
            entityId: tag.id,
            before: null,
            after: { label: tag.label, color: tag.color },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'CustomerTagChanged',
          aggregateType: 'CustomerTag',
          aggregateId: tag.id,
          payload: { tagId: tag.id, change: 'CREATED' },
        });
        return { tagId: tag.id, changed: true };
      },
    });
    return { tag: await this.tagOrThrow(scope, result.tagId), changed: result.changed };
  }

  /** Rename and/or recolour. The id — and so every assignment and filter — is untouched. */
  async updateTag(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly tagId: string;
      readonly label: string;
      readonly color: CustomerTagColor | null;
    },
  ): Promise<{ readonly tag: CustomerTagRecord; readonly changed: boolean }> {
    const tagId = this.tagId(input.tagId);
    const denial = { action: 'customer_tag.update', entityType: 'CustomerTag', entityId: tagId };
    await this.authorize(scope, actor, TAGS_MANAGE_PERMISSION, denial);
    const label = this.label(input.label);
    const result = await this.mutate<{ changed: boolean }>(scope, actor, {
      permission: TAGS_MANAGE_PERMISSION,
      denial,
      idempotencyKey: input.idempotencyKey,
      request: { action: denial.action, tagId, label, color: input.color },
      work: async (tx, now) => {
        await this.deps.crm.lockCatalogue(scope, tx);
        const before = await this.lockedTag(scope, tagId, 'UPDATE', tx);
        // Only an ACTIVE tag competes for a name; an archived one is checked on restore.
        if (before.archivedAt === null) await this.refuseTakenLabel(scope, label, tagId, tx);
        const changed = await this.uniqueLabel(() =>
          this.deps.crm.updateTag(scope, tagId, { label, color: input.color, now }, tx),
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'CustomerTag',
            entityId: tagId,
            before: { label: before.label, color: before.color },
            after: { label, color: input.color, changed },
            result: 'SUCCESS',
          },
          tx,
        );
        if (changed) {
          await this.deps.outbox.write(tx, actor, {
            eventType: 'CustomerTagChanged',
            aggregateType: 'CustomerTag',
            aggregateId: tagId,
            payload: { tagId, change: 'UPDATED' },
          });
        }
        return { changed };
      },
    });
    return { tag: await this.tagOrThrow(scope, tagId), changed: result.changed };
  }

  /**
   * Archive (`true`) or restore (`false`). Nothing deletes a tag: it stays on the customers
   * that carry it and in the audit history that names it. Restoring re-enters the name into
   * the active uniqueness and is refused when another active tag took the name meanwhile.
   */
  async setTagArchived(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly tagId: string; readonly archived: boolean },
  ): Promise<{ readonly tag: CustomerTagRecord; readonly changed: boolean }> {
    const tagId = this.tagId(input.tagId);
    const action = input.archived ? 'customer_tag.archive' : 'customer_tag.restore';
    const denial = { action, entityType: 'CustomerTag', entityId: tagId };
    await this.authorize(scope, actor, TAGS_MANAGE_PERMISSION, denial);
    const result = await this.mutate<{ changed: boolean }>(scope, actor, {
      permission: TAGS_MANAGE_PERMISSION,
      denial,
      idempotencyKey: input.idempotencyKey,
      request: { action, tagId },
      work: async (tx, now) => {
        await this.deps.crm.lockCatalogue(scope, tx);
        const before = await this.lockedTag(scope, tagId, 'UPDATE', tx);
        if (!input.archived && before.archivedAt !== null) {
          await this.refuseTakenLabel(scope, before.label, tagId, tx);
        }
        const changed = await this.uniqueLabel(() =>
          this.deps.crm.setArchived(scope, tagId, input.archived, now, tx),
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'CustomerTag',
            entityId: tagId,
            before: { archivedAt: before.archivedAt?.toISOString() ?? null },
            after: { archived: input.archived, changed },
            result: 'SUCCESS',
          },
          tx,
        );
        if (changed) {
          await this.deps.outbox.write(tx, actor, {
            eventType: 'CustomerTagChanged',
            aggregateType: 'CustomerTag',
            aggregateId: tagId,
            payload: { tagId, change: input.archived ? 'ARCHIVED' : 'RESTORED' },
          });
        }
        return { changed };
      },
    });
    return { tag: await this.tagOrThrow(scope, tagId), changed: result.changed };
  }

  // --- Assignment -----------------------------------------------------------------------

  /** One customer's tags, archived ones included. `users.view`. */
  async tagsOf(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
  ): Promise<readonly CustomerAssignedTagRecord[]> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
    const id = this.customerId(customerId);
    await this.customerOrThrow(scope, id);
    return this.deps.crm.tagsOf(scope, id);
  }

  /**
   * Put a tag on a customer. Idempotent twice over: a replayed key answers from the store,
   * and a fresh key for a pair that already exists changes nothing (`changed: false`). An
   * ARCHIVED tag is refused — read `FOR SHARE`, so an archive committing meanwhile is seen.
   */
  async assignTag(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly customerId: string; readonly tagId: string },
  ): Promise<{ readonly tags: readonly CustomerAssignedTagRecord[]; readonly changed: boolean }> {
    return this.assignment(scope, actor, input, 'customer.tag.assign');
  }

  /** Take a tag off a customer. An archived tag can always be taken off. */
  async removeTag(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly customerId: string; readonly tagId: string },
  ): Promise<{ readonly tags: readonly CustomerAssignedTagRecord[]; readonly changed: boolean }> {
    return this.assignment(scope, actor, input, 'customer.tag.remove');
  }

  private async assignment(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly customerId: string; readonly tagId: string },
    action: 'customer.tag.assign' | 'customer.tag.remove',
  ): Promise<{ readonly tags: readonly CustomerAssignedTagRecord[]; readonly changed: boolean }> {
    const customerId = this.customerId(input.customerId);
    const tagId = this.tagId(input.tagId);
    const denial = { action, entityType: 'Customer', entityId: customerId };
    await this.authorize(scope, actor, TAGS_ASSIGN_PERMISSION, denial);
    const result = await this.mutate<{ changed: boolean }>(scope, actor, {
      permission: TAGS_ASSIGN_PERMISSION,
      denial,
      idempotencyKey: input.idempotencyKey,
      request: { action, customerId, tagId },
      work: async (tx, now) => {
        await this.customerOrThrow(scope, customerId, tx);
        const tag = await this.lockedTag(scope, tagId, 'SHARE', tx);
        let changed: boolean;
        if (action === 'customer.tag.assign') {
          if (tag.archivedAt !== null) {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.CUSTOMER_TAG_ARCHIVED,
              'An archived tag cannot be assigned. Restore it first.',
            );
          }
          changed = await this.deps.crm.assign(
            scope,
            { customerId, tagId, adminId: adminIdOf(actor), now },
            tx,
          );
        } else {
          changed = await this.deps.crm.unassign(scope, customerId, tagId, tx);
        }
        // On the CUSTOMER, so the change is on the customer's own timeline. The label is
        // the one at the time — a later rename does not rewrite what was assigned.
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Customer',
            entityId: customerId,
            before: null,
            after: { tagId, label: tag.label, changed },
            result: 'SUCCESS',
          },
          tx,
        );
        if (changed) {
          await this.deps.outbox.write(tx, actor, {
            eventType:
              action === 'customer.tag.assign' ? 'CustomerTagAssigned' : 'CustomerTagRemoved',
            aggregateType: 'Customer',
            aggregateId: customerId,
            payload: { tagId },
          });
        }
        return { changed };
      },
    });
    return { tags: await this.deps.crm.tagsOf(scope, customerId), changed: result.changed };
  }

  // --- Notes ----------------------------------------------------------------------------

  /** Newest first. `users.notes.view` — on top of `users.view`, which the catalogue requires. */
  async notesOf(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: string;
      readonly limit?: number;
      readonly cursor?: CustomerNoteCursor;
    },
  ): Promise<CustomerNotePage> {
    await this.deps.guard.check(scope, actor, NOTES_VIEW_PERMISSION);
    const customerId = this.customerId(input.customerId);
    await this.customerOrThrow(scope, customerId);
    const limit = Math.min(input.limit ?? CUSTOMER_NOTE_PAGE_DEFAULT, CUSTOMER_NOTE_PAGE_MAX);
    return this.deps.crm.notesOf(scope, customerId, limit, input.cursor ?? null);
  }

  /**
   * Append a note. The body is the note's own row (append-only); the AUDIT row carries the
   * note's id and length, never its text — the audit log is read more widely than notes are
   * (`audit.view`), and a note's privacy is `users.notes.view`'s to decide.
   */
  async addNote(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly customerId: string; readonly body: string },
  ): Promise<{ readonly note: CustomerNoteRecord; readonly created: boolean }> {
    const customerId = this.customerId(input.customerId);
    const denial = { action: 'customer.note.add', entityType: 'Customer', entityId: customerId };
    await this.authorize(scope, actor, NOTES_WRITE_PERMISSION, denial);
    const parsed = customerNoteBodySchema.safeParse(input.body);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        parsed.error.issues[0]?.message ?? 'That note cannot be stored.',
      );
    }
    const body = parsed.data;
    let replayed = true;
    const result = await this.mutate<{ noteId: string }>(scope, actor, {
      permission: NOTES_WRITE_PERMISSION,
      denial,
      idempotencyKey: input.idempotencyKey,
      request: { action: denial.action, customerId, body },
      work: async (tx, now) => {
        replayed = false;
        await this.customerOrThrow(scope, customerId, tx);
        const note = await this.deps.crm.insertNote(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId,
            body,
            authorAdminId: adminIdOf(actor),
            authorLabel: actor.label ?? actor.type,
            now,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'Customer',
            entityId: customerId,
            before: null,
            after: { noteId: note.id, length: Array.from(body).length },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'CustomerNoteAdded',
          aggregateType: 'Customer',
          aggregateId: customerId,
          payload: { noteId: note.id },
        });
        return { noteId: note.id };
      },
    });
    const note = await this.deps.crm.findNote(scope, customerId, result.noteId);
    if (note === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    return { note, created: !replayed };
  }

  // --- The skeleton ---------------------------------------------------------------------

  private async mutate<T>(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly permission: PermissionKey;
      readonly denial: { action: string; entityType: string; entityId: string | null };
      readonly idempotencyKey: string;
      /** What the command asks for: a key reused with a different request is refused. */
      readonly request: Readonly<Record<string, unknown>>;
      readonly work: (tx: TransactionScope, now: Date) => Promise<T>;
    },
  ): Promise<T> {
    const requestHash = hashRequest(input.request);
    const namespace = actor.surface;
    const replay = await this.deps.idempotency.find<T>(
      scope,
      namespace,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return replay.result;
    const now = this.deps.clock.now();
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
      input.permission,
      input.denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const result = await input.work(tx, now);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          namespace,
          input.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        permission,
        denial,
        error,
      );
      throw error;
    }
  }

  private async insertTag(
    scope: TenantContext,
    label: string,
    color: CustomerTagColor | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<CustomerTagRecord> {
    return this.uniqueLabel(() =>
      this.deps.crm.insertTag(scope, { id: this.deps.ids.uuid(), label, color, now }, tx),
    );
  }

  /**
   * The read under the catalogue lock gives the clean refusal; the unique index is the rule
   * itself, for a writer that skipped the lock — so its violation is the same refusal, never
   * a 500.
   */
  private async refuseTakenLabel(
    scope: TenantContext,
    label: string,
    exceptId: string | null,
    tx: TransactionScope,
  ): Promise<void> {
    if (await this.deps.crm.activeLabelTaken(scope, label, exceptId, tx)) throw nameTaken();
  }

  private async uniqueLabel<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, ACTIVE_LABEL_INDEX)) throw nameTaken();
      throw error;
    }
  }

  private async lockedTag(
    scope: TenantContext,
    tagId: string,
    lock: 'UPDATE' | 'SHARE',
    tx: TransactionScope,
  ): Promise<CustomerTagRecord> {
    const tag = await this.deps.crm.findTag(scope, tagId, tx, lock);
    if (tag === null) throw tagNotFound();
    return tag;
  }

  private async tagOrThrow(scope: TenantContext, tagId: string): Promise<CustomerTagRecord> {
    const tag = await this.deps.crm.findTag(scope, tagId);
    if (tag === null) throw tagNotFound();
    return tag;
  }

  private async customerOrThrow(
    scope: TenantContext,
    customerId: UserId,
    tx?: TransactionScope,
  ): Promise<void> {
    if ((await this.deps.customers.findById(scope, customerId, tx)) === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
  }

  private label(raw: string): string {
    const parsed = customerTagLabelSchema.safeParse(raw);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        parsed.error.issues[0]?.message ?? 'That is not a tag name this installation can store.',
      );
    }
    return parsed.data;
  }

  /** A customer id, or a 400 — never a 500 at the `uuid` cast. */
  private customerId(candidate: string): UserId {
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    return parsed.data;
  }

  private tagId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) throw tagNotFound();
    return parsed.data.toLowerCase();
  }
}

function nameTaken() {
  return errors.conflict(
    COMMERCE_ERROR_CODES.CUSTOMER_TAG_NAME_TAKEN,
    'Another active tag already has this name.',
  );
}

function tagNotFound() {
  return errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_TAG_NOT_FOUND, 'Unknown tag.');
}

/** The admin behind an operator actor, for the author/assigner columns; null otherwise. */
function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN' ? actor.id : null;
}
