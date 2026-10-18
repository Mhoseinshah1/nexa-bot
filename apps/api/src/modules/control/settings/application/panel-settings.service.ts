import {
  CONTROL_ERROR_CODES,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  isSettingKey,
  parseSettingValue,
  setPanelSettingRequestSchema,
  settingScope,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PanelSettingSource,
  type PermissionKey,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelSettingRepository } from './ports.js';
import {
  invalidPanelSettingDedupeKey,
  type PanelSettingsResolver,
  type ResolvedPanelSetting,
} from './panel-settings-resolver.js';
import { INVALID_STORED_SETTING_CODE } from './settings-resolver.js';

/** Reading a panel's settings is reading the panel. */
export const PANEL_SETTINGS_VIEW: PermissionKey = 'panels.view';
/** Changing one is editing the panel — as its trial and its policy are. */
export const PANEL_SETTINGS_EDIT: PermissionKey = 'panels.edit';

export interface PanelSettingsServiceDeps {
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly settings: PanelSettingRepository;
  readonly resolver: PanelSettingsResolver;
  readonly panels: Pick<PanelRepository, 'find' | 'lockPanel'>;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly scopeActivity: ScopeActivityReader;
  /** The RAW recorder, for the reason `SettingsService` gives. */
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
}

/** What a completed write stores for its key: the FIRST result, JSON-native. */
interface PanelSettingReplayRecord {
  readonly changed: boolean;
  readonly value: unknown;
  readonly source: PanelSettingSource;
  readonly version: number | null;
  readonly updatedAt: string | null;
  readonly updatedByAdminId: string | null;
  readonly storedValueInvalid: boolean;
}

export interface SetPanelSettingResult {
  readonly setting: ResolvedPanelSetting;
  readonly changed: boolean;
  readonly replayed: boolean;
}

/**
 * Track 3 §2: one panel's PANEL-scoped settings, for an operator — the «فایل‌های اتصال»
 * section of the panel's page.
 *
 * The tenant `SettingsService`'s write path with a panel named, and every rule of it kept:
 * authorize before parsing, unknown keys fail closed (and so does a TENANT key — it has no
 * per-panel value), the value is parsed by the key's own declared schema (so the caption
 * template's unknown variables are refused HERE, whatever the form did), the replay
 * returns the first result, the expectation is checked before the no-op shortcut, the
 * version check is in the write's statement, and the audit row, the outbox event and the
 * idempotency record share the write's transaction. Like the panel's trial, the panel's
 * row lock is taken first and an archived panel is refused.
 */
export class PanelSettingsService {
  constructor(private readonly deps: PanelSettingsServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
  ): Promise<ResolvedPanelSetting[]> {
    await this.deps.guard.check(scope, actor, PANEL_SETTINGS_VIEW);
    const id = this.panelId(panelId);
    if ((await this.deps.panels.find(scope, id)) === null) {
      throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
    }
    return this.deps.resolver.resolveAll(scope, id);
  }

  async set(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    rawKey: string,
    input: unknown,
  ): Promise<SetPanelSettingResult> {
    const denial = { action: 'panel.setting_set', entityType: 'Panel', entityId: panelId };
    try {
      await this.deps.guard.check(scope, actor, PANEL_SETTINGS_EDIT);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        PANEL_SETTINGS_EDIT,
        denial,
        error,
      );
      throw error;
    }
    const id = this.panelId(panelId);
    const key = requirePanelKey(rawKey);
    const command = setPanelSettingRequestSchema.safeParse(input);
    if (!command.success) {
      throw errors.validation(CONTROL_ERROR_CODES.INVALID_VALUE, 'The request is not valid.', {
        key,
        issues: command.error.issues.map((issue) => issue.message),
      });
    }
    const parsed = parseSettingValue(key, command.data.value);
    if (!parsed.ok) {
      throw errors.validation(
        CONTROL_ERROR_CODES.INVALID_VALUE,
        `The value for ${key} does not match its declaration.`,
        { key, issues: parsed.issues },
      );
    }
    const value = parsed.value;
    const expectedVersion = command.data.expectedVersion;
    const requestHash = hashRequest({ panelId: id, key, value, expectedVersion });
    const existing = await this.deps.idempotency.find<PanelSettingReplayRecord>(
      scope,
      actor.surface,
      command.data.idempotencyKey,
      requestHash,
    );
    if (existing) {
      return {
        setting: fromReplay(await this.deps.resolver.resolve(scope, id, key), existing.result),
        changed: existing.result.changed,
        replayed: true,
      };
    }

    const result = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANEL_SETTINGS_EDIT,
      { ...denial, entityId: id },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        // The panel row first, the one lock every panel mutation takes first.
        if (!(await this.deps.panels.lockPanel(scope, id, tx))) {
          throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
        }
        const view = await this.deps.panels.find(scope, id, tx);
        if (view === null) {
          throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
        }
        if (view.panel.status === 'ARCHIVED') {
          throw errors.preconditionFailed(
            PANEL_ERROR_CODES.PANEL_ARCHIVED,
            'This panel is archived. Restore it before editing.',
          );
        }

        const before = await this.deps.resolver.resolve(scope, id, key, tx);
        // Before the no-op shortcut, for the reason `SettingsService.set` gives: the
        // shortcut never runs the conditional statement that would otherwise decide it.
        if (before.version !== expectedVersion) {
          throw errors.conflict(
            CONTROL_ERROR_CODES.VERSION_CONFLICT,
            `${key} changed while you were editing it. Reload and reapply your change.`,
            { key, expectedVersion },
          );
        }
        if (before.source === 'PANEL' && deepEqual(before.value, value)) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            command.data.idempotencyKey,
            requestHash,
            toReplay(before, false),
            tx,
          );
          return { setting: before, changed: false };
        }

        const written = await this.deps.settings.upsert(
          scope,
          {
            id: this.deps.ids.uuid(),
            panelId: id,
            key,
            value,
            expectedVersion,
            now: this.deps.clock.now(),
            adminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
          },
          tx,
        );
        if (written === null) {
          throw errors.conflict(
            CONTROL_ERROR_CODES.VERSION_CONFLICT,
            `${key} changed while you were editing it. Reload and reapply your change.`,
            { key, expectedVersion },
          );
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.setting_set',
            entityType: 'Panel',
            entityId: id,
            // Values: a caption template is not a secret, and the record must still mean
            // something after the row changes again.
            before: { key, value: before.value, source: before.source },
            after: { key, value: written.value, source: 'PANEL' },
            result: 'SUCCESS',
          },
          tx,
        );
        // The catalogued event and payload. The aggregate is this panel's value of this
        // key, so its sequence is its own and a reader can tell which panel changed.
        await this.deps.outbox.write(tx, actor, {
          eventType: 'SettingChanged',
          aggregateType: 'Setting',
          aggregateId: `panel:${id}:${key}`,
          payload: { key, from: before.value, to: written.value },
        });
        if (before.storedValueInvalid) {
          await this.deps.opsLog.record(
            scope,
            {
              code: 'settings.stored_value_valid',
              severity: 'INFO',
              message: `The stored value for ${key} on panel ${id} parses again.`,
              context: { key, panelId: id },
              recoversCode: INVALID_STORED_SETTING_CODE,
              recoversDedupeKey: invalidPanelSettingDedupeKey(id, key),
            },
            tx,
          );
        }
        const setting = await this.deps.resolver.resolve(scope, id, key, tx);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.data.idempotencyKey,
          requestHash,
          toReplay(setting, true),
          tx,
        );
        return { setting, changed: true };
      },
    );
    return { ...result, replayed: false };
  }

  private panelId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
    }
    return parsed.data;
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

/**
 * Widens a string into a PANEL-scoped key, or refuses it as unknown. A TENANT key is as
 * unknown here as a misspelt one: it has no per-panel value to read or write.
 */
function requirePanelKey(key: string): SettingKey {
  if (!isSettingKey(key) || settingScope(key) !== 'PANEL') {
    throw errors.notFound(CONTROL_ERROR_CODES.UNKNOWN_KEY, `No such panel setting: ${key}.`);
  }
  return key;
}

function toReplay(setting: ResolvedPanelSetting, changed: boolean): PanelSettingReplayRecord {
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

/** The first result, on the key's registry facts (which cannot change without a release). */
function fromReplay(
  current: ResolvedPanelSetting,
  record: PanelSettingReplayRecord,
): ResolvedPanelSetting {
  return {
    ...current,
    value: record.value,
    source: record.source,
    version: record.version,
    updatedAt: record.updatedAt === null ? null : new Date(record.updatedAt),
    updatedByAdminId: record.updatedByAdminId,
    storedValueInvalid: record.storedValueInvalid,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
