import { z } from 'zod';
import {
  CONTROL_ERROR_CODES,
  errors,
  isTemplateKey,
  PLATFORM_ERROR_CODES,
  TEMPLATES,
  TEMPLATE_BODY_MAX_LENGTH,
  templateDefinition,
  validateTemplateBody,
  validateTemplateValues,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type PermissionKey,
  type PlaceholderDefinition,
  type ScopeContext,
  type TemplateFormat,
  type TemplateKey,
  type TemplateValues,
  type UnitOfWork,
} from '@nexa/contracts';

import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { FeatureFlagResolver } from '../../features/application/feature-flags.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TemplateCatalogue, TemplateRepository, TemplateRevision } from './ports.js';
import { DEFAULT_TEMPLATE_LOCALE, type Locale } from './template-resolver.js';

export const TEMPLATES_VIEW: PermissionKey = 'templates.view';
export const TEMPLATES_EDIT: PermissionKey = 'templates.edit';

/**
 * One key as an administrator sees it.
 *
 * `body` and `defaultBody` are both RAW. Nothing on this object has been
 * rendered, and the edit field is populated from `body`. Rendering is a separate
 * call that returns a value and stores nothing — the legacy edit screen shows
 * the rendered form, which is why its raw template cannot be read back at all.
 */
export interface TemplateView {
  readonly key: TemplateKey;
  readonly locale: string;
  readonly description: string;
  readonly format: TemplateFormat;
  readonly placeholders: readonly PlaceholderDefinition[];
  readonly maxLength: number;
  /** The body in force — what a customer would actually receive. */
  readonly body: string;
  /**
   * The tenant's raw override, if one is stored, whether or not it is applied.
   *
   * This is what an edit field is populated from. It is separate from `body`
   * because they differ when overrides are switched off: the message being sent
   * is the default while the thing being edited is still the override, and
   * conflating them would show an administrator the default in the editor and
   * then save it as their override — an override that had never been typed.
   */
  readonly overrideBody: string | null;
  readonly defaultBody: string;
  readonly source: 'DEFAULT' | 'TENANT';
  /** An override exists but is not being applied, because the flag is off. */
  readonly overrideSuppressed: boolean;
  /** Null when there is no override: no row, so no version to state. */
  readonly version: number | null;
  readonly revision: number | null;
  readonly updatedAt: Date | null;
  readonly updatedByAdminId: string | null;
}

export const setTemplateCommandSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  key: z.string().min(1),
  body: z.string().min(1).max(TEMPLATE_BODY_MAX_LENGTH),
  expectedVersion: z.number().int().positive().nullable(),
});

export const revertTemplateCommandSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  key: z.string().min(1),
  expectedVersion: z.number().int().positive(),
});

export const previewTemplateCommandSchema = z.object({
  key: z.string().min(1),
  /** The body being edited, so a preview shows what is on screen, not what is stored. */
  body: z.string().max(TEMPLATE_BODY_MAX_LENGTH),
  /** Caller-supplied sample values. Never taken from the acting administrator. */
  values: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});

export interface SetTemplateResult {
  readonly template: TemplateView;
  readonly revision: number;
  /** False when the submitted body was already the stored one. */
  readonly changed: boolean;
  readonly replayed: boolean;
}

export interface PreviewResult {
  readonly rendered: string;
  /** Placeholders left un-substituted because the caller supplied no value. */
  readonly unresolved: readonly string[];
}

export class TemplateManagementService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly uow: UnitOfWork<TransactionScope>,
    private readonly templates: TemplateRepository,
    private readonly features: FeatureFlagResolver,
    private readonly catalogue: TemplateCatalogue,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly scopeActivity: ScopeActivityReader,
  ) {}

  async list(
    scope: ScopeContext,
    actor: ActorContext,
    locale: Locale = DEFAULT_TEMPLATE_LOCALE,
  ): Promise<TemplateView[]> {
    await this.guard.check(scope, actor, TEMPLATES_VIEW);
    const overrides = new Map(
      (await this.templates.findOverrides(scope, locale)).map((row) => [row.key, row]),
    );
    const applied = await this.overridesApplied(scope);

    return TEMPLATES.map((definition) => {
      const key = definition.key as TemplateKey;
      return this.toView(key, locale, overrides.get(key) ?? null, applied);
    });
  }

  async get(
    scope: ScopeContext,
    actor: ActorContext,
    key: string,
    locale: Locale = DEFAULT_TEMPLATE_LOCALE,
  ): Promise<TemplateView> {
    await this.guard.check(scope, actor, TEMPLATES_VIEW);
    const templateKey = this.requireKey(key);
    const override = await this.templates.findOverride(scope, templateKey, locale);
    return this.toView(templateKey, locale, override, await this.overridesApplied(scope));
  }

  async revisions(
    scope: ScopeContext,
    actor: ActorContext,
    key: string,
    locale: Locale = DEFAULT_TEMPLATE_LOCALE,
    limit = 50,
  ): Promise<TemplateRevision[]> {
    await this.guard.check(scope, actor, TEMPLATES_VIEW);
    return this.templates.listRevisions(
      scope,
      this.requireKey(key),
      locale,
      Math.min(Math.max(limit, 1), 200),
    );
  }

  /**
   * Renders a body with caller-supplied sample values, and stores nothing.
   *
   * The values come from the request, never from the acting administrator's own
   * context. That is the entire distance between this and the legacy edit
   * screen: there, `{first_name}` resolves to the viewing admin's name, so the
   * screen shows something that is not the template, and saving it would store
   * something that is not the template either.
   */
  async preview(scope: ScopeContext, actor: ActorContext, input: unknown): Promise<PreviewResult> {
    await this.guard.check(scope, actor, TEMPLATES_VIEW);
    const command = previewTemplateCommandSchema.parse(input);
    const key = this.requireKey(command.key);
    const definition = templateDefinition(key);

    const issues = validateTemplateBody(definition, command.body);
    if (issues.length > 0) {
      throw errors.validation(
        CONTROL_ERROR_CODES.TEMPLATE_INVALID,
        `This body cannot be rendered for ${key}.`,
        { key, issues },
      );
    }

    const values = command.values as TemplateValues;
    // Types are checked for the values that WERE supplied; absent ones are
    // reported as unresolved below rather than refused. A preview with no sample
    // values is the normal first thing an administrator does.
    const typeProblems = validateTemplateValues(definition, values, { requireAll: false });
    if (typeProblems.length > 0) {
      throw errors.validation(
        CONTROL_ERROR_CODES.INVALID_VALUE,
        'The sample values do not match the declared placeholder types.',
        { key, issues: typeProblems },
      );
    }

    const rendered = this.catalogue.render(
      definition,
      command.body,
      values,
      DEFAULT_TEMPLATE_LOCALE,
    );
    const unresolved = definition.placeholders
      .map((placeholder) => placeholder.token)
      .filter((token) => values[token] === undefined && command.body.includes(`{${token}}`));

    return { rendered, unresolved };
  }

  async set(scope: ScopeContext, actor: ActorContext, input: unknown): Promise<SetTemplateResult> {
    const command = await this.authorizedCommand(scope, actor, 'templates.set', () =>
      setTemplateCommandSchema.parse(input),
    );
    const key = this.requireKey(command.key);
    const definition = templateDefinition(key);
    const locale = DEFAULT_TEMPLATE_LOCALE;

    // Validation refuses; it never repairs. A token this key does not declare
    // would otherwise be sent to customers as literal text, permanently and
    // visibly, and reported as a bug by them rather than caught here.
    const issues = validateTemplateBody(definition, command.body);
    if (issues.length > 0) {
      throw errors.validation(
        CONTROL_ERROR_CODES.TEMPLATE_INVALID,
        `This body is not valid for ${key}.`,
        { key, issues },
      );
    }

    const requestHash = hashRequest({
      key,
      body: command.body,
      expectedVersion: command.expectedVersion,
    });
    const existing = await this.idempotency.find<Omit<SetTemplateResult, 'replayed'>>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) return { ...existing.result, replayed: true };

    const result = await this.uow.run(scope, async (tx) => {
      await this.requireActiveScope(scope, tx);

      const before = await this.templates.findOverride(scope, key, locale, tx);

      // Saving the same body again is not a change, and must not become one.
      //
      // Without this, re-pressing save writes a revision identical to the last,
      // bumps the version, and invalidates every other editor's expectation for
      // no reason — turning the history into a record of how many times somebody
      // pressed a button rather than of what the message said.
      if (before !== null && before.body === command.body) {
        const template = this.toView(key, locale, before, await this.overridesApplied(scope, tx));
        const unchanged = { template, revision: before.revision, changed: false };
        await this.idempotency.remember(
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          unchanged,
          tx,
        );
        return unchanged;
      }

      const revision = (await this.templates.latestRevision(scope, key, locale, tx)) + 1;

      // The override write goes FIRST, so a concurrent edit is refused by the
      // version predicate before a revision number is claimed. The other order
      // would surface a raw unique-index violation on the revision instead of a
      // conflict that names what happened.
      const written = await this.templates.upsertOverride(
        scope,
        {
          id: this.ids.uuid(),
          key,
          locale,
          body: command.body,
          revision,
          expectedVersion: command.expectedVersion,
          now: this.clock.now(),
          adminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
        },
        tx,
      );
      if (written === null) {
        throw errors.conflict(
          CONTROL_ERROR_CODES.VERSION_CONFLICT,
          `${key} changed while you were editing it. Reload and reapply your change.`,
          { key, expectedVersion: command.expectedVersion },
        );
      }

      await this.templates.appendRevision(
        scope,
        {
          id: this.ids.uuid(),
          key,
          locale,
          revision,
          action: 'SET',
          body: command.body,
          now: this.clock.now(),
          adminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
        },
        tx,
      );

      await this.audit.record(
        scope,
        actor,
        {
          action: 'templates.set',
          entityType: 'Template',
          entityId: key,
          before: before ? { body: before.body, revision: before.revision } : null,
          after: { body: command.body, revision },
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'TemplateOverrideChanged',
        aggregateType: 'Template',
        aggregateId: key,
        payload: {
          key,
          locale,
          revision,
          previousRevision: before ? before.revision : null,
        },
      });

      const template = this.toView(key, locale, written, await this.overridesApplied(scope, tx));
      await this.idempotency.remember(
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        { template, revision, changed: true },
        tx,
      );
      return { template, revision, changed: true };
    });

    return { ...result, replayed: false };
  }

  /**
   * Removes the tenant's override.
   *
   * It does NOT copy the current default into tenant storage. The revision
   * history survives, and the revert is itself a revision, so "what did this say
   * last Tuesday" is still answerable afterwards.
   */
  async revert(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<SetTemplateResult> {
    const command = await this.authorizedCommand(scope, actor, 'templates.revert', () =>
      revertTemplateCommandSchema.parse(input),
    );
    const key = this.requireKey(command.key);
    const locale = DEFAULT_TEMPLATE_LOCALE;

    const requestHash = hashRequest({ key, expectedVersion: command.expectedVersion });
    const existing = await this.idempotency.find<Omit<SetTemplateResult, 'replayed'>>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) return { ...existing.result, replayed: true };

    const result = await this.uow.run(scope, async (tx) => {
      await this.requireActiveScope(scope, tx);

      const removed = await this.templates.deleteOverride(
        scope,
        { key, locale, expectedVersion: command.expectedVersion },
        tx,
      );
      if (removed === null) {
        // Two different situations, and they deserve different answers: nothing
        // to revert, or somebody edited it while this was being decided.
        const current = await this.templates.findOverride(scope, key, locale, tx);
        if (current === null) {
          throw errors.notFound(
            CONTROL_ERROR_CODES.TEMPLATE_NOT_OVERRIDDEN,
            `${key} has no override to revert; it is already using the default.`,
            { key },
          );
        }
        throw errors.conflict(
          CONTROL_ERROR_CODES.VERSION_CONFLICT,
          `${key} changed while you were reverting it. Reload and decide again.`,
          { key, expectedVersion: command.expectedVersion },
        );
      }

      const revision = (await this.templates.latestRevision(scope, key, locale, tx)) + 1;
      await this.templates.appendRevision(
        scope,
        {
          id: this.ids.uuid(),
          key,
          locale,
          revision,
          action: 'REVERT',
          // A REVERT stores no body. Reverting means going back to the default,
          // not taking a copy of whatever the default happens to say today.
          body: null,
          now: this.clock.now(),
          adminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
        },
        tx,
      );

      await this.audit.record(
        scope,
        actor,
        {
          action: 'templates.revert',
          entityType: 'Template',
          entityId: key,
          before: { body: removed.body, revision: removed.revision },
          after: null,
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'TemplateOverrideReverted',
        aggregateType: 'Template',
        aggregateId: key,
        payload: { key, locale, revision },
      });

      const template = this.toView(key, locale, null, await this.overridesApplied(scope, tx));
      await this.idempotency.remember(
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        { template, revision, changed: true },
        tx,
      );
      return { template, revision, changed: true };
    });

    return { ...result, replayed: false };
  }

  private async authorizedCommand<T>(
    scope: ScopeContext,
    actor: ActorContext,
    action: string,
    parse: () => T,
  ): Promise<T> {
    try {
      await this.guard.check(scope, actor, TEMPLATES_EDIT);
    } catch (denial) {
      await this.audit.record(scope, actor, {
        action,
        entityType: 'Template',
        entityId: null,
        before: null,
        after: null,
        result: 'DENIED',
      });
      throw denial;
    }
    return parse();
  }

  private async requireActiveScope(scope: ScopeContext, tx: unknown): Promise<void> {
    if (!(await this.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
        'This scope is not accepting work.',
      );
    }
  }

  /**
   * Whether this tenant's overrides are being applied at all.
   *
   * Asked once per request rather than per key: it is one flag, and reading it
   * six times to answer one question would be six round trips for one boolean.
   */
  private async overridesApplied(scope: ScopeContext, tx?: unknown): Promise<boolean> {
    return this.features.isEnabled(scope, 'template_overrides', tx);
  }

  private toView(
    key: TemplateKey,
    locale: Locale,
    override: {
      body: string;
      version: number;
      revision: number;
      updatedAt: Date;
      updatedByAdminId: string | null;
    } | null,
    overridesApplied: boolean,
  ): TemplateView {
    const definition = templateDefinition(key);
    const fallback = this.catalogue.defaultBody(key, locale);
    const applied = override !== null && overridesApplied;
    return {
      key,
      locale,
      description: definition.description,
      format: definition.format,
      placeholders: definition.placeholders,
      maxLength: TEMPLATE_BODY_MAX_LENGTH,
      body: applied ? override.body : fallback,
      overrideBody: override?.body ?? null,
      defaultBody: fallback,
      source: applied ? 'TENANT' : 'DEFAULT',
      overrideSuppressed: override !== null && !overridesApplied,
      version: override?.version ?? null,
      revision: override?.revision ?? null,
      updatedAt: override?.updatedAt ?? null,
      updatedByAdminId: override?.updatedByAdminId ?? null,
    };
  }

  private requireKey(key: string): TemplateKey {
    if (!isTemplateKey(key)) {
      throw errors.notFound(CONTROL_ERROR_CODES.UNKNOWN_KEY, `No such template: ${key}.`);
    }
    return key;
  }
}
