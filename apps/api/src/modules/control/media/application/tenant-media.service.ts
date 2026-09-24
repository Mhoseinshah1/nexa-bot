import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  TENANT_MEDIA_MAX_BYTES,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type TenantMediaMimeType,
  type TenantMediaPurpose,
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
import type { TenantMediaContent, TenantMediaRecord, TenantMediaRepository } from './ports.js';

export const MEDIA_VIEW: PermissionKey = 'settings.view';
export const MEDIA_EDIT: PermissionKey = 'settings.edit';

/**
 * The bytes a file of each accepted type MUST begin with. The declared type is what the
 * browser said; the magic number is what the file is. A JPEG labelled PNG is refused
 * rather than stored under a type Telegram will be told and may reject at send time.
 */
const MAGIC: Readonly<Record<TenantMediaMimeType, readonly number[]>> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

export interface TenantMediaServiceDeps {
  readonly repository: TenantMediaRepository;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
}

/** What the idempotency store keeps of an upload. A Date does not survive `jsonb`. */
interface MediaReplayRecord {
  readonly purpose: TenantMediaPurpose;
  readonly mimeType: TenantMediaMimeType;
  readonly byteLength: number;
  readonly sha256: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toReplay(record: TenantMediaRecord): MediaReplayRecord {
  return {
    purpose: record.purpose,
    mimeType: record.mimeType,
    byteLength: record.byteLength,
    sha256: record.sha256,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function fromReplay(record: MediaReplayRecord): TenantMediaRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/** Metadata only: what an audit row and an API response may carry of a slot. */
function metadata(record: TenantMediaRecord): Record<string, unknown> {
  return {
    mimeType: record.mimeType,
    byteLength: record.byteLength,
    sha256: record.sha256,
    version: record.version,
  };
}

/**
 * The tenant's media slots — today the referral banner
 * (`docs/customer-ux-completion-audit.md` §I).
 *
 * The bytes live in the database and travel two ways only: in from the Web Admin as
 * base64 JSON, and out to Telegram as a multipart upload through `bytesFor`. No response
 * here carries them, no audit row carries them, and there is no filesystem path anywhere.
 */
export class TenantMediaService {
  constructor(private readonly deps: TenantMediaServiceDeps) {}

  async get(
    scope: TenantContext,
    actor: ActorContext,
    purpose: TenantMediaPurpose,
  ): Promise<TenantMediaRecord | null> {
    await this.deps.guard.check(scope, actor, MEDIA_VIEW);
    return this.deps.repository.find(scope, purpose);
  }

  /**
   * Decodes, verifies the bytes are what the declared type says, bounds them, and
   * replaces the slot. The request hash is the digest of the bytes rather than the bytes:
   * a replay carries the same content, and hashing a megabyte twice to prove it is not
   * the point of the key.
   */
  async upload(
    scope: TenantContext,
    actor: ActorContext,
    purpose: TenantMediaPurpose,
    input: {
      readonly mimeType: TenantMediaMimeType;
      readonly contentBase64: string;
      readonly idempotencyKey: string;
    },
  ): Promise<TenantMediaRecord> {
    const denial = { action: 'tenant_media.upload', entityType: 'TenantMedia', entityId: purpose };
    await this.authorize(scope, actor, denial);

    const bytes = decodeVerified(input.mimeType, input.contentBase64);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const requestHash = hashRequest({ purpose, mimeType: input.mimeType, sha256 });

    const replay = await this.deps.idempotency.find<MediaReplayRecord>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return fromReplay(replay.result);

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      MEDIA_EDIT,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.repository.find(scope, purpose, tx);
        const written = await this.deps.repository.upsert(
          scope,
          { purpose, mimeType: input.mimeType, content: bytes, sha256, now: this.deps.clock.now() },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'tenant_media.upload',
            entityType: 'TenantMedia',
            entityId: purpose,
            before: before === null ? null : metadata(before),
            after: metadata(written),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          toReplay(written),
          tx,
        );
        return written;
      },
    );
  }

  /** Deletes the slot. `cleared` is false when there was nothing to delete, and says so. */
  async clear(
    scope: TenantContext,
    actor: ActorContext,
    purpose: TenantMediaPurpose,
    input: { readonly idempotencyKey: string },
  ): Promise<{ readonly cleared: boolean }> {
    const denial = { action: 'tenant_media.clear', entityType: 'TenantMedia', entityId: purpose };
    await this.authorize(scope, actor, denial);
    const requestHash = hashRequest({ purpose, clear: true });

    const replay = await this.deps.idempotency.find<{ cleared: boolean }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return { cleared: replay.result.cleared };

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      MEDIA_EDIT,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.repository.find(scope, purpose, tx);
        const cleared = before !== null && (await this.deps.repository.remove(scope, purpose, tx));
        if (cleared) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'tenant_media.clear',
              entityType: 'TenantMedia',
              entityId: purpose,
              before: metadata(before),
              after: null,
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { cleared },
          tx,
        );
        return { cleared };
      },
    );
  }

  /**
   * The bytes, for the Telegram composer. UNGUARDED on purpose: the caller is application
   * code composing a customer's screen, not an actor, and the bytes go to the customer
   * the tenant configured them for. Never reachable from an HTTP controller.
   */
  bytesFor(
    scope: TenantContext,
    purpose: TenantMediaPurpose,
    tx?: unknown,
  ): Promise<TenantMediaContent | null> {
    return this.deps.repository.content(scope, purpose, tx);
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, MEDIA_EDIT);
    } catch (refusal) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        MEDIA_EDIT,
        denial,
        refusal,
      );
      throw refusal;
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
 * Base64 to bytes, refused as `MEDIA_INVALID` unless the bytes are non-empty, within
 * the bound, and begin with the declared type's magic number. The bound is re-checked
 * on the DECODED length: the wire schema bounds the encoded string, and the two differ.
 */
export function decodeVerified(mimeType: TenantMediaMimeType, contentBase64: string): Uint8Array {
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.byteLength === 0) {
    throw errors.validation(COMMERCE_ERROR_CODES.MEDIA_INVALID, 'The file is empty.', {
      reason: 'EMPTY',
    });
  }
  if (bytes.byteLength > TENANT_MEDIA_MAX_BYTES) {
    throw errors.validation(
      COMMERCE_ERROR_CODES.MEDIA_INVALID,
      `The file is larger than ${String(TENANT_MEDIA_MAX_BYTES)} bytes.`,
      { reason: 'TOO_LARGE', byteLength: bytes.byteLength, maxBytes: TENANT_MEDIA_MAX_BYTES },
    );
  }
  const magic = MAGIC[mimeType];
  const matches =
    bytes.byteLength >= magic.length && magic.every((byte, index) => bytes[index] === byte);
  if (!matches) {
    throw errors.validation(
      COMMERCE_ERROR_CODES.MEDIA_INVALID,
      `The file is not a ${mimeType} image.`,
      { reason: 'TYPE_MISMATCH', mimeType },
    );
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
