import { createHash } from 'node:crypto';
import {
  CLIENT_APP_IMAGE_MAX_BYTES,
  CLIENT_APP_MAX_ENTRIES,
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  clientAppInputSchema,
  errors,
  inspectClientAppImage,
  type ActorContext,
  type AuditWriter,
  type ClientAppImageMimeType,
  type ClientAppInput,
  type ClientAppStatus,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
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
import type {
  ClientAppImageContent,
  ClientAppImageDraft,
  ClientAppRecord,
  ClientAppRepository,
} from './ports.js';

export const CLIENT_APP_VIEW_PERMISSION = 'client_apps.view' satisfies PermissionKey;
export const CLIENT_APP_EDIT_PERMISSION = 'client_apps.edit' satisfies PermissionKey;

export interface ClientAppServiceDeps {
  readonly repository: ClientAppRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** What one command produced, so a replay can answer with the same row. */
interface AppResult {
  readonly id: string;
}

/**
 * The tenant's client apps as the operator maintains them (WP-A10).
 *
 * `SupportFaqService`'s shape, deliberately: one read under `client_apps.view` and four
 * writes under `client_apps.edit`, each its own command with its own audit action, because
 * "who changed this link", "who hid this app" and "who removed it" are three questions and
 * a payload diff should not be the only way to answer one of them. HF-A10 adds the
 * picture's two writes, `client_app.image_upload` and `client_app.image_clear`, and the
 * editor's read of its bytes, on the same terms.
 *
 * Every write:
 *   - is authorised BEFORE the replay lookup, so a guessed key cannot hand an unauthorised
 *     caller a row;
 *   - takes an idempotency key in the `WEB` namespace, and a key reused with a different
 *     payload is refused by the store rather than answered with the first result;
 *   - reads `ScopeActivityReader` inside its transaction;
 *   - states the version it read, checked in the UPDATE's WHERE, so a colleague's edit is
 *     refused with the current version rather than silently overwritten;
 *   - writes one audit row with the before and after VALUES in the same transaction.
 *
 * The input is parsed again here, not only at the controller: `clientAppInputSchema` is
 * where https-only links and the guide's safety live, and a second caller of this class
 * must not be able to store what the HTTP surface would refuse.
 *
 * The customer's read is `ClientAppCatalog`, not here, for the reason
 * `SupportFaqService` gives: it charges no permission.
 */
export class ClientAppService {
  constructor(private readonly deps: ClientAppServiceDeps) {}

  /** Every row, whatever its status, platform by platform in the customer's order. */
  async listForOperator(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<readonly ClientAppRecord[]> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_VIEW_PERMISSION);
    return this.deps.repository.list(scope);
  }

  async create(
    scope: TenantContext,
    actor: ActorContext,
    command: ClientAppInput & { readonly idempotencyKey: string },
  ): Promise<ClientAppRecord> {
    const denial = { action: 'client_app.create', entityType: 'ClientApp', entityId: null };
    await this.authorize(scope, actor, denial);
    const input = parseInput(command);

    const requestHash = hashRequest({ ...input });
    const replayed = await this.replay(scope, command.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      { ...denial, entityId: id },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        // A bound, not a lock — `SupportFaqService.create`'s reasoning: two operators
        // racing at the limit may both land, and one row over it costs nothing.
        if ((await this.deps.repository.count(scope, tx)) >= CLIENT_APP_MAX_ENTRIES) {
          throw errors.conflict(
            CONTROL_ERROR_CODES.CLIENT_APP_LIMIT,
            `This installation already holds ${String(CLIENT_APP_MAX_ENTRIES)} client app entries.`,
            { limit: CLIENT_APP_MAX_ENTRIES },
          );
        }
        const after = await this.deps.repository.insert(
          scope,
          { ...input, id, status: 'ENABLED', now },
          tx,
        );
        await this.record(scope, actor, tx, {
          action: 'client_app.create',
          entityId: id,
          before: null,
          after: auditView(after),
        });
        await this.remember(scope, command.idempotencyKey, requestHash, id, tx);
        return after;
      },
    );
  }

  async update(
    scope: TenantContext,
    actor: ActorContext,
    command: ClientAppInput & {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly expectedVersion: number;
    },
  ): Promise<ClientAppRecord> {
    const denial = { action: 'client_app.update', entityType: 'ClientApp', entityId: command.id };
    await this.authorize(scope, actor, denial);
    const input = parseInput(command);

    const requestHash = hashRequest({
      ...input,
      id: command.id,
      expectedVersion: command.expectedVersion,
    });
    const replayed = await this.replay(scope, command.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, command.id, tx);
        this.assertVersion(before, command.expectedVersion);

        const after = await this.deps.repository.update(
          scope,
          command.id,
          { ...input, expectedVersion: command.expectedVersion },
          now,
          tx,
        );
        // Zero rows: the row moved between the read and the write. Re-read for the
        // version the refusal should name.
        if (after === null) throw this.versionConflict(await this.require(scope, command.id, tx));

        await this.record(scope, actor, tx, {
          action: 'client_app.update',
          entityId: command.id,
          before: auditView(before),
          after: auditView(after),
        });
        await this.remember(scope, command.idempotencyKey, requestHash, command.id, tx);
        return after;
      },
    );
  }

  /**
   * Switches one entry on or off.
   *
   * Already there is a no-op that SAYS so: the row unchanged, no audit row, no version
   * bump — an audit entry for a change that did not happen is the legacy activity feed.
   */
  async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    command: {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly status: ClientAppStatus;
      readonly expectedVersion: number;
    },
  ): Promise<ClientAppRecord> {
    const denial = { action: 'client_app.status', entityType: 'ClientApp', entityId: command.id };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      id: command.id,
      status: command.status,
      expectedVersion: command.expectedVersion,
    });
    const replayed = await this.replay(scope, command.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, command.id, tx);
        this.assertVersion(before, command.expectedVersion);
        if (before.status === command.status) {
          await this.remember(scope, command.idempotencyKey, requestHash, command.id, tx);
          return before;
        }
        const after = await this.deps.repository.setStatus(
          scope,
          command.id,
          { from: before.status, to: command.status, expectedVersion: command.expectedVersion },
          now,
          tx,
        );
        if (after === null) throw this.versionConflict(await this.require(scope, command.id, tx));

        await this.record(scope, actor, tx, {
          action: 'client_app.status',
          entityId: command.id,
          before: auditView(before),
          after: auditView(after),
        });
        await this.remember(scope, command.idempotencyKey, requestHash, command.id, tx);
        return after;
      },
    );
  }

  /**
   * Removes one entry for good.
   *
   * A HARD delete, and safe to be one: nothing references a client app — no order, no
   * snapshot, no customer message stores its id except a `ca:<id>` button, which answers
   * `bot.apps.not_found` once the row is gone. The audit row keeps every value it had, so
   * "what did this link say before somebody removed it" stays answerable.
   *
   * A replay answers `{ deleted: true }` again from the idempotency record rather than
   * `CLIENT_APP_NOT_FOUND`, which is what re-running the delete would find.
   */
  async remove(
    scope: TenantContext,
    actor: ActorContext,
    command: {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly expectedVersion: number;
    },
  ): Promise<{ readonly id: string; readonly deleted: true }> {
    const denial = { action: 'client_app.delete', entityType: 'ClientApp', entityId: command.id };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      id: command.id,
      delete: true,
      expectedVersion: command.expectedVersion,
    });
    const found = await this.deps.idempotency.find<AppResult>(
      scope,
      'WEB',
      command.idempotencyKey,
      requestHash,
    );
    if (found !== null) return { id: found.result.id, deleted: true };

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, command.id, tx);
        this.assertVersion(before, command.expectedVersion);
        const removed = await this.deps.repository.remove(
          scope,
          command.id,
          command.expectedVersion,
          tx,
        );
        if (!removed) throw this.versionConflict(await this.require(scope, command.id, tx));

        await this.record(scope, actor, tx, {
          action: 'client_app.delete',
          entityId: command.id,
          before: auditView(before),
          after: null,
        });
        await this.remember(scope, command.idempotencyKey, requestHash, command.id, tx);
        return { id: command.id, deleted: true as const };
      },
    );
  }

  /**
   * HF-A10 — sets or replaces the entry's picture.
   *
   * The bytes are decoded and inspected BEFORE anything is looked up, by
   * `inspectClientAppImage`, the function the Web Admin form runs too: the declared type
   * must be the file's own magic number, and its header must state a size inside the
   * bounds. A refusal is `MEDIA_INVALID` with the reason, the referral banner's code.
   *
   * The request hash is the digest of the bytes, not the bytes — the banner's reasoning.
   * States the entry's version and bumps it, like every other write on an entry, so an
   * editor holding an older row is refused rather than silently overtaken.
   */
  async uploadImage(
    scope: TenantContext,
    actor: ActorContext,
    command: {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly mimeType: ClientAppImageMimeType;
      readonly contentBase64: string;
    },
  ): Promise<ClientAppRecord> {
    const denial = {
      action: 'client_app.image_upload',
      entityType: 'ClientApp',
      entityId: command.id,
    };
    await this.authorize(scope, actor, denial);
    const image = decodeImage(command.mimeType, command.contentBase64);

    const requestHash = hashRequest({
      id: command.id,
      image: true,
      mimeType: image.mimeType,
      sha256: image.sha256,
      expectedVersion: command.expectedVersion,
    });
    const replayed = await this.replay(scope, command.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    return this.writeImage(scope, actor, command, denial, requestHash, image);
  }

  /**
   * HF-A10 — removes the entry's picture; the bot goes back to the emoji and the text.
   * Nothing to remove is a no-op that says so, `setStatus`'s rule: the row unchanged, no
   * audit row, no version bump.
   */
  async clearImage(
    scope: TenantContext,
    actor: ActorContext,
    command: {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly expectedVersion: number;
    },
  ): Promise<ClientAppRecord> {
    const denial = {
      action: 'client_app.image_clear',
      entityType: 'ClientApp',
      entityId: command.id,
    };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      id: command.id,
      image: null,
      expectedVersion: command.expectedVersion,
    });
    const replayed = await this.replay(scope, command.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    return this.writeImage(scope, actor, command, denial, requestHash, null);
  }

  /**
   * HF-A10 — the stored bytes, for the editor's preview, under `client_apps.view`. A
   * disabled entry's picture is served too: the operator is looking at the row. Another
   * tenant's id, a malformed one and an entry with no picture are all "not found".
   */
  async imageForOperator(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<ClientAppImageContent> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_VIEW_PERMISSION);
    const content = UUID_SHAPE.test(id) ? await this.deps.repository.imageContent(scope, id) : null;
    if (content === null) {
      throw errors.notFound(
        CONTROL_ERROR_CODES.CLIENT_APP_NOT_FOUND,
        'No such client app entry, or it has no image.',
      );
    }
    return content;
  }

  private writeImage(
    scope: TenantContext,
    actor: ActorContext,
    command: {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly expectedVersion: number;
    },
    denial: { action: string; entityType: string; entityId: string },
    requestHash: string,
    image: ClientAppImageDraft | null,
  ): Promise<ClientAppRecord> {
    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, command.id, tx);
        this.assertVersion(before, command.expectedVersion);
        if (image === null && before.image === null) {
          await this.remember(scope, command.idempotencyKey, requestHash, command.id, tx);
          return before;
        }
        const after = await this.deps.repository.setImage(
          scope,
          command.id,
          { image, expectedVersion: command.expectedVersion },
          now,
          tx,
        );
        if (after === null) throw this.versionConflict(await this.require(scope, command.id, tx));

        await this.record(scope, actor, tx, {
          action: denial.action,
          entityId: command.id,
          before: auditView(before),
          after: auditView(after),
        });
        await this.remember(scope, command.idempotencyKey, requestHash, command.id, tx);
        return after;
      },
    );
  }

  // -------------------------------------------------------------------------

  /**
   * Another tenant's id is answered exactly as an unknown one: the predicate carries the tenant.
   *
   * So is an id that is not a UUID at all (Codex review #1 of PR #95, C2). It arrives from
   * the URL path, and compared against the `uuid` column PostgreSQL refuses it with a cast
   * error that aborts the transaction and surfaced as a 500. It is checked HERE, before the
   * query, and answered as the unknown id it is — not as a validation error, which would
   * tell a caller something about the shape of ids that exist.
   */
  private async require(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<ClientAppRecord> {
    if (!UUID_SHAPE.test(id)) {
      throw errors.notFound(CONTROL_ERROR_CODES.CLIENT_APP_NOT_FOUND, 'No such client app entry.');
    }
    const found = await this.deps.repository.find(scope, id, tx);
    if (found === null) {
      throw errors.notFound(CONTROL_ERROR_CODES.CLIENT_APP_NOT_FOUND, 'No such client app entry.');
    }
    return found;
  }

  private assertVersion(row: ClientAppRecord, expectedVersion: number): void {
    if (row.version !== expectedVersion) throw this.versionConflict(row);
  }

  private versionConflict(row: ClientAppRecord): Error {
    return errors.conflict(
      CONTROL_ERROR_CODES.CLIENT_APP_VERSION_CONFLICT,
      'This client app entry changed since it was read. Reload it and apply the change again.',
      { currentVersion: row.version },
    );
  }

  private async replay(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ClientAppRecord | null> {
    const found = await this.deps.idempotency.find<AppResult>(
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    // Null when the record outlived its row (a later delete, a restore): doing the work
    // again beats reporting a stale success.
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
      { id } satisfies AppResult,
      tx,
    );
  }

  private async record(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    entry: {
      readonly action: string;
      readonly entityId: string;
      readonly before: Record<string, unknown> | null;
      readonly after: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: entry.action,
        entityType: 'ClientApp',
        entityId: entry.entityId,
        before: entry.before,
        after: entry.after,
        result: 'SUCCESS',
      },
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

  /** `recordMutationDenial`, not a bare check, so an early refusal is audited too. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, CLIENT_APP_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        CLIENT_APP_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      // The code the FAQ and media services answer with, so the Web Admin reads one refusal.
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }
}

/**
 * The canonical text form of a UUID, any version — every id `IdGenerator.uuid()` mints
 * has it. Anything else cannot name a row, so it never reaches the `uuid` column.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The entry's fields as the contract accepts them, or a validation refusal naming each issue. */
function parseInput(command: ClientAppInput): ClientAppInput {
  const parsed = clientAppInputSchema.safeParse({
    platform: command.platform,
    name: command.name,
    icon: command.icon,
    description: command.description,
    officialUrl: command.officialUrl,
    alternativeUrl: command.alternativeUrl,
    helpUrl: command.helpUrl,
    guide: command.guide,
    deliveryKinds: command.deliveryKinds,
    protocols: command.protocols,
    providerTypes: command.providerTypes,
    sortOrder: command.sortOrder,
  });
  if (!parsed.success) {
    throw errors.validation(CONTROL_ERROR_CODES.INVALID_VALUE, 'The client app entry is invalid.', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * Base64 to an inspected image, or `MEDIA_INVALID` naming why not. The size is judged on
 * the DECODED bytes: the wire schema bounds the encoded string, and the two differ.
 */
function decodeImage(mimeType: ClientAppImageMimeType, contentBase64: string): ClientAppImageDraft {
  const bytes = Buffer.from(contentBase64, 'base64');
  const inspected = inspectClientAppImage(mimeType, bytes);
  if (!inspected.ok) {
    throw errors.validation(COMMERCE_ERROR_CODES.MEDIA_INVALID, 'The image is not acceptable.', {
      reason: inspected.problem,
      mimeType,
      byteLength: bytes.byteLength,
      maxBytes: CLIENT_APP_IMAGE_MAX_BYTES,
    });
  }
  return {
    content: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    mimeType,
    width: inspected.width,
    height: inspected.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Every mutable field plus the version, so a before/after pair answers what an edit changed.
 * The image as its metadata — the digest says which picture it was — never its bytes.
 */
function auditView(row: ClientAppRecord): Record<string, unknown> {
  return {
    platform: row.platform,
    name: row.name,
    icon: row.icon,
    description: row.description,
    officialUrl: row.officialUrl,
    alternativeUrl: row.alternativeUrl,
    helpUrl: row.helpUrl,
    guide: row.guide,
    deliveryKinds: row.deliveryKinds,
    protocols: row.protocols,
    providerTypes: row.providerTypes,
    status: row.status,
    sortOrder: row.sortOrder,
    version: row.version,
    image:
      row.image === null
        ? null
        : {
            mimeType: row.image.mimeType,
            byteLength: row.image.byteLength,
            width: row.image.width,
            height: row.image.height,
            sha256: row.image.sha256,
          },
  };
}
