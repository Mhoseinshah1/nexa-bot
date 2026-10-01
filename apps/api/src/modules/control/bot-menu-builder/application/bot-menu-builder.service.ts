import {
  BOT_MENU_BUILDER_AUDIT_ACTIONS,
  BOT_MENU_BUILDER_AUDIT_ENTITY,
  BOT_MENU_PUBLISHED_READABLE_CODE,
  BOT_MENU_PUBLISHED_UNREADABLE_CODE,
  CONTROL_ERROR_CODES,
  DEFAULT_EXPLICIT_MAIN_MENU,
  MAIN_MENU_BUTTONS,
  PLATFORM_ERROR_CODES,
  errors,
  explicitFromLegacy,
  explicitMainMenuSchema,
  explicitMainMenusEqual,
  legacyProjectionOf,
  mainMenuLayoutSchema,
  mainMenuRevisionsQuerySchema,
  normalizeExplicitMainMenu,
  publishMainMenuRequestSchema,
  resetMainMenuDraftRequestSchema,
  restoreMainMenuRevisionRequestSchema,
  saveMainMenuDraftRequestSchema,
  type ActorContext,
  type AuditWriter,
  type BotMenuBuilderResponse,
  type BotMenuButton,
  type Clock,
  type ExplicitMainMenu,
  type IdGenerator,
  type IdempotencyStore,
  type MainMenuBuilderHead,
  type MainMenuBuilderItem,
  type MainMenuBuilderMutationResponse,
  type MainMenuGate,
  type MainMenuItem,
  type MainMenuLayoutEntry,
  type MainMenuRevisionListResponse,
  type OperationalEventRecorder,
  type PermissionKey,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
  type MutationDenial,
} from '../../../platform/access/application/authorized-mutation.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AppearanceBotRecord } from '../../appearance/application/ports.js';
import type { SettingRepository } from '../../settings/application/ports.js';
import {
  INVALID_STORED_SETTING_CODE,
  type ResolvedSetting,
} from '../../settings/application/settings-resolver.js';
import { PUBLISHED_UNREADABLE_DEDUPE_KEY } from './main-menu-source.js';
import type { MainMenuBuilderRepository, StoredMainMenuLayout } from './ports.js';

export const BOT_MENU_BUILDER_VIEW_PERMISSION = 'settings.view' satisfies PermissionKey;
export const BOT_MENU_BUILDER_EDIT_PERMISSION = 'settings.edit' satisfies PermissionKey;

/** The keyboard's evaluator, as `MainMenuLayout` implements it. Structural: no import from commerce. */
export interface BuilderMainMenuReader {
  describeFor(
    scope: TenantContext,
    options?: { readonly gatesForHidden?: boolean },
  ): Promise<
    ReadonlyArray<{
      readonly item: MainMenuItem;
      readonly button: BotMenuButton;
      readonly gate: MainMenuGate | null;
      readonly gateOpen: boolean | null;
      readonly shown: boolean;
    }>
  >;
  rowsFor(scope: TenantContext): Promise<string[][]>;
}

export interface BotMenuBuilderServiceDeps {
  readonly repository: MainMenuBuilderRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  /** The RAW recorder: denials after the transaction, recoveries inside it. */
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** `bot.main_menu` as resolved (value, version, invalidity), in the caller's transaction. */
  readonly settings: {
    resolve(scope: TenantContext, key: 'bot.main_menu', tx?: unknown): Promise<ResolvedSetting>;
  };
  /** The setting's own conditional write — the publish's projection goes through it. */
  readonly settingRepository: Pick<SettingRepository, 'upsert'>;
  readonly mainMenu: BuilderMainMenuReader;
  readonly templates: {
    render(scope: TenantContext, key: TemplateKey, values: TemplateValues): Promise<string>;
    resolve(
      scope: TenantContext,
      key: TemplateKey,
    ): Promise<{ readonly source: 'DEFAULT' | 'TENANT' }>;
  };
  /** The shared catalogue's own text for a key, in the default locale. */
  readonly defaultLabel: (key: TemplateKey) => string;
  /** The tenant's bots with their last appearance test — icon eligibility is per bot. */
  readonly bots: { listBots(scope: TenantContext): Promise<AppearanceBotRecord[]> };
}

/**
 * Round T — the button builder (`docs/round-t-button-builder-audit.md` §11).
 *
 * One read and four writes over ONE row per tenant (draft + published head) and an
 * append-only revision per publish. Draft saves, a reset and a restore change the draft and
 * nothing a customer sees; only a publish does, and it rewrites the compatibility
 * projection `bot.main_menu`, writes the revision, moves the published head, audits and
 * emits the existing `SettingChanged` — in ONE transaction, so there is never a published
 * layout without its projection or the reverse.
 *
 * Every write: `settings.edit`, checked early and again inside the transaction
 * (`runAuthorizedMutation`); an idempotency key whose first answer is replayed verbatim; the
 * version the caller read, compared under the row lock and again in the statement; scope
 * activity read inside the transaction; a no-op reported as one.
 */
export class BotMenuBuilderService {
  constructor(private readonly deps: BotMenuBuilderServiceDeps) {}

  async view(scope: TenantContext, actor: ActorContext): Promise<BotMenuBuilderResponse> {
    await this.deps.guard.check(scope, actor, BOT_MENU_BUILDER_VIEW_PERMISSION);
    const [row, setting] = await Promise.all([
      this.deps.repository.findLayout(scope),
      this.deps.settings.resolve(scope, 'bot.main_menu'),
    ]);
    const seed = explicitFromLegacy(setting.value as readonly MainMenuLayoutEntry[]);
    const head = headOf(row, seed);
    const published = head.published;
    const superseded =
      row !== null &&
      row.publishedRevision !== null &&
      row.projectionSettingVersion !== setting.version;
    const publishedUnreadable = published !== null && published.layout === null;
    const [described, live, bots] = await Promise.all([
      this.deps.mainMenu.describeFor(scope, { gatesForHidden: true }),
      this.deps.mainMenu.rowsFor(scope),
      this.deps.bots.listBots(scope),
    ]);
    return {
      source: published !== null && !superseded && !publishedUnreadable ? 'EXPLICIT' : 'LEGACY',
      superseded,
      publishedUnreadable,
      draft: head.draft,
      published,
      items: await this.items(scope, described),
      live: { rows: live },
      iconEligibility: bots.map((bot) => ({
        botInstanceId: bot.id,
        username: bot.username,
        status: bot.status,
        eligible: bot.test?.outcome === 'SENT',
      })),
    };
  }

  async revisions(
    scope: TenantContext,
    actor: ActorContext,
    query: unknown,
  ): Promise<MainMenuRevisionListResponse> {
    await this.deps.guard.check(scope, actor, BOT_MENU_BUILDER_VIEW_PERMISSION);
    const page = mainMenuRevisionsQuerySchema.parse(query ?? {});
    const rows = await this.deps.repository.listRevisions(scope, {
      before: page.before ?? null,
      limit: page.limit,
    });
    const last = rows.at(-1);
    return {
      revisions: rows.map((row) => ({
        id: row.id,
        revision: row.revision,
        layout: readLayout(row.snapshot),
        createdAt: row.createdAt.toISOString(),
        createdByAdminId: row.createdByAdminId,
        restoredFrom: row.restoredFrom,
      })),
      // Revisions are numbered 1..n with no gaps, so the last one says whether more exist.
      nextBefore: last !== undefined && last.revision > 1 ? last.revision : null,
    };
  }

  /** Save the draft. Changes nothing a customer sees. */
  async saveDraft(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<MainMenuBuilderMutationResponse> {
    const denial = this.denial(scope, BOT_MENU_BUILDER_AUDIT_ACTIONS.DRAFT_SAVED);
    await this.authorize(scope, actor, denial);
    const command = saveMainMenuDraftRequestSchema.parse(input);
    const parsed = explicitMainMenuSchema.safeParse(command.layout);
    if (!parsed.success) {
      throw errors.validation(
        CONTROL_ERROR_CODES.INVALID_VALUE,
        'The layout does not match its declaration.',
        {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      );
    }
    const layout = normalizeExplicitMainMenu(parsed.data);
    const requestHash = hashRequest({
      action: denial.action,
      layout,
      expectedDraftVersion: command.expectedDraftVersion,
    });
    return this.mutate(scope, actor, denial, command.idempotencyKey, requestHash, async (tx) => {
      const before = await this.lockedRow(scope, tx, command.expectedDraftVersion);
      if (before !== null && sameDraft(before, layout)) return { changed: false, row: before };
      const after = await this.writeDraft(scope, actor, tx, before, {
        draft: layout,
        // An edit of a restored draft is still derived from that revision.
        restoredFromRevisionId: before?.draftRestoredFrom?.id ?? null,
      });
      await this.auditDraft(scope, actor, tx, denial.action, before, after, null);
      return { changed: true, row: after };
    });
  }

  /** Reset the DRAFT to the registry's default. Never live. */
  async reset(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<MainMenuBuilderMutationResponse> {
    const denial = this.denial(scope, BOT_MENU_BUILDER_AUDIT_ACTIONS.RESET);
    await this.authorize(scope, actor, denial);
    const command = resetMainMenuDraftRequestSchema.parse(input);
    const requestHash = hashRequest({
      action: denial.action,
      expectedDraftVersion: command.expectedDraftVersion,
    });
    return this.mutate(scope, actor, denial, command.idempotencyKey, requestHash, async (tx) => {
      const before = await this.lockedRow(scope, tx, command.expectedDraftVersion);
      if (
        before !== null &&
        sameDraft(before, DEFAULT_EXPLICIT_MAIN_MENU) &&
        before.draftRestoredFrom === null
      ) {
        return { changed: false, row: before };
      }
      const after = await this.writeDraft(scope, actor, tx, before, {
        draft: DEFAULT_EXPLICIT_MAIN_MENU,
        restoredFromRevisionId: null,
      });
      await this.auditDraft(scope, actor, tx, denial.action, before, after, null);
      return { changed: true, row: after };
    });
  }

  /** Restore one revision INTO THE DRAFT. Publishing it is a separate act and a new revision. */
  async restore(
    scope: TenantContext,
    actor: ActorContext,
    revisionId: string,
    input: unknown,
  ): Promise<MainMenuBuilderMutationResponse> {
    const denial = this.denial(scope, BOT_MENU_BUILDER_AUDIT_ACTIONS.RESTORED);
    await this.authorize(scope, actor, denial);
    const command = restoreMainMenuRevisionRequestSchema.parse(input);
    const requestHash = hashRequest({
      action: denial.action,
      revisionId,
      expectedDraftVersion: command.expectedDraftVersion,
    });
    return this.mutate(scope, actor, denial, command.idempotencyKey, requestHash, async (tx) => {
      // Tenant-scoped: another tenant's revision id is not found, the same answer as none.
      const revision = await this.deps.repository.findRevision(scope, revisionId, tx);
      if (revision === null) {
        throw errors.notFound(
          CONTROL_ERROR_CODES.MAIN_MENU_REVISION_NOT_FOUND,
          'No main-menu revision with that id in this tenant.',
          { revisionId },
        );
      }
      const snapshot = readLayout(revision.snapshot);
      if (snapshot === null) {
        throw errors.validation(
          CONTROL_ERROR_CODES.INVALID_VALUE,
          'This revision was written by a later release and cannot be read here.',
          { revisionId },
        );
      }
      const before = await this.lockedRow(scope, tx, command.expectedDraftVersion);
      if (
        before !== null &&
        sameDraft(before, snapshot) &&
        before.draftRestoredFrom?.id === revision.id
      ) {
        return { changed: false, row: before };
      }
      const after = await this.writeDraft(scope, actor, tx, before, {
        draft: snapshot,
        restoredFromRevisionId: revision.id,
      });
      await this.auditDraft(scope, actor, tx, denial.action, before, after, {
        id: revision.id,
        revision: revision.revision,
      });
      return { changed: true, row: after };
    });
  }

  /**
   * Publish the saved draft: the projection, the revision and the published head in ONE
   * transaction (audit §11.6). A draft identical to what is published, with the projection
   * still current, is a no-op; a SUPERSEDED layout is published again even when the draft
   * is unchanged, because the projection is what has to be put back.
   */
  async publish(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<MainMenuBuilderMutationResponse> {
    const denial = this.denial(scope, BOT_MENU_BUILDER_AUDIT_ACTIONS.PUBLISHED);
    await this.authorize(scope, actor, denial);
    const command = publishMainMenuRequestSchema.parse(input);
    const requestHash = hashRequest({
      action: denial.action,
      expectedDraftVersion: command.expectedDraftVersion,
      expectedPublishedRevision: command.expectedPublishedRevision,
    });
    return this.mutate(scope, actor, denial, command.idempotencyKey, requestHash, async (tx) => {
      const row = await this.deps.repository.findLayout(scope, tx, true);
      if (
        row === null ||
        row.draftVersion !== command.expectedDraftVersion ||
        row.publishedRevision !== command.expectedPublishedRevision
      ) {
        throw conflict(command);
      }
      // Re-parsed here, whatever the draft save checked: the row is what is published.
      const layout = readLayout(row.draft);
      if (layout === null) {
        throw errors.validation(
          CONTROL_ERROR_CODES.INVALID_VALUE,
          'The saved draft cannot be read by this release. Save the draft again.',
        );
      }
      const setting = await this.deps.settings.resolve(scope, 'bot.main_menu', tx);
      const current = readLayout(row.published);
      if (
        current !== null &&
        explicitMainMenusEqual(current, layout) &&
        row.projectionSettingVersion === setting.version
      ) {
        return { changed: false, row };
      }

      // 1. The compatibility projection, under the setting's own version predicate.
      const projection = mainMenuLayoutSchema.parse(legacyProjectionOf(layout));
      const now = this.deps.clock.now();
      const adminId = adminIdOf(actor);
      const written = await this.deps.settingRepository.upsert(
        scope,
        {
          id: this.deps.ids.uuid(),
          key: 'bot.main_menu',
          value: projection,
          expectedVersion: setting.version,
          now,
          adminId,
        },
        tx,
      );
      if (written === null) throw conflict(command);

      // 2. The revision — append-only, numbered after the published head read under the lock.
      const revision = (row.publishedRevision ?? 0) + 1;
      const revisionId = this.deps.ids.uuid();
      await this.deps.repository.insertRevision(
        scope,
        {
          id: revisionId,
          revision,
          snapshot: layout,
          restoredFromRevisionId: row.draftRestoredFrom?.id ?? null,
          now,
          adminId,
        },
        tx,
      );

      // 3. The published head, naming the draft version and revision it was built on.
      const after = await this.deps.repository.publish(
        scope,
        {
          expectedDraftVersion: row.draftVersion,
          expectedPublishedRevision: row.publishedRevision,
          published: layout,
          revision,
          now,
          adminId,
          projectionSettingVersion: written.version,
        },
        tx,
      );
      if (after === null) throw conflict(command);

      await this.deps.audit.record(
        scope,
        actor,
        {
          action: BOT_MENU_BUILDER_AUDIT_ACTIONS.PUBLISHED,
          entityType: BOT_MENU_BUILDER_AUDIT_ENTITY,
          entityId: scope.tenantId,
          before: { revision: row.publishedRevision, layout: row.published ?? null },
          after: {
            revision,
            revisionId,
            layout,
            restoredFrom: row.draftRestoredFrom,
            projection,
            settingVersion: written.version,
          },
          result: 'SUCCESS',
        },
        tx,
      );
      // The EXISTING event, so the command-menu sync and every other consumer of
      // `bot.main_menu` keep working with no change (no new EVENT_TYPES entry).
      await this.deps.outbox.write(tx, actor, {
        eventType: 'SettingChanged',
        aggregateType: 'Setting',
        aggregateId: 'bot.main_menu',
        payload: { key: 'bot.main_menu', from: setting.value, to: written.value },
      });
      // A publish repairs two conditions a read may have opened: the setting's own
      // invalidity, and a published layout this release could not read.
      if (setting.storedValueInvalid) {
        await this.deps.opsLog.record(
          scope,
          {
            code: 'settings.stored_value_valid',
            severity: 'INFO',
            message: 'The stored value for bot.main_menu parses again.',
            context: { key: 'bot.main_menu' },
            recoversCode: INVALID_STORED_SETTING_CODE,
            recoversDedupeKey: `${INVALID_STORED_SETTING_CODE}:bot.main_menu`,
          },
          tx,
        );
      }
      if (row.published !== null && current === null) {
        await this.deps.opsLog.record(
          scope,
          {
            code: BOT_MENU_PUBLISHED_READABLE_CODE,
            severity: 'INFO',
            message: 'A readable main-menu layout is published again.',
            context: { revision },
            recoversCode: BOT_MENU_PUBLISHED_UNREADABLE_CODE,
            recoversDedupeKey: PUBLISHED_UNREADABLE_DEDUPE_KEY,
          },
          tx,
        );
      }
      return { changed: true, row: after };
    });
  }

  // --- helpers ----------------------------------------------------------------------

  private async items(
    scope: TenantContext,
    described: Awaited<ReturnType<BuilderMainMenuReader['describeFor']>>,
  ): Promise<MainMenuBuilderItem[]> {
    const gateOf = new Map(described.map((one) => [one.item.button, one]));
    const rendered = await Promise.all(
      MAIN_MENU_BUTTONS.map(async (button) => {
        const [label, resolved] = await Promise.all([
          this.deps.templates.render(scope, button.label, {}),
          this.deps.templates.resolve(scope, button.label),
        ]);
        return { button, label: label.trim(), overridden: resolved.source === 'TENANT' };
      }),
    );
    return rendered.map(({ button, label, overridden }) => {
      const decision = gateOf.get(button.id);
      return {
        id: button.id,
        target: button.command,
        wide: button.wide,
        label,
        defaultLabel: this.deps.defaultLabel(button.label).trim(),
        labelOverridden: overridden,
        defaultAppearanceSlot: button.appearanceSlot,
        gate: decision?.gate ?? null,
        gateOpen: decision?.gate == null ? null : (decision.gateOpen ?? null),
        duplicateLabel:
          label !== '' &&
          rendered.some((other) => other.button !== button && other.label === label),
        slashLabel: label.startsWith('/'),
      };
    });
  }

  /** The tenant's row under its lock, refused when it is not at the version the caller read. */
  private async lockedRow(
    scope: TenantContext,
    tx: TransactionScope,
    expectedDraftVersion: number | null,
  ): Promise<StoredMainMenuLayout | null> {
    const row = await this.deps.repository.findLayout(scope, tx, true);
    if ((row?.draftVersion ?? null) !== expectedDraftVersion) {
      throw conflict({ expectedDraftVersion });
    }
    return row;
  }

  /** The first draft is an insert that does nothing on conflict; every later one names its version. */
  private async writeDraft(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    before: StoredMainMenuLayout | null,
    change: { readonly draft: ExplicitMainMenu; readonly restoredFromRevisionId: string | null },
  ): Promise<StoredMainMenuLayout> {
    const fields = { ...change, now: this.deps.clock.now(), adminId: adminIdOf(actor) };
    const after =
      before === null
        ? await this.deps.repository.insertDraft(scope, fields, tx)
        : await this.deps.repository.updateDraft(
            scope,
            { ...fields, expectedDraftVersion: before.draftVersion },
            tx,
          );
    if (after === null) {
      throw conflict({ expectedDraftVersion: before?.draftVersion ?? null });
    }
    return after;
  }

  private async auditDraft(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    action: string,
    before: StoredMainMenuLayout | null,
    after: StoredMainMenuLayout,
    restoredFrom: { readonly id: string; readonly revision: number } | null,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action,
        entityType: BOT_MENU_BUILDER_AUDIT_ENTITY,
        entityId: scope.tenantId,
        before: before === null ? null : { draft: before.draft, draftVersion: before.draftVersion },
        after: {
          draft: after.draft,
          draftVersion: after.draftVersion,
          ...(restoredFrom === null ? {} : { restoredFrom }),
        },
        result: 'SUCCESS',
      },
      tx,
    );
  }

  /**
   * The shared shape of every write: replay first, then one authorized transaction with
   * scope activity read inside it, and the answer remembered in that transaction.
   */
  private async mutate(
    scope: TenantContext,
    actor: ActorContext,
    denial: MutationDenial,
    idempotencyKey: string,
    requestHash: string,
    work: (
      tx: TransactionScope,
    ) => Promise<{ readonly changed: boolean; readonly row: StoredMainMenuLayout }>,
  ): Promise<MainMenuBuilderMutationResponse> {
    const replayed = await this.deps.idempotency.find<MainMenuBuilderMutationResponse>(
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
    );
    if (replayed !== null) return replayed.result;
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
      BOT_MENU_BUILDER_EDIT_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        const { changed, row } = await work(tx);
        const answer: MainMenuBuilderMutationResponse = {
          changed,
          head: headOf(row, DEFAULT_EXPLICIT_MAIN_MENU),
        };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          idempotencyKey,
          requestHash,
          answer,
          tx,
        );
        return answer;
      },
    );
  }

  private denial(scope: TenantContext, action: string): MutationDenial {
    return { action, entityType: BOT_MENU_BUILDER_AUDIT_ENTITY, entityId: scope.tenantId };
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: MutationDenial,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, BOT_MENU_BUILDER_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        BOT_MENU_BUILDER_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }
}

/** A stored layout, parsed and in canonical form; null when this release cannot read it. */
function readLayout(stored: unknown): ExplicitMainMenu | null {
  if (stored === null || stored === undefined) return null;
  const parsed = explicitMainMenuSchema.safeParse(stored);
  return parsed.success ? normalizeExplicitMainMenu(parsed.data) : null;
}

function sameDraft(row: StoredMainMenuLayout, layout: ExplicitMainMenu): boolean {
  const draft = readLayout(row.draft);
  return draft !== null && explicitMainMenusEqual(draft, layout);
}

/**
 * The two heads as the builder shows them. `seed` stands in for a draft there is none of,
 * or one this release cannot read: the live keyboard converted, for the read.
 */
function headOf(row: StoredMainMenuLayout | null, seed: ExplicitMainMenu): MainMenuBuilderHead {
  const published =
    row === null ||
    row.publishedRevision === null ||
    row.publishedAt === null ||
    row.published === null
      ? null
      : {
          layout: readLayout(row.published),
          revision: row.publishedRevision,
          publishedAt: row.publishedAt.toISOString(),
          publishedByAdminId: row.publishedByAdminId,
        };
  const stored = row === null ? null : readLayout(row.draft);
  const layout = stored ?? seed;
  return {
    draft: {
      layout,
      version: row?.draftVersion ?? null,
      updatedAt: row?.draftUpdatedAt.toISOString() ?? null,
      updatedByAdminId: row?.draftUpdatedByAdminId ?? null,
      restoredFrom: row?.draftRestoredFrom ?? null,
      differsFromPublished:
        published === null || published.layout === null
          ? true
          : !explicitMainMenusEqual(layout, published.layout),
      storedValueInvalid: row !== null && stored === null,
    },
    published,
  };
}

function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' ? actor.id : null;
}

function conflict(expected: Record<string, unknown>) {
  return errors.conflict(
    CONTROL_ERROR_CODES.VERSION_CONFLICT,
    'The main menu changed while you were editing it. Reload and reapply your change.',
    expected,
  );
}
