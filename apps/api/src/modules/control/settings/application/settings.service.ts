import { z } from 'zod';
import {
  errors,
  isSettingKey,
  parseSettingValue,
  settingDefinition,
  CONTROL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type PermissionKey,
  type ScopeContext,
  type SettingKey,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingRepository } from './ports.js';
import type { ResolvedSetting, SettingsResolver } from './settings-resolver.js';

export const SETTINGS_VIEW: PermissionKey = 'settings.view';
export const SETTINGS_EDIT: PermissionKey = 'settings.edit';

/**
 * The command to change one setting.
 *
 * `expectedVersion` is required, not optional. An optional one becomes an
 * omitted one, and an omitted one is last-writer-wins with extra steps — which
 * is the legacy behaviour: two administrators on the same screen, and the second
 * save silently discards the first with nothing to notice it by.
 *
 * `null` states "I read this key as unset". It is an expectation like any other
 * and is checked like any other.
 */
export const setSettingCommandSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  key: z.string().min(1),
  value: z.unknown(),
  expectedVersion: z.number().int().positive().nullable(),
});
export type SetSettingCommand = z.infer<typeof setSettingCommandSchema>;

export interface SetSettingResult {
  readonly setting: ResolvedSetting;
  /** False when the submitted value already matched the stored one. */
  readonly changed: boolean;
  readonly replayed: boolean;
}

export class SettingsService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly uow: UnitOfWork<TransactionScope>,
    private readonly settings: SettingRepository,
    private readonly resolver: SettingsResolver,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly scopeActivity: ScopeActivityReader,
  ) {}

  /**
   * Every registered setting, with its value, its resolved source and what zero
   * means for it.
   *
   * There is no "write to find out" path anywhere in this module. That is the
   * rule `docs/conventions.md` has carried since Phase 0 with an "Enforced by:
   * nothing yet" note against it.
   */
  async list(scope: ScopeContext, actor: ActorContext): Promise<ResolvedSetting[]> {
    await this.guard.check(scope, actor, SETTINGS_VIEW);
    return this.resolver.resolveAll(scope);
  }

  async get(scope: ScopeContext, actor: ActorContext, key: string): Promise<ResolvedSetting> {
    await this.guard.check(scope, actor, SETTINGS_VIEW);
    return this.resolver.resolve(scope, this.requireKey(key));
  }

  async set(scope: ScopeContext, actor: ActorContext, input: unknown): Promise<SetSettingResult> {
    try {
      await this.guard.check(scope, actor, SETTINGS_EDIT);
    } catch (denial) {
      await this.audit.record(scope, actor, {
        action: 'settings.set',
        entityType: 'Setting',
        entityId: null,
        before: null,
        after: null,
        result: 'DENIED',
      });
      throw denial;
    }

    const command = setSettingCommandSchema.parse(input);
    const key = this.requireKey(command.key);

    const parsed = parseSettingValue(key, command.value);
    if (!parsed.ok) {
      throw errors.validation(
        CONTROL_ERROR_CODES.INVALID_VALUE,
        `The value for ${key} does not match its declaration.`,
        { key, issues: parsed.issues },
      );
    }
    const value = parsed.value;

    const requestHash = hashRequest({ key, value, expectedVersion: command.expectedVersion });
    const existing = await this.idempotency.find<Omit<SetSettingResult, 'replayed'>>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) return { ...existing.result, replayed: true };

    const result = await this.uow.run(scope, async (tx) => {
      if (!(await this.scopeActivity.scopeIsActive(scope, tx))) {
        throw errors.notFound(
          PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
          'This scope is not accepting work.',
        );
      }

      const before = await this.resolver.resolve(scope, key, tx);

      // A write that changes nothing is reported as changing nothing. Three
      // unrelated legacy subsystems answer "✅ updated" to a write that touched
      // no row, and one of them did it three times in a row while a product
      // stayed broken (SOURCE_BUG-002).
      if (before.source === 'TENANT' && deepEqual(before.value, value)) {
        // The key is still consumed. A no-op is a completed command, and a key
        // that is never stored is a key whose reuse with DIFFERENT input cannot
        // be detected — the payload-mismatch check has nothing to compare
        // against until a record exists.
        await this.idempotency.remember(
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { setting: before, changed: false },
          tx,
        );
        return { setting: before, changed: false };
      }

      const written = await this.settings.upsert(
        scope,
        {
          id: this.ids.uuid(),
          key,
          value,
          expectedVersion: command.expectedVersion,
          now: this.clock.now(),
          adminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
        },
        tx,
      );

      if (written === null) {
        // Zero rows matched the expectation. Somebody else wrote between the
        // read and this statement — the check being IN the statement is what
        // makes that detectable rather than silently lost.
        throw errors.conflict(
          CONTROL_ERROR_CODES.VERSION_CONFLICT,
          `${key} changed while you were editing it. Reload and reapply your change.`,
          { key, expectedVersion: command.expectedVersion },
        );
      }

      await this.audit.record(
        scope,
        actor,
        {
          action: 'settings.set',
          entityType: 'Setting',
          entityId: key,
          // Values, not references: the record still means something after the
          // row changes again.
          before: { value: before.value, source: before.source },
          after: { value: written.value, source: 'TENANT' },
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'SettingChanged',
        aggregateType: 'Setting',
        aggregateId: key,
        payload: { key, from: before.value, to: written.value },
      });

      const setting = await this.resolver.resolve(scope, key, tx);
      await this.idempotency.remember(
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        { setting, changed: true },
        tx,
      );
      return { setting, changed: true };
    });

    return { ...result, replayed: false };
  }

  /**
   * Widens a string into a key, or refuses.
   *
   * Unknown keys fail closed at every layer that can be reached from outside.
   * In the legacy system a settings write is an FSM prompt that takes whatever
   * arrives next, which is how an ordinary chat message became a production
   * gateway setting (INCIDENT-FIN-001).
   */
  private requireKey(key: string): SettingKey {
    if (!isSettingKey(key)) {
      throw errors.notFound(CONTROL_ERROR_CODES.UNKNOWN_KEY, `No such setting: ${key}.`);
    }
    // Throws if the registry and the type guard ever disagree.
    settingDefinition(key);
    return key;
  }
}

/** Structural equality for parsed setting values, which are JSON-shaped. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
