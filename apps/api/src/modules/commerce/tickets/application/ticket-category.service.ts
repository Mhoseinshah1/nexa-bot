import {
  TICKET_CATEGORY_MAX,
  TICKET_ERROR_CODES,
  COMMERCE_ERROR_CODES,
  errors,
  normalizeTicketCategoryTitle,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TemplateKey,
  type TenantContext,
  type TicketCategoryId,
  type UnitOfWork,
} from '@nexa/contracts';
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
import type { TemplateResolver } from '../../../control/templates/application/template-resolver.js';
import type { TicketCategoryRecord, TicketCategoryRepository } from './ports.js';

export const TICKETS_VIEW_PERMISSION = 'tickets.view' satisfies PermissionKey;
const CATEGORIES_EDIT_PERMISSION = 'tickets.categories.edit' satisfies PermissionKey;

/**
 * The five defaults, by template key, in the order they are offered — literal keys, so the
 * compiler checks each against `TEMPLATES`. The Persian names are the catalogue's; a tenant
 * override of one is that tenant's default.
 */
const SEED_TEMPLATES: readonly TemplateKey[] = [
  'bot.ticket.category_default_1',
  'bot.ticket.category_default_2',
  'bot.ticket.category_default_3',
  'bot.ticket.category_default_4',
  'bot.ticket.category_default_5',
];
/** Ten apart, so an operator can slot a category between two defaults without renumbering. */
const SEED_SORT_STEP = 10;

export interface TicketCategoryServiceDeps {
  readonly categories: TicketCategoryRepository;
  readonly templates: Pick<TemplateResolver, 'render'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The categories a customer files a ticket under (WP-A7). One service for both surfaces: the
 * bot reads the active ones, the Web Admin reads and edits them all.
 */
export class TicketCategoryService {
  constructor(private readonly deps: TicketCategoryServiceDeps) {}

  /**
   * Copies the five defaults into a tenant's categories, ONCE — the FAQ seeder's pattern
   * (`SupportFaqSeeder`): the marker goes in first under `ON CONFLICT DO NOTHING`, so two
   * replicas reading a fresh tenant produce one seed, and a tenant that deactivates every
   * default is not re-seeded. A write, so it reads scope activity: a stopped tenant is given
   * nothing.
   */
  async ensureSeeded(scope: TenantContext): Promise<void> {
    if (await this.deps.categories.hasSeed(scope)) return;
    await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return;
      await this.deps.categories.lockTenant(scope, tx);
      const now = this.deps.clock.now();
      if (!(await this.deps.categories.markSeeded(scope, now, tx))) return;
      for (const [index, key] of SEED_TEMPLATES.entries()) {
        const title = normalizeTicketCategoryTitle(
          await this.deps.templates.render(scope, key, {}, undefined, tx),
        );
        if (title === null) {
          throw errors.validation(
            TICKET_ERROR_CODES.TICKET_CATEGORY_INVALID,
            `The rendered default ticket category ${String(index + 1)} does not fit a category title.`,
            { key },
          );
        }
        // An operator may already hold the title (a category made before the seed ran).
        if ((await this.deps.categories.findByTitle(scope, title, tx)) !== null) continue;
        await this.deps.categories.insert(
          scope,
          {
            id: this.deps.ids.uuid() as TicketCategoryId,
            title,
            sortOrder: (index + 1) * SEED_SORT_STEP,
            isActive: true,
            now,
          },
          tx,
        );
      }
    });
  }

  /** The categories a customer may choose from: active, in the operator's order. */
  async activeForCustomer(scope: TenantContext): Promise<readonly TicketCategoryRecord[]> {
    await this.ensureSeeded(scope);
    return this.deps.categories.list(scope, { activeOnly: true });
  }

  /** Every category, for the Web Admin's filter and editor. Charged `tickets.view`. */
  async list(scope: TenantContext, actor: ActorContext): Promise<readonly TicketCategoryRecord[]> {
    await this.deps.guard.check(scope, actor, TICKETS_VIEW_PERMISSION);
    await this.ensureSeeded(scope);
    return this.deps.categories.list(scope, { activeOnly: false });
  }

  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly title: string; readonly sortOrder: number },
  ): Promise<{ readonly category: TicketCategoryRecord; readonly changed: boolean }> {
    const title = this.titleOf(input.title);
    const requestHash = hashRequest({ title, sortOrder: input.sortOrder });
    const denial = {
      action: 'ticket_category.create',
      entityType: 'TicketCategory',
      entityId: null,
    };
    await this.authorize(scope, actor, CATEGORIES_EDIT_PERMISSION, denial);
    const replayed = await this.deps.idempotency.find<{ categoryId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const found = await this.deps.categories.findById(scope, replayed.result.categoryId);
      if (found !== null) return { category: found, changed: false };
    }
    await this.ensureSeeded(scope);
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CATEGORIES_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.categories.lockTenant(scope, tx);
        if ((await this.deps.categories.count(scope, tx)) >= TICKET_CATEGORY_MAX) {
          throw errors.conflict(
            TICKET_ERROR_CODES.TICKET_CATEGORY_LIMIT,
            `A tenant may have at most ${String(TICKET_CATEGORY_MAX)} ticket categories.`,
            { max: TICKET_CATEGORY_MAX },
          );
        }
        if ((await this.deps.categories.findByTitle(scope, title, tx)) !== null) {
          throw this.duplicate();
        }
        const category = await this.deps.categories.insert(
          scope,
          {
            id: this.deps.ids.uuid() as TicketCategoryId,
            title,
            sortOrder: input.sortOrder,
            isActive: true,
            now: this.deps.clock.now(),
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ticket_category.create',
            entityType: 'TicketCategory',
            entityId: category.id,
            before: null,
            after: { title: category.title, sortOrder: category.sortOrder, isActive: true },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { categoryId: category.id },
          tx,
        );
        return { category, changed: true };
      },
    );
  }

  /**
   * Renames, reorders, hides or shows a category. Target values, so a repeated request
   * writes what is already stored and answers `changed: false`. A category is never deleted:
   * tickets name it, and hiding it takes it off the customer's keyboard.
   */
  async update(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    patch: { readonly title?: string; readonly sortOrder?: number; readonly isActive?: boolean },
  ): Promise<{ readonly category: TicketCategoryRecord; readonly changed: boolean }> {
    /*
     * The route's raw parameter, parsed before it reaches a uuid column: a malformed id is
     * the category that does not exist, never a database error (Codex review of #96).
     */
    const parsed = uuidV7Schema.safeParse(id);
    if (!parsed.success) {
      throw errors.notFound(TICKET_ERROR_CODES.TICKET_CATEGORY_NOT_FOUND, 'Unknown category.');
    }
    const categoryId = parsed.data;
    const title = patch.title === undefined ? undefined : this.titleOf(patch.title);
    const denial = {
      action: 'ticket_category.update',
      entityType: 'TicketCategory',
      entityId: categoryId,
    };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CATEGORIES_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.categories.lockTenant(scope, tx);
        const current = await this.deps.categories.findById(scope, categoryId, tx);
        if (current === null) {
          throw errors.notFound(TICKET_ERROR_CODES.TICKET_CATEGORY_NOT_FOUND, 'Unknown category.');
        }
        const next = {
          title: title ?? current.title,
          sortOrder: patch.sortOrder ?? current.sortOrder,
          isActive: patch.isActive ?? current.isActive,
        };
        if (
          next.title === current.title &&
          next.sortOrder === current.sortOrder &&
          next.isActive === current.isActive
        ) {
          return { category: current, changed: false };
        }
        if (next.title !== current.title) {
          const holder = await this.deps.categories.findByTitle(scope, next.title, tx);
          if (holder !== null && holder.id !== current.id) throw this.duplicate();
        }
        const category = await this.deps.categories.update(
          scope,
          current.id,
          next,
          this.deps.clock.now(),
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ticket_category.update',
            entityType: 'TicketCategory',
            entityId: category.id,
            before: {
              title: current.title,
              sortOrder: current.sortOrder,
              isActive: current.isActive,
            },
            after: next,
            result: 'SUCCESS',
          },
          tx,
        );
        return { category, changed: true };
      },
    );
  }

  /** An early check that leaves the same audit trace as one inside the transaction. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private titleOf(raw: string): string {
    const title = normalizeTicketCategoryTitle(raw);
    if (title === null) {
      throw errors.validation(
        TICKET_ERROR_CODES.TICKET_CATEGORY_INVALID,
        'A category title is one line of 1 to 64 characters.',
      );
    }
    return title;
  }

  private duplicate() {
    return errors.conflict(
      TICKET_ERROR_CODES.TICKET_CATEGORY_INVALID,
      'Another category already has this title.',
      { reason: 'DUPLICATE' },
    );
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
