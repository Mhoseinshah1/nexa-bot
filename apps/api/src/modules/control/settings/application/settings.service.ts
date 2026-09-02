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
  type OperationalEventRecorder,
  type SettingKey,
  type SettingSource,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingRepository } from './ports.js';
import { INVALID_STORED_SETTING_CODE } from './settings-resolver.js';
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

/**
 * What a completed write stores for its idempotency key.
 *
 * A SNAPSHOT of what this command produced, and JSON-native throughout: no
 * Date, no class instance, nothing whose type changes on the way through
 * `jsonb`. `updatedAt` is an ISO string here and is parsed back on the way out.
 *
 * Two wrong answers were tried before this one, in both directions.
 *
 * Storing the `ResolvedSetting` object whole put a `Date` into `jsonb`; it came
 * back a string, the controller called `.toISOString()` on it, and the cheapest
 * possible success answered 500.
 *
 * Storing only `changed` and RE-READING the row on replay fixed that and broke
 * something worse: the reply then described whatever the key holds NOW. An
 * administrator whose response was lost, retrying after a colleague changed the
 * same key, was told their command had succeeded with the colleague's value —
 * "success for a write that did not happen", reached from the other direction,
 * and `docs/conventions.md` says plainly that a replay returns the FIRST
 * result.
 *
 * So the snapshot carries everything the response is built from, and the
 * registry supplies the rest, which cannot have changed without a release.
 */
export interface SettingReplayRecord {
  readonly changed: boolean;
  readonly value: unknown;
  readonly source: SettingSource;
  readonly version: number | null;
  /** ISO-8601, because a Date does not survive `jsonb`. */
  readonly updatedAt: string | null;
  readonly updatedByAdminId: string | null;
  readonly storedValueInvalid: boolean;
}

export function toReplayRecord(setting: ResolvedSetting, changed: boolean): SettingReplayRecord {
  return {
    changed,
    value: setting.value,
    source: setting.source,
    version: setting.version,
    updatedAt: setting.updatedAt?.toISOString() ?? null,
    updatedByAdminId: setting.updatedByAdminId,
    storedValueInvalid: setting.storedValueInvalid,
  };
}

export function fromReplayRecord(key: SettingKey, record: SettingReplayRecord): ResolvedSetting {
  const definition = settingDefinition(key);
  return {
    key,
    value: record.value,
    source: record.source,
    version: record.version,
    updatedAt: record.updatedAt === null ? null : new Date(record.updatedAt),
    updatedByAdminId: record.updatedByAdminId,
    storedValueInvalid: record.storedValueInvalid,
    // From the registry, not from the snapshot: these are properties of the
    // KEY rather than of the write, and they cannot change without a release.
    description: definition.description,
    zeroMeaning: definition.zeroMeaning,
    mutability: definition.mutability,
    classification: definition.classification,
    configures: definition.configures,
  };
}

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
    /**
     * The RAW recorder, not the projecting one.
     *
     * This writes a recovery for a condition the resolver opened, inside the
     * repair's own transaction. It must not go through the projector: that
     * reads settings to decide whether to notify, and reading this very key is
     * what opened the condition.
     */
    private readonly opsLog: OperationalEventRecorder,
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
    // A replay returns the FIRST result, rebuilt from the snapshot. See
    // `SettingReplayRecord` for the two wrong answers this is between.
    const existing = await this.idempotency.find<SettingReplayRecord>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) {
      return {
        setting: fromReplayRecord(key, existing.result),
        changed: existing.result.changed,
        replayed: true,
      };
    }

    const result = await this.uow.run(scope, async (tx) => {
      if (!(await this.scopeActivity.scopeIsActive(scope, tx))) {
        throw errors.notFound(
          PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
          'This scope is not accepting work.',
        );
      }

      const before = await this.resolver.resolve(scope, key, tx);

      // The expectation is checked before the no-op shortcut below, and this
      // is the one place in this module where a check precedes its statement.
      //
      // It has to. The shortcut RETURNS without executing the conditional
      // update, so the predicate that normally decides the question never runs
      // — and a request built on state that has since moved was accepted as "no
      // change" whenever its value happened to coincide with what is there now.
      // A caller who read the key as unset, or who read a version two writes
      // ago, was told their expectation held. That is the same lie as accepting
      // the write, minus the write.
      //
      // It is NOT the authority, and nothing here relies on it being one: the
      // path that writes still carries the predicate in its own statement, so a
      // change landing between this read and that statement is caught there.
      // This only decides whether the shortcut is available.
      if (before.version !== command.expectedVersion) {
        throw errors.conflict(
          CONTROL_ERROR_CODES.VERSION_CONFLICT,
          `${key} changed while you were editing it. Reload and reapply your change.`,
          { key, expectedVersion: command.expectedVersion },
        );
      }

      // A write that changes nothing is reported as changing nothing. Three
      // unrelated legacy subsystems answer "✅ updated" to a write that touched
      // no row, and one of them did it three times in a row while a product
      // stayed broken (SOURCE_BUG-002).
      if (before.source === 'TENANT' && deepEqual(before.value, value)) {
        // The key is still consumed. A no-op is a completed command, and a key
        // that is never stored is a key whose reuse with DIFFERENT input cannot
        // be detected — the payload-mismatch check has nothing to compare
        // against until a record exists.
        await rememberOnce(
          this.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          toReplayRecord(before, false),
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

      // A repaired key CLOSES the condition its own invalidity opened.
      //
      // `SettingsResolver` records `settings.stored_value_invalid` every time
      // it meets a value that no longer parses, deduplicated onto one row. That
      // row has no other way to be resolved — nothing else knows the value
      // became valid again — so without this the warning stays open for ever
      // and keeps appearing in the operations view's unresolved filter, which
      // is the "a fixed problem still looks broken" failure the recovery
      // mechanism exists for.
      //
      // In the repair's transaction, so the recovery cannot survive a rollback
      // of the write that earned it.
      if (before.storedValueInvalid) {
        await this.opsLog.record(
          scope,
          {
            code: 'settings.stored_value_valid',
            severity: 'INFO',
            message: `The stored value for ${key} parses again.`,
            context: { key },
            recoversCode: INVALID_STORED_SETTING_CODE,
          },
          tx,
        );
      }

      const setting = await this.resolver.resolve(scope, key, tx);
      await rememberOnce(
        this.idempotency,
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        toReplayRecord(setting, true),
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
