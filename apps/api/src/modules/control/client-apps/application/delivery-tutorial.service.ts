import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  updateDeliveryTutorialRequestSchema,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type DeliveryTutorialBody,
  type DeliveryTutorialMode,
  type DeliveryTutorialResponse,
  type DeliveryTutorialVideoOption,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UpdateDeliveryTutorialResponse,
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
import type { ClientAppRepository } from './ports.js';

/** Reading a panel's tutorial is reading the panel — the panel trial's permissions. */
export const DELIVERY_TUTORIAL_VIEW_PERMISSION: PermissionKey = 'panels.view';
/** Changing it is editing the panel. */
export const DELIVERY_TUTORIAL_EDIT_PERMISSION: PermissionKey = 'panels.edit';

/** One panel's stored tutorial (Phase 2 item 5). `text` is RAW, as the operator wrote it. */
export interface DeliveryTutorialRecord {
  readonly panelId: string;
  readonly mode: DeliveryTutorialMode;
  readonly text: string | null;
  readonly videoClientAppId: string | null;
  readonly appliesToPurchase: boolean;
  readonly appliesToTrial: boolean;
  readonly revision: number;
  readonly updatedAt: Date;
}

export type DeliveryTutorialWrite = Omit<
  DeliveryTutorialRecord,
  'panelId' | 'revision' | 'updatedAt'
>;

export interface DeliveryTutorialRepository {
  find(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<DeliveryTutorialRecord | null>;
  /**
   * Revision zero is "no row" (an INSERT that does nothing on a conflict); any other is an
   * UPDATE naming it. Null when another writer got there first.
   */
  save(
    scope: TenantContext,
    panelId: string,
    write: DeliveryTutorialWrite,
    expectedRevision: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<DeliveryTutorialRecord | null>;
  /**
   * The client apps a video may come from: those with a tutorial video on at least one of
   * the tenant's bots, plus `include` (the app the tutorial names) when it still exists.
   */
  videoOptions(
    scope: TenantContext,
    include: string | null,
  ): Promise<readonly DeliveryTutorialVideoOption[]>;
}

export interface DeliveryTutorialServiceDeps {
  readonly tutorials: DeliveryTutorialRepository;
  readonly apps: Pick<ClientAppRepository, 'find'>;
  readonly panels: Pick<PanelRepository, 'find' | 'lockPanel'>;
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
 * One panel's post-delivery tutorial, for an operator (Phase 2 item 5): read it, replace it.
 *
 * The panel trial's write, rule for rule (`PanelTrialService`): the guard is charged before
 * the body is parsed; the panel's row lock is taken first; the scope's activity is read
 * inside the transaction; the write names the revision the form was drawn from; a save of
 * what is stored is a no-op that says so; and the audit row carries the values before and
 * after. Nothing in a tutorial is a secret, so the values are audited whole.
 *
 * Fields a mode does not use are stored as sent, so switching the tutorial off and on
 * again — or from TEXT to VIDEO and back — loses nothing the operator wrote.
 */
export class DeliveryTutorialService {
  constructor(private readonly deps: DeliveryTutorialServiceDeps) {}

  async get(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
  ): Promise<DeliveryTutorialResponse> {
    await this.deps.guard.check(scope, actor, DELIVERY_TUTORIAL_VIEW_PERMISSION);
    const id = this.panelId(panelId);
    if ((await this.deps.panels.find(scope, id)) === null) {
      throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
    }
    return this.response(scope, id);
  }

  async update(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    input: unknown,
  ): Promise<UpdateDeliveryTutorialResponse> {
    const denial = {
      action: 'panel.delivery_tutorial_update',
      entityType: 'Panel',
      entityId: panelId,
    };
    // Authorize, then parse — a caller without the permission learns nothing of the body.
    try {
      await this.deps.guard.check(scope, actor, DELIVERY_TUTORIAL_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        DELIVERY_TUTORIAL_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    const id = this.panelId(panelId);
    const parsed = updateDeliveryTutorialRequestSchema.safeParse(input);
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
    const submitted: DeliveryTutorialWrite = {
      mode: command.mode,
      text: command.text,
      videoClientAppId: command.videoClientAppId,
      appliesToPurchase: command.appliesToPurchase,
      appliesToTrial: command.appliesToTrial,
    };
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({ panelId: id, expectedRevision: command.expectedRevision, ...submitted }),
      )
      .digest('hex');
    const replay = await this.deps.idempotency.find<{ panelId: string; changed: boolean }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      // What the FIRST request did, not a second opinion from this one.
      return { ...(await this.response(scope, id)), changed: replay.result.changed };
    }

    const now = this.deps.clock.now();
    const changed = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      DELIVERY_TUTORIAL_EDIT_PERMISSION,
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
        const stored = await this.deps.tutorials.find(scope, id, tx);
        const revision = stored?.revision ?? 0;
        if (command.expectedRevision !== revision) {
          throw errors.conflict(
            PANEL_ERROR_CODES.DELIVERY_TUTORIAL_STALE,
            'The tutorial changed since it was read. Reload it and try again.',
            { revision },
          );
        }
        /*
         * A NEWLY named app must be this tenant's. The one already stored is kept as it is
         * even if it has since been deleted: the send skips a video it cannot find, and
         * refusing an unrelated edit over it would hold the operator's text hostage.
         */
        if (
          submitted.videoClientAppId !== null &&
          submitted.videoClientAppId !== stored?.videoClientAppId &&
          (await this.deps.apps.find(scope, submitted.videoClientAppId, tx)) === null
        ) {
          throw errors.notFound(CONTROL_ERROR_CODES.CLIENT_APP_NOT_FOUND, 'Unknown client app.');
        }
        if (stored !== null && sameTutorial(stored, submitted)) {
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
        const saved = await this.deps.tutorials.save(
          scope,
          id,
          submitted,
          command.expectedRevision,
          now,
          tx,
        );
        if (saved === null) {
          throw errors.conflict(
            PANEL_ERROR_CODES.DELIVERY_TUTORIAL_STALE,
            'The tutorial changed since it was read. Reload it and try again.',
            { revision },
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'panel.delivery_tutorial_update',
            entityType: 'Panel',
            entityId: id,
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
    return { ...(await this.response(scope, id)), changed };
  }

  private async response(scope: TenantContext, panelId: string): Promise<DeliveryTutorialResponse> {
    const stored = await this.deps.tutorials.find(scope, panelId);
    return {
      tutorial: toBody(panelId, stored),
      videoOptions: [
        ...(await this.deps.tutorials.videoOptions(scope, stored?.videoClientAppId ?? null)),
      ],
    };
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

function sameTutorial(stored: DeliveryTutorialRecord, write: DeliveryTutorialWrite): boolean {
  return (
    stored.mode === write.mode &&
    stored.text === write.text &&
    stored.videoClientAppId === write.videoClientAppId &&
    stored.appliesToPurchase === write.appliesToPurchase &&
    stored.appliesToTrial === write.appliesToTrial
  );
}

function auditValues(tutorial: DeliveryTutorialRecord) {
  return {
    revision: tutorial.revision,
    mode: tutorial.mode,
    text: tutorial.text,
    videoClientAppId: tutorial.videoClientAppId,
    appliesToPurchase: tutorial.appliesToPurchase,
    appliesToTrial: tutorial.appliesToTrial,
  };
}

function toBody(panelId: string, tutorial: DeliveryTutorialRecord | null): DeliveryTutorialBody {
  if (tutorial === null) {
    // No row is DISABLED, with the defaults a first save starts from.
    return {
      panelId,
      mode: 'DISABLED',
      text: null,
      videoClientAppId: null,
      appliesToPurchase: true,
      appliesToTrial: true,
      revision: 0,
      updatedAt: null,
    };
  }
  return {
    panelId,
    mode: tutorial.mode,
    text: tutorial.text,
    videoClientAppId: tutorial.videoClientAppId,
    appliesToPurchase: tutorial.appliesToPurchase,
    appliesToTrial: tutorial.appliesToTrial,
    revision: tutorial.revision,
    updatedAt: tutorial.updatedAt.toISOString(),
  };
}
