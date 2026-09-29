import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  parseTrafficInput,
  trafficInputOf,
  updatePanelTrialRequestSchema,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PanelTrialOverviewResponse,
  type PanelTrialResponseBody,
  type PermissionKey,
  type TrafficInputUnit,
  type TenantContext,
  type UnitOfWork,
  type UpdatePanelTrialResponse,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  PanelTrialConfigRecord,
  PanelTrialConfigRepository,
  PanelTrialConfigWrite,
} from './ports.js';
import { trialPanelVerdicts, type TrialOfferDeps } from './trial-offers.js';

/** Reading a panel's trial is reading the panel. */
export const PANEL_TRIAL_VIEW_PERMISSION: PermissionKey = 'panels.view';
/** Changing it is editing the panel — the permission its policy (WP-A8) is written under. */
export const PANEL_TRIAL_EDIT_PERMISSION: PermissionKey = 'panels.edit';

export interface PanelTrialServiceDeps extends TrialOfferDeps {
  readonly configs: PanelTrialConfigRepository;
  readonly panels: Pick<PanelRepository, 'find' | 'findMany' | 'lockPanel'>;
  /** The `trials` switch: while it is off no panel is offered, as the bot answers. */
  readonly features: { isEnabled(scope: TenantContext, key: 'trials'): Promise<boolean> };
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

/**
 * One panel's free trial, for an operator (R1): read it, replace it, and see every
 * panel's at once.
 *
 * The write has the panel policy's shape (WP-A8) and for the same reasons: the guard is
 * charged before the body is parsed, the panel's row lock is taken first, the scope's
 * activity is read inside the transaction, the write names the revision the form was
 * drawn from, a save of what is stored is a no-op that says so, and the audit row carries
 * the values before and after. Nothing here issues or touches a trial already issued — the
 * order's line froze what each one granted.
 */
export class PanelTrialService {
  constructor(private readonly deps: PanelTrialServiceDeps) {}

  async get(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
  ): Promise<PanelTrialResponseBody> {
    await this.deps.guard.check(scope, actor, PANEL_TRIAL_VIEW_PERMISSION);
    const id = this.panelId(panelId);
    if ((await this.deps.panels.find(scope, id)) === null) {
      throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
    }
    return toResponse(id, await this.deps.configs.find(scope, id));
  }

  /**
   * Every configured panel's trial and whether a customer would be offered it NOW —
   * `trialPanelVerdicts`, the evaluator the bot's offer uses, read-only.
   */
  async overview(scope: TenantContext, actor: ActorContext): Promise<PanelTrialOverviewResponse> {
    await this.deps.guard.check(scope, actor, PANEL_TRIAL_VIEW_PERMISSION);
    const verdicts = await trialPanelVerdicts(this.deps, scope);
    // The same switch the claim reads first: with it off, nothing is offered anywhere.
    const on = await this.deps.features.isEnabled(scope, 'trials');
    return {
      panels: verdicts
        .filter((verdict) => verdict.panelName !== null)
        .map((verdict) => ({
          panelId: verdict.config.panelId,
          panelName: verdict.panelName ?? '',
          trial: toResponse(verdict.config.panelId, verdict.config),
          offeredNow: on && verdict.offered,
        })),
    };
  }

  async update(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<UpdatePanelTrialResponse> {
    const denial = { action: 'panel.trial_update', entityType: 'Panel', entityId: panelId };
    // Authorize, then parse — so a caller without the permission learns nothing about
    // what a valid body looks like.
    try {
      await this.deps.guard.check(scope, actor, PANEL_TRIAL_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        PANEL_TRIAL_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    const id = this.panelId(panelId);
    const parsed = updatePanelTrialRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'The request is not valid.',
        {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        },
      );
    }
    const command = parsed.data;
    const trafficBytes = parseTrafficInput(command.trafficAmount, command.trafficUnit);
    if (trafficBytes === null) {
      // Unreachable past the schema's own refinement; refused rather than defaulted.
      throw errors.validation(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID, 'Bad traffic.');
    }
    const label = command.label === null || command.label === '' ? null : command.label;
    const submitted: PanelTrialConfigWrite = {
      enabled: command.enabled,
      trafficBytes,
      durationHours: command.durationHours,
      label,
    };
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          panelId: id,
          expectedRevision: command.expectedRevision,
          enabled: submitted.enabled,
          // The figure as TYPED: whether it keeps the stored bytes is decided against the
          // row, inside the transaction (`trafficAfterEdit`).
          trafficAmount: command.trafficAmount,
          trafficUnit: command.trafficUnit,
          durationHours: submitted.durationHours,
          label: submitted.label,
        }),
      )
      .digest('hex');
    const replay = await this.deps.idempotency.find<{ panelId: string; changed: boolean }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return {
        trial: toResponse(id, await this.deps.configs.find(scope, id)),
        // What the FIRST request did, not a second opinion from this one.
        changed: replay.result.changed,
      };
    }

    const now = this.deps.clock.now();
    const changed = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PANEL_TRIAL_EDIT_PERMISSION,
      denial,
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
        const stored = await this.deps.configs.find(scope, id, tx);
        const write: PanelTrialConfigWrite = {
          ...submitted,
          trafficBytes: trafficAfterEdit(
            stored,
            command.trafficAmount,
            command.trafficUnit,
            trafficBytes,
          ),
        };
        const revision = stored?.revision ?? 0;
        if (command.expectedRevision !== revision) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.TRIAL_CONFIG_STALE,
            'The trial changed since it was read. Reload it and try again.',
            { revision },
          );
        }
        if (stored !== null && sameConfig(stored, write)) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            command.idempotencyKey,
            requestHash,
            { panelId: id, changed: false },
            tx,
          );
          return false;
        }
        const saved = await this.deps.configs.save(
          scope,
          id,
          write,
          command.expectedRevision,
          now,
          tx,
        );
        if (saved === null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.TRIAL_CONFIG_STALE,
            'The trial changed since it was read. Reload it and try again.',
            { revision },
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.trial_update',
            entityType: 'Panel',
            entityId: id,
            // The VALUES: nothing in a trial configuration is a secret.
            before: stored === null ? null : auditValues(stored),
            after: auditValues(saved),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { panelId: id, changed: true },
          tx,
        );
        return true;
      },
    );
    return { trial: toResponse(id, await this.deps.configs.find(scope, id)), changed };
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
 * The stored bytes when the operator left the traffic figure as the form showed it — the
 * product editor's rule (`trafficBytesAfterEdit`, WP21) for a figure typed in GB or MB.
 *
 * A trial carried forward by migration 0142 holds whatever its product held, and 10^9
 * bytes is shown as 953.67 MB; saving an unrelated field would otherwise rewrite it to
 * 953.67 MiB. The figure is the SAME text `trafficInputOf` produces for the form, so
 * "unchanged" means exactly "what the operator was shown".
 */
function trafficAfterEdit(
  stored: PanelTrialConfigRecord | null,
  amount: string,
  unit: TrafficInputUnit,
  submitted: bigint,
): bigint {
  if (stored === null) return submitted;
  const shown = trafficInputOf(stored.trafficBytes);
  return shown.amount === amount.trim() && shown.unit === unit ? stored.trafficBytes : submitted;
}

function sameConfig(stored: PanelTrialConfigRecord, write: PanelTrialConfigWrite): boolean {
  return (
    stored.enabled === write.enabled &&
    stored.trafficBytes === write.trafficBytes &&
    stored.durationHours === write.durationHours &&
    stored.label === write.label
  );
}

function auditValues(config: PanelTrialConfigRecord) {
  return {
    revision: config.revision,
    enabled: config.enabled,
    trafficBytes: config.trafficBytes.toString(),
    durationHours: config.durationHours,
    label: config.label,
  };
}

function toResponse(
  panelId: string,
  config: PanelTrialConfigRecord | null,
): PanelTrialResponseBody {
  if (config === null) {
    return {
      panelId,
      enabled: false,
      trafficBytes: null,
      durationHours: null,
      label: null,
      revision: 0,
      updatedAt: null,
    };
  }
  return {
    panelId,
    enabled: config.enabled,
    trafficBytes: config.trafficBytes.toString(),
    durationHours: config.durationHours,
    label: config.label,
    revision: config.revision,
    updatedAt: config.updatedAt.toISOString(),
  };
}
