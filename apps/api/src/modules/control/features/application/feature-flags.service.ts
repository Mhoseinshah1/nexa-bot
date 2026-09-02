import { z } from 'zod';
import {
  CONTROL_ERROR_CODES,
  errors,
  FEATURE_FLAGS,
  featureFlagDefinition,
  isFeatureFlagKey,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type FeatureFlagKey,
  type FeatureFlagSource,
  type FlagBlastRadius,
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
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type {
  ResolvedSetting,
  SettingsResolver,
} from '../../settings/application/settings-resolver.js';
import {
  fromReplayRecord,
  toReplayRecord,
  type SettingReplayRecord,
} from '../../settings/application/settings.service.js';
import type { FeatureFlagRepository } from './ports.js';

export const FEATURES_VIEW: PermissionKey = 'settings.view';
export const FEATURES_EDIT: PermissionKey = 'settings.edit';

/**
 * A flag, its state, and the settings that parameterise it.
 *
 * The configuration travels WITH the flag rather than living two screens away.
 * The legacy pair — `⚠️ اعلان کاهش موجودی` in one menu and `⚠️ مبلغ هشدار موجودی`
 * in another — produced the recorded outcome that the flag is off, so the value
 * is inert, and nothing on either screen says so (CBR-007, GSR-008).
 */
export interface ResolvedFeatureFlag {
  readonly key: FeatureFlagKey;
  readonly enabled: boolean;
  readonly source: FeatureFlagSource;
  readonly version: number | null;
  readonly updatedAt: Date | null;
  readonly updatedByAdminId: string | null;
  readonly reason: string | null;
  readonly description: string;
  readonly blastRadius: FlagBlastRadius;
  /**
   * The settings this flag governs, each marked with whether it currently does
   * anything. `inert` is the honest half of GSR-008's recommendation: a value
   * that cannot take effect says so instead of looking configured.
   */
  readonly configuration: readonly (ResolvedSetting & { readonly inert: boolean })[];
}

export const setFeatureFlagCommandSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  key: z.string().min(1),
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive().nullable(),
  /**
   * Typed confirmation of the target's identity, for a TENANT_WIDE flag.
   *
   * ADR-0010 asks for confirmation proportional to blast radius, and this is
   * the shape it prescribes for a change that is not merely cosmetic: the
   * operator names what they are changing. In the legacy system the whole-bot
   * kill switch is rendered identically to the dice toggle and takes one press.
   */
  confirmKey: z.string().optional(),
  // TRIMMED before it is measured. `min(3)` accepted three spaces, and the
  // guard below only asks whether a reason is present — so a TENANT_WIDE
  // toggle could commit with an audit row explaining nothing, which is the
  // whole safeguard defeated by the cheapest possible input.
  reason: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(3).max(500))
    .optional(),
});
export type SetFeatureFlagCommand = z.infer<typeof setFeatureFlagCommandSchema>;

/**
 * The snapshot a completed flag write stores against its key.
 *
 * The FLAG as this command left it, JSON-native, for the reasons set out at
 * length on `SettingsService`'s `ReplayRecord`: a stored `Date` comes back a
 * string, and re-reading live state on replay reports whatever somebody else
 * did since.
 *
 * `configuration` is snapshotted TOO, and the argument for leaving it live did
 * not survive contact with the rule. It is a view of settings this command did
 * not write, so reading it fresh felt defensible — but it is part of THIS
 * response, and `docs/conventions.md` says a replay returns the first result
 * without qualifying which half. A reply that mixes the flag as it was with
 * settings as they are now describes a state that never existed, which is the
 * same failure the flag half was snapshotted to avoid.
 */
interface FlagReplayRecord {
  readonly changed: boolean;
  readonly enabled: boolean;
  readonly source: FeatureFlagSource;
  readonly version: number | null;
  /** ISO-8601, because a Date does not survive `jsonb`. */
  readonly updatedAt: string | null;
  readonly updatedByAdminId: string | null;
  readonly reason: string | null;
  readonly configuration: readonly (SettingReplayRecord & {
    readonly key: string;
    readonly inert: boolean;
  })[];
}

function toFlagReplayRecord(flag: ResolvedFeatureFlag, changed: boolean): FlagReplayRecord {
  return {
    changed,
    enabled: flag.enabled,
    source: flag.source,
    version: flag.version,
    updatedAt: flag.updatedAt?.toISOString() ?? null,
    updatedByAdminId: flag.updatedByAdminId,
    reason: flag.reason,
    configuration: flag.configuration.map((setting) => ({
      ...toReplayRecord(setting, changed),
      key: setting.key,
      inert: setting.inert,
    })),
  };
}

export interface SetFeatureFlagResult {
  readonly flag: ResolvedFeatureFlag;
  readonly changed: boolean;
  readonly replayed: boolean;
}

export class FeatureFlagsService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly uow: UnitOfWork<TransactionScope>,
    private readonly flags: FeatureFlagRepository,
    private readonly resolver: FeatureFlagResolver,
    private readonly settings: SettingsResolver,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly scopeActivity: ScopeActivityReader,
  ) {}

  async list(scope: ScopeContext, actor: ActorContext): Promise<ResolvedFeatureFlag[]> {
    await this.guard.check(scope, actor, FEATURES_VIEW);
    const states = await this.resolver.resolveAll(scope);
    const settings = await this.settings.resolveAll(scope);
    return states.map((state) => this.withConfiguration(state, settings));
  }

  async set(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<SetFeatureFlagResult> {
    try {
      await this.guard.check(scope, actor, FEATURES_EDIT);
    } catch (denial) {
      await this.audit.record(scope, actor, {
        action: 'features.set',
        entityType: 'FeatureFlag',
        entityId: null,
        before: null,
        after: null,
        result: 'DENIED',
      });
      throw denial;
    }

    const command = setFeatureFlagCommandSchema.parse(input);
    const key = this.requireKey(command.key);
    const definition = featureFlagDefinition(key);

    if (definition.blastRadius === 'TENANT_WIDE') {
      if (command.confirmKey !== key) {
        throw errors.validation(
          CONTROL_ERROR_CODES.CONFIRMATION_REQUIRED,
          `${key} affects every customer of this tenant. Confirm by naming the flag.`,
          { key, blastRadius: definition.blastRadius },
        );
      }
      if (!command.reason) {
        throw errors.validation(
          CONTROL_ERROR_CODES.CONFIRMATION_REQUIRED,
          `${key} affects every customer of this tenant. A reason is required.`,
          { key },
        );
      }
    }

    // The reason is part of the request, so it is part of the hash.
    //
    // It is persisted and audited, and leaving it out made a retry that carried
    // a DIFFERENT reason look like the same request: the store answered with the
    // first one's result, so the API accepted a reason it never stored. For a
    // TENANT_WIDE toggle the reason is the half a reviewer reads later.
    const requestHash = hashRequest({
      key,
      enabled: command.enabled,
      expectedVersion: command.expectedVersion,
      reason: command.reason ?? null,
    });
    // Re-read on replay; see the same note in `SettingsService`. A stored
    // result carries a Date through `jsonb` and comes back a string.
    const existing = await this.idempotency.find<FlagReplayRecord>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) {
      const record = existing.result;
      // The flag exactly as this command left it; the settings it governs read
      // live, because they are not what this command wrote. `description` and
      // `blastRadius` come from the registry inside `withConfiguration`.
      const state: ResolvedFlagState = {
        key,
        enabled: record.enabled,
        source: record.source,
        version: record.version,
        updatedAt: record.updatedAt === null ? null : new Date(record.updatedAt),
        updatedByAdminId: record.updatedByAdminId,
        reason: record.reason,
      };
      const definition = featureFlagDefinition(key);
      return {
        flag: {
          ...state,
          description: definition.description,
          blastRadius: definition.blastRadius,
          configuration: record.configuration.map((setting) => ({
            ...fromReplayRecord(setting.key as SettingKey, setting),
            inert: setting.inert,
          })),
        },
        changed: record.changed,
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
      const settings = await this.settings.resolveAll(scope, tx);

      // Checked before the no-op shortcut, and for the reason given at length
      // in `SettingsService.set`: the shortcut returns without executing the
      // conditional update, so without this a request built on state that has
      // moved is accepted as "no change" whenever its value coincides. The
      // writing path still carries its own predicate; this only decides whether
      // the shortcut is available.
      if (before.version !== command.expectedVersion) {
        throw errors.conflict(
          CONTROL_ERROR_CODES.VERSION_CONFLICT,
          `${key} changed while you were editing it. Reload and reapply your change.`,
          { key, expectedVersion: command.expectedVersion },
        );
      }

      if (before.source === 'TENANT' && before.enabled === command.enabled) {
        // The key is still consumed; see the same note in `SettingsService`.
        const flag = this.withConfiguration(before, settings);
        await rememberOnce(
          this.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          toFlagReplayRecord(flag, false),
          tx,
        );
        return { flag, changed: false };
      }

      const written = await this.flags.upsert(
        scope,
        {
          id: this.ids.uuid(),
          key,
          enabled: command.enabled,
          expectedVersion: command.expectedVersion,
          reason: command.reason ?? null,
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

      await this.audit.record(
        scope,
        actor,
        {
          action: 'features.set',
          entityType: 'FeatureFlag',
          entityId: key,
          before: { enabled: before.enabled, source: before.source },
          after: { enabled: written.enabled, source: 'TENANT' },
          ...(command.reason ? { reason: command.reason } : {}),
          result: 'SUCCESS',
        },
        tx,
      );

      await this.outbox.write(tx, actor, {
        eventType: 'FeatureFlagChanged',
        aggregateType: 'FeatureFlag',
        aggregateId: key,
        payload: { key, from: before.enabled, to: written.enabled },
      });

      const flag = this.withConfiguration(await this.resolver.resolve(scope, key, tx), settings);
      await rememberOnce(
        this.idempotency,
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        toFlagReplayRecord(flag, true),
        tx,
      );
      return { flag, changed: true };
    });

    return { ...result, replayed: false };
  }

  private withConfiguration(
    state: ResolvedFlagState,
    settings: readonly ResolvedSetting[],
  ): ResolvedFeatureFlag {
    const definition = featureFlagDefinition(state.key);
    const governed = new Set<string>(definition.configuredBy);
    return {
      ...state,
      description: definition.description,
      blastRadius: definition.blastRadius,
      configuration: settings
        .filter((setting) => governed.has(setting.key))
        .map((setting) => ({ ...setting, inert: !state.enabled })),
    };
  }

  private requireKey(key: string): FeatureFlagKey {
    if (!isFeatureFlagKey(key)) {
      throw errors.notFound(CONTROL_ERROR_CODES.UNKNOWN_KEY, `No such feature flag: ${key}.`);
    }
    return key;
  }
}

/**
 * The unguarded half, for code deciding how to behave.
 *
 * Same reasoning as `SettingsResolver`: a worker asking whether a feature is on
 * has no actor to authorize. Tenant scoping still applies on every read.
 */
export interface ResolvedFlagState {
  readonly key: FeatureFlagKey;
  readonly enabled: boolean;
  readonly source: FeatureFlagSource;
  readonly version: number | null;
  readonly updatedAt: Date | null;
  readonly updatedByAdminId: string | null;
  readonly reason: string | null;
}

export class FeatureFlagResolver {
  constructor(private readonly flags: FeatureFlagRepository) {}

  async resolveAll(scope: ScopeContext, tx?: unknown): Promise<ResolvedFlagState[]> {
    const stored = new Map((await this.flags.findAll(scope, tx)).map((row) => [row.key, row]));
    return FEATURE_FLAGS.map((definition) => {
      const key = definition.key as FeatureFlagKey;
      return toState(key, stored.get(key) ?? null);
    });
  }

  async resolve(
    scope: ScopeContext,
    key: FeatureFlagKey,
    tx?: unknown,
  ): Promise<ResolvedFlagState> {
    return toState(key, await this.flags.find(scope, key, tx));
  }

  /** Whether a feature is on. The question most callers actually have. */
  async isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean> {
    return (await this.resolve(scope, key, tx)).enabled;
  }
}

function toState(
  key: FeatureFlagKey,
  row: {
    enabled: boolean;
    version: number;
    updatedAt: Date;
    updatedByAdminId: string | null;
    reason: string | null;
  } | null,
): ResolvedFlagState {
  if (row === null) {
    return {
      key,
      enabled: featureFlagDefinition(key).defaultEnabled,
      source: 'DEFAULT',
      version: null,
      updatedAt: null,
      updatedByAdminId: null,
      reason: null,
    };
  }
  return {
    key,
    enabled: row.enabled,
    source: 'TENANT',
    version: row.version,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
    reason: row.reason,
  };
}
