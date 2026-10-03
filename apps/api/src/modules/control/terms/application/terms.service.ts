import {
  COMMERCE_ERROR_CODES,
  TERMS_ENFORCEMENT_FLAG,
  TERMS_ERROR_CODES,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type TermsDraftInput,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
  type MutationDenial,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import { adminIdOf } from '../../../platform/identity/application/authentication.service.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagResolver } from '../../features/application/feature-flags.service.js';
import type { TermsRepository, TermsVersionRecord } from './ports.js';

export const TERMS_VIEW_PERMISSION = 'terms.view' satisfies PermissionKey;
export const TERMS_EDIT_PERMISSION = 'terms.edit' satisfies PermissionKey;
export const TERMS_PUBLISH_PERMISSION = 'terms.publish' satisfies PermissionKey;

export interface TermsServiceDeps {
  readonly repository: TermsRepository;
  readonly flags: Pick<FeatureFlagResolver, 'resolve'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface TermsOverview {
  readonly enforcement: { readonly enabled: boolean; readonly version: number | null };
  readonly draft: TermsVersionRecord | null;
  /** Every published version, newest first; the first is the current one. */
  readonly history: readonly TermsVersionRecord[];
  readonly acceptanceCounts: ReadonlyMap<string, number>;
  readonly customers: number;
}

/** What one command produced, so a replay can answer with the same row. */
interface VersionResult {
  readonly id: string;
}

/**
 * The operator's side of the terms and rules (program §6, `docs/terms-audit.md`).
 *
 * One read under `terms.view`, two draft writes under `terms.edit` and the publication
 * under `terms.publish`. Each write states the draft revision it was made from, so a
 * colleague's edit — or a publication — in between is refused with where the draft stands
 * now, and PUBLISH publishes exactly the revision the operator previewed.
 *
 * Publishing writes NO acceptance. A new version is the current one the moment it commits,
 * and every customer, including one who accepted the previous version a second earlier, is
 * asked again by the Telegram gate while enforcement is on. Enforcement itself is the
 * `terms_enforcement` feature flag, toggled through the features service.
 */
export class TermsService {
  constructor(private readonly deps: TermsServiceDeps) {}

  async overview(scope: TenantContext, actor: ActorContext): Promise<TermsOverview> {
    await this.deps.guard.check(scope, actor, TERMS_VIEW_PERMISSION);
    const [versions, acceptanceCounts, customers, flag] = await Promise.all([
      this.deps.repository.list(scope),
      this.deps.repository.acceptanceCounts(scope),
      this.deps.repository.customerCount(scope),
      this.deps.flags.resolve(scope, TERMS_ENFORCEMENT_FLAG),
    ]);
    return {
      enforcement: { enabled: flag.enabled, version: flag.version },
      draft: versions.find((version) => version.status === 'DRAFT') ?? null,
      history: versions.filter((version) => version.status === 'PUBLISHED'),
      acceptanceCounts,
      customers,
    };
  }

  async createDraft(
    scope: TenantContext,
    actor: ActorContext,
    input: TermsDraftInput & { readonly idempotencyKey: string },
  ): Promise<TermsVersionRecord> {
    const denial = { action: 'terms.draft_create', entityType: 'TermsVersion', entityId: null };
    // Before the replay lookup: a replay returns a ROW, and an unauthorized caller who
    // guessed a key would be handed one.
    await this.authorize(scope, actor, TERMS_EDIT_PERMISSION, denial);
    const requestHash = hashRequest({ op: 'create', title: input.title, body: input.body });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      TERMS_EDIT_PERMISSION,
      { ...denial, entityId: id },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        if ((await this.deps.repository.findDraft(scope, tx)) !== null) {
          throw errors.conflict(
            TERMS_ERROR_CODES.TERMS_DRAFT_EXISTS,
            'A draft of the terms already exists; edit it.',
          );
        }
        const after = await this.deps.repository.insertDraft(
          scope,
          { id, title: input.title, body: input.body, adminId: adminIdOf(actor), now },
          tx,
        );
        await this.record(scope, actor, tx, 'terms.draft_create', id, null, auditView(after));
        await this.remember(scope, input.idempotencyKey, requestHash, id, tx);
        return after;
      },
    );
  }

  async updateDraft(
    scope: TenantContext,
    actor: ActorContext,
    input: TermsDraftInput & {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly expectedRevision: number;
    },
  ): Promise<TermsVersionRecord> {
    const denial = { action: 'terms.draft_update', entityType: 'TermsVersion', entityId: input.id };
    await this.authorize(scope, actor, TERMS_EDIT_PERMISSION, denial);
    const requestHash = hashRequest({
      op: 'update',
      id: input.id,
      title: input.title,
      body: input.body,
      expectedRevision: input.expectedRevision,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      TERMS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.requireDraft(scope, input.id, input.expectedRevision, tx);
        // Nothing to change: no revision bump and no audit row for a change that did not
        // happen. Remembered, so a retry answers the same.
        if (before.title === input.title && before.body === input.body) {
          await this.remember(scope, input.idempotencyKey, requestHash, input.id, tx);
          return before;
        }
        const after = await this.deps.repository.updateDraft(
          scope,
          input.id,
          { title: input.title, body: input.body, expectedRevision: input.expectedRevision, now },
          tx,
        );
        if (after === null) throw await this.draftConflict(scope, input.id, tx);
        await this.record(
          scope,
          actor,
          tx,
          'terms.draft_update',
          input.id,
          auditView(before),
          auditView(after),
        );
        await this.remember(scope, input.idempotencyKey, requestHash, input.id, tx);
        return after;
      },
    );
  }

  /**
   * The draft becomes the current version.
   *
   * A conditional UPDATE from DRAFT at the revision the operator previewed, so two
   * publishers racing produce one publication and one refusal, and an edit that landed
   * after the preview is never published unseen. No acceptance is written: every customer
   * is asked again.
   */
  async publish(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly expectedRevision: number;
    },
  ): Promise<TermsVersionRecord> {
    const denial = { action: 'terms.publish', entityType: 'TermsVersion', entityId: input.id };
    await this.authorize(scope, actor, TERMS_PUBLISH_PERMISSION, denial);
    const requestHash = hashRequest({
      op: 'publish',
      id: input.id,
      expectedRevision: input.expectedRevision,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      TERMS_PUBLISH_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.requireDraft(scope, input.id, input.expectedRevision, tx);
        const after = await this.deps.repository.publish(
          scope,
          input.id,
          { expectedRevision: input.expectedRevision, adminId: adminIdOf(actor), now },
          tx,
        );
        if (after === null || after.versionNumber === null) {
          throw await this.draftConflict(scope, input.id, tx);
        }
        await this.record(
          scope,
          actor,
          tx,
          'terms.publish',
          input.id,
          auditView(before),
          auditView(after),
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'TermsVersionPublished',
          aggregateType: 'TermsVersion',
          aggregateId: input.id,
          payload: { versionNumber: after.versionNumber },
        });
        await this.remember(scope, input.idempotencyKey, requestHash, input.id, tx);
        return after;
      },
    );
  }

  // -------------------------------------------------------------------------

  /**
   * The draft under that id at that revision, or the refusal that says why not: another
   * tenant's id and an unknown one are both NOT_FOUND; a published one is never edited.
   */
  private async requireDraft(
    scope: TenantContext,
    id: string,
    expectedRevision: number,
    tx: TransactionScope,
  ): Promise<TermsVersionRecord> {
    const found = await this.deps.repository.find(scope, id, tx);
    if (found === null) {
      throw errors.notFound(TERMS_ERROR_CODES.TERMS_VERSION_NOT_FOUND, 'No such terms version.');
    }
    if (found.status === 'PUBLISHED') {
      throw errors.conflict(
        TERMS_ERROR_CODES.TERMS_VERSION_PUBLISHED,
        'This version is published; a published version is never changed.',
      );
    }
    if (found.revision !== expectedRevision) {
      throw errors.conflict(
        TERMS_ERROR_CODES.TERMS_DRAFT_CONFLICT,
        'The draft changed since it was read. Reload it and apply the change again.',
        { currentRevision: found.revision },
      );
    }
    return found;
  }

  private async draftConflict(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<Error> {
    const now = await this.deps.repository.find(scope, id, tx);
    return errors.conflict(
      TERMS_ERROR_CODES.TERMS_DRAFT_CONFLICT,
      'The draft changed since it was read. Reload it and apply the change again.',
      { currentRevision: now?.status === 'DRAFT' ? now.revision : null },
    );
  }

  private async replay(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<TermsVersionRecord | null> {
    const found = await this.deps.idempotency.find<VersionResult>(
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    return this.deps.repository.find(scope, found.result.id);
  }

  private async remember(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    id: string,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
      { id } satisfies VersionResult,
      tx,
    );
  }

  private async record(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    action: string,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      { action, entityType: 'TermsVersion', entityId, before, after, result: 'SUCCESS' },
      tx,
    );
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

  /** `recordMutationDenial`, not a bare check: a refused write leaves its DENIED row. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: MutationDenial,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }
}

/**
 * What an edit or a publication changed. The title and the body are the operator's own
 * words about the installation, never a customer's data, so the audit row carries them.
 */
function auditView(row: TermsVersionRecord): Record<string, unknown> {
  return {
    status: row.status,
    versionNumber: row.versionNumber,
    revision: row.revision,
    title: row.title,
    body: row.body,
  };
}
