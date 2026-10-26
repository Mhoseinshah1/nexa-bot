import { createHash } from 'node:crypto';
import {
  CONTROL_ERROR_CODES,
  CUSTOM_MENU_BUTTONS_MAX,
  CUSTOM_MENU_BUTTON_AUDIT_ACTIONS,
  CUSTOM_MENU_BUTTON_AUDIT_ENTITY,
  CUSTOM_MENU_BUTTON_ERROR_CODES,
  CUSTOM_MENU_CAPTION_MAX,
  CUSTOM_MENU_STORAGE_MAX_BYTES,
  CUSTOM_MENU_TEXT_MAX,
  PLATFORM_ERROR_CODES,
  archiveCustomMenuButtonRequestSchema,
  createCustomMenuButtonRequestSchema,
  customMenuRefOf,
  errors,
  normalizeCustomMenuBody,
  normalizeCustomMenuLabel,
  normalizeCustomMenuUrl,
  setCustomMenuButtonMediaRequestSchema,
  ticketReplyFileNameOf,
  ticketReplyFileRefusal,
  ticketReplyFileTypeOf,
  updateCustomMenuButtonRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CustomMenuBotScope,
  type CustomMenuButtonKind,
  type CustomMenuButtonListResponse,
  type CustomMenuButtonMutationResponse,
  type CustomMenuButtonView,
  type DirectMessageFile,
  type FeatureFlagKey,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import {
  recordMutationDenial,
  runAuthorizedMutation,
  type MutationDenial,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomMenuButtonRepository,
  NewCustomMenuMedia,
  StoredCustomMenuButton,
} from './custom-menu-button.ports.js';

export const CUSTOM_MENU_BUTTON_VIEW_PERMISSION = 'settings.view' satisfies PermissionKey;
export const CUSTOM_MENU_BUTTON_EDIT_PERMISSION = 'settings.edit' satisfies PermissionKey;

export interface CustomMenuButtonServiceDeps {
  readonly repository: CustomMenuButtonRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  /** The RAW recorder: a denial is written after the transaction. */
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly features: {
    isEnabled(scope: TenantContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  /**
   * Every label a custom button must NOT take: the registry buttons as this tenant renders
   * them now, their shared default labels (a keyboard drawn before a rename still routes by
   * them) and the management panel's. Read BEFORE the transaction — rendering templates
   * would take a second pool connection from inside it.
   */
  readonly reservedLabels: (scope: TenantContext) => Promise<readonly string[]>;
}

/** What a request meant, judged: the fields the row is written from. */
interface JudgedFields {
  readonly label?: string;
  readonly url?: string | null;
  readonly body?: string | null;
}

interface JudgedFile {
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly mimeType: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** The operator's file, judged by the ONE rule support's ticket files are held to. */
function judgedFile(file: DirectMessageFile): JudgedFile {
  const decoded = Buffer.from(file.contentBase64, 'base64');
  const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const refusal = ticketReplyFileRefusal({
    fileName: file.fileName,
    mimeType: file.mimeType,
    bytes,
  });
  const type = ticketReplyFileTypeOf(file.mimeType);
  if (refusal !== null || type === undefined) {
    throw errors.validation(
      CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
      'This file cannot be used.',
      { refusal: refusal ?? 'TYPE_NOT_ALLOWED' },
    );
  }
  return {
    kind: type.kind,
    mimeType: type.mimeType,
    fileName: ticketReplyFileNameOf(file.fileName, type),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function labelOf(raw: string): string {
  const label = normalizeCustomMenuLabel(raw);
  if (label === null) {
    throw errors.validation(
      CUSTOM_MENU_BUTTON_ERROR_CODES.LABEL_INVALID,
      'A label is one line of 1 to 64 characters and does not start with a slash.',
    );
  }
  return label;
}

function urlOf(raw: string | null): string {
  const url = normalizeCustomMenuUrl(raw);
  if (url === null) {
    throw errors.validation(
      CUSTOM_MENU_BUTTON_ERROR_CODES.URL_INVALID,
      'The link must be an https:// address of a named site.',
    );
  }
  return url;
}

/** A body of at most `max` code points; null for an empty one; a refusal for one too long. */
function optionalBodyOf(raw: string | null, max: number): string | null {
  if (raw === null || raw.trim() === '') return null;
  const body = normalizeCustomMenuBody(raw, max);
  if (body === null) {
    throw errors.validation(
      CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID,
      `The text is empty or longer than ${max} characters.`,
      { max },
    );
  }
  return body;
}

function requiredBodyOf(raw: string | null, max: number): string {
  const body = optionalBodyOf(raw, max);
  if (body === null) {
    throw errors.validation(
      CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID,
      'This kind of button needs a text.',
      { max },
    );
  }
  return body;
}

function contentMismatch(what: string): never {
  throw errors.validation(
    CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID,
    `A button of this kind does not take ${what}.`,
  );
}

function botIdsOf(scope: CustomMenuBotScope, ids: readonly string[]): string[] {
  // SELECTED with no bot would be a button drawn nowhere; ALL names none.
  if (scope === 'ALL') return [];
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  if (unique.length === 0) {
    throw errors.validation(
      CUSTOM_MENU_BUTTON_ERROR_CODES.BOT_INVALID,
      'Choose at least one bot, or show the button on all bots.',
    );
  }
  return unique;
}

export function customMenuButtonViewOf(button: StoredCustomMenuButton): CustomMenuButtonView {
  return {
    id: button.id,
    ref: customMenuRefOf(button.id),
    label: button.label,
    kind: button.kind,
    url: button.url,
    body: button.body,
    botScope: button.botScope,
    botInstanceIds: [...button.botInstanceIds],
    media:
      button.media === null
        ? null
        : {
            fileName: button.media.fileName,
            mimeType: button.media.mimeType,
            byteLength: button.media.byteLength,
          },
    version: button.version,
    archivedAt: button.archivedAt === null ? null : button.archivedAt.toISOString(),
    createdAt: button.createdAt.toISOString(),
    updatedAt: button.updatedAt.toISOString(),
  };
}

/**
 * R10 D2 — the Web Admin's custom main-menu buttons: list, create, update, replace the file,
 * archive (`packages/contracts/src/custom-menu-buttons.ts`).
 *
 * Every write follows the seven steps and the builder's own discipline: `settings.edit`,
 * checked early and again inside the transaction (`runAuthorizedMutation`, a denial audited);
 * the body parsed with zod; an idempotency key whose first answer is replayed verbatim and
 * whose reuse with another payload is refused; ONE transaction that reads `ScopeActivityReader`
 * first, takes the tenant's custom-button lock, re-reads the row, compares the version the
 * caller read, writes with a conditional UPDATE and audits; a no-op reported as one.
 *
 * Content is judged BEFORE anything is written, by the contract's own normalisers: the link by
 * the client apps' https-only grammar, a file by the ticket-reply allow-list (type, size, name,
 * signature). Media is stored as bytes, never as a Telegram file id.
 *
 * It does not need the feature flag: managing buttons while the feature is off is inert, since
 * nothing draws a custom button until `custom_menu_buttons` is on.
 */
export class CustomMenuButtonService {
  constructor(private readonly deps: CustomMenuButtonServiceDeps) {}

  async list(scope: TenantContext, actor: ActorContext): Promise<CustomMenuButtonListResponse> {
    await this.deps.guard.check(scope, actor, CUSTOM_MENU_BUTTON_VIEW_PERMISSION);
    const [buttons, featureEnabled, usedBytes] = await Promise.all([
      this.deps.repository.list(scope),
      this.deps.features.isEnabled(scope, 'custom_menu_buttons'),
      this.deps.repository.storageBytes(scope),
    ]);
    return {
      featureEnabled,
      buttons: buttons.map(customMenuButtonViewOf),
      storage: { usedBytes, maxBytes: CUSTOM_MENU_STORAGE_MAX_BYTES },
    };
  }

  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<CustomMenuButtonMutationResponse> {
    const denial = this.denial(scope, CUSTOM_MENU_BUTTON_AUDIT_ACTIONS.CREATED, null);
    await this.authorize(scope, actor, denial);
    const command = createCustomMenuButtonRequestSchema.parse(input);

    // Judged before anything is written: a refused field writes nothing at all.
    const label = labelOf(command.label);
    let url: string | null = null;
    let body: string | null = null;
    let file: JudgedFile | null = null;
    switch (command.kind) {
      case 'LINK':
        if (command.file !== null) contentMismatch('a file');
        url = urlOf(command.url);
        body = optionalBodyOf(command.body, CUSTOM_MENU_TEXT_MAX);
        break;
      case 'TEXT':
        if (command.file !== null) contentMismatch('a file');
        if (command.url !== null) contentMismatch('a link');
        body = requiredBodyOf(command.body, CUSTOM_MENU_TEXT_MAX);
        break;
      case 'PHOTO':
      case 'DOCUMENT':
        if (command.url !== null) contentMismatch('a link');
        if (command.file === null) {
          throw errors.validation(
            CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
            'This kind of button needs a file.',
            { refusal: 'EMPTY' },
          );
        }
        file = judgedFile(command.file);
        if (file.kind !== command.kind) {
          throw errors.validation(
            CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
            'The file is not of the kind this button sends.',
            { refusal: 'KIND_MISMATCH' },
          );
        }
        body = optionalBodyOf(command.body, CUSTOM_MENU_CAPTION_MAX);
        break;
    }
    const botInstanceIds = botIdsOf(command.botScope, command.botInstanceIds);
    const reserved = await this.deps.reservedLabels(scope);
    const requestHash = hashRequest({
      action: denial.action,
      label,
      kind: command.kind,
      url,
      body,
      botScope: command.botScope,
      botInstanceIds,
      fileSha256: file?.sha256 ?? null,
      fileName: file?.fileName ?? null,
    });
    const id = this.deps.ids.uuid();

    return this.mutate(scope, actor, denial, command.idempotencyKey, requestHash, async (tx) => {
      await this.deps.repository.lockTenant(scope, tx);
      if ((await this.deps.repository.activeCount(scope, tx)) >= CUSTOM_MENU_BUTTONS_MAX) {
        throw errors.preconditionFailed(
          CUSTOM_MENU_BUTTON_ERROR_CODES.LIMIT_REACHED,
          `A tenant has at most ${CUSTOM_MENU_BUTTONS_MAX} custom buttons.`,
          { max: CUSTOM_MENU_BUTTONS_MAX },
        );
      }
      await this.assertLabelFree(scope, tx, label, null, reserved);
      await this.assertBots(scope, tx, botInstanceIds);
      const media = file === null ? null : await this.newMedia(scope, tx, file, 0);
      const stored = await this.deps.repository.insert(
        scope,
        {
          id,
          label,
          kind: command.kind,
          url,
          body,
          botScope: command.botScope,
          botInstanceIds,
          media,
          now: this.deps.clock.now(),
          adminId: adminIdOf(actor),
        },
        tx,
      );
      await this.audit(scope, actor, tx, denial.action, stored.id, null, stored);
      return { changed: true, button: stored };
    });
  }

  async update(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: unknown,
  ): Promise<CustomMenuButtonMutationResponse> {
    const denial = this.denial(scope, CUSTOM_MENU_BUTTON_AUDIT_ACTIONS.UPDATED, id);
    await this.authorize(scope, actor, denial);
    const command = updateCustomMenuButtonRequestSchema.parse(input);
    const reserved = command.label === undefined ? [] : await this.deps.reservedLabels(scope);
    // The raw request is hashed (it is what the caller sent); the row is judged per kind below.
    const requestHash = hashRequest({
      action: denial.action,
      id,
      expectedVersion: command.expectedVersion,
      label: command.label ?? null,
      url: command.url ?? null,
      body: command.body ?? null,
      botScope: command.botScope ?? null,
      botInstanceIds: command.botInstanceIds ?? null,
      hasUrl: command.url !== undefined,
      hasBody: command.body !== undefined,
    });

    return this.mutate(scope, actor, denial, command.idempotencyKey, requestHash, async (tx) => {
      await this.deps.repository.lockTenant(scope, tx);
      const before = await this.lockedActive(scope, tx, id, command.expectedVersion);
      const fields: {
        label?: string;
        url?: string | null;
        body?: string | null;
        botScope?: CustomMenuBotScope;
      } = {};
      const judged: JudgedFields = this.judgeUpdate(before.kind, command);
      if (judged.label !== undefined && judged.label !== before.label) fields.label = judged.label;
      if (judged.url !== undefined && judged.url !== before.url) fields.url = judged.url;
      if (judged.body !== undefined && judged.body !== before.body) fields.body = judged.body;
      const nextScope = command.botScope ?? before.botScope;
      const nextBots =
        command.botScope === undefined && command.botInstanceIds === undefined
          ? undefined
          : botIdsOf(nextScope, command.botInstanceIds ?? [...before.botInstanceIds]);
      const botsChanged =
        nextBots !== undefined &&
        JSON.stringify(nextBots) !== JSON.stringify([...before.botInstanceIds].sort());
      if (nextScope !== before.botScope) fields.botScope = nextScope;
      if (Object.keys(fields).length === 0 && !botsChanged) {
        return { changed: false, button: before };
      }
      if (fields.label !== undefined) {
        await this.assertLabelFree(scope, tx, fields.label, before.id, reserved);
      }
      if (botsChanged && nextBots !== undefined) await this.assertBots(scope, tx, nextBots);
      const after = await this.deps.repository.update(
        scope,
        {
          id,
          expectedVersion: command.expectedVersion,
          patch: fields,
          ...(botsChanged && nextBots !== undefined ? { botInstanceIds: nextBots } : {}),
          now: this.deps.clock.now(),
          adminId: adminIdOf(actor),
        },
        tx,
      );
      if (after === null) throw versionConflict(id, command.expectedVersion);
      await this.audit(scope, actor, tx, denial.action, id, before, after);
      return { changed: true, button: after };
    });
  }

  /** Replace a PHOTO or DOCUMENT button's file. */
  async setMedia(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: unknown,
  ): Promise<CustomMenuButtonMutationResponse> {
    const denial = this.denial(scope, CUSTOM_MENU_BUTTON_AUDIT_ACTIONS.MEDIA_SET, id);
    await this.authorize(scope, actor, denial);
    const command = setCustomMenuButtonMediaRequestSchema.parse(input);
    const file = judgedFile(command.file);
    const requestHash = hashRequest({
      action: denial.action,
      id,
      expectedVersion: command.expectedVersion,
      fileSha256: file.sha256,
      fileName: file.fileName,
    });

    return this.mutate(scope, actor, denial, command.idempotencyKey, requestHash, async (tx) => {
      await this.deps.repository.lockTenant(scope, tx);
      const before = await this.lockedActive(scope, tx, id, command.expectedVersion);
      if (before.kind !== 'PHOTO' && before.kind !== 'DOCUMENT') {
        throw errors.validation(
          CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID,
          'Only a photo or document button has a file.',
        );
      }
      if (file.kind !== before.kind) {
        throw errors.validation(
          CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
          'The file is not of the kind this button sends.',
          { refusal: 'KIND_MISMATCH' },
        );
      }
      if (before.media?.sha256 === file.sha256 && before.media.fileName === file.fileName) {
        return { changed: false, button: before };
      }
      const media = await this.newMedia(scope, tx, file, before.media?.byteLength ?? 0);
      const after = await this.deps.repository.update(
        scope,
        {
          id,
          expectedVersion: command.expectedVersion,
          patch: {},
          media,
          now: this.deps.clock.now(),
          adminId: adminIdOf(actor),
        },
        tx,
      );
      if (after === null) throw versionConflict(id, command.expectedVersion);
      await this.audit(scope, actor, tx, denial.action, id, before, after);
      return { changed: true, button: after };
    });
  }

  /**
   * Archive a button: it is no longer drawn, a tap on a keyboard already in a chat is answered
   * "unavailable", its label is free again and its file is gone. Archiving an archived
   * button is a no-op.
   */
  async archive(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: unknown,
  ): Promise<CustomMenuButtonMutationResponse> {
    const denial = this.denial(scope, CUSTOM_MENU_BUTTON_AUDIT_ACTIONS.ARCHIVED, id);
    await this.authorize(scope, actor, denial);
    const command = archiveCustomMenuButtonRequestSchema.parse(input);
    const requestHash = hashRequest({
      action: denial.action,
      id,
      expectedVersion: command.expectedVersion,
    });

    return this.mutate(scope, actor, denial, command.idempotencyKey, requestHash, async (tx) => {
      await this.deps.repository.lockTenant(scope, tx);
      const before = await this.deps.repository.find(scope, id, tx, true);
      if (before === null) throw unknownButton(id);
      if (before.archivedAt !== null) return { changed: false, button: before };
      if (before.version !== command.expectedVersion) {
        throw versionConflict(id, command.expectedVersion);
      }
      const after = await this.deps.repository.archive(
        scope,
        {
          id,
          expectedVersion: command.expectedVersion,
          now: this.deps.clock.now(),
          adminId: adminIdOf(actor),
        },
        tx,
      );
      if (after === null) throw versionConflict(id, command.expectedVersion);
      await this.audit(scope, actor, tx, denial.action, id, before, after);
      return { changed: true, button: after };
    });
  }

  // --- helpers ----------------------------------------------------------------------

  /** What an update means for a button of this kind: only fields the kind has, each judged. */
  private judgeUpdate(
    kind: CustomMenuButtonKind,
    command: {
      readonly label?: string | undefined;
      readonly url?: string | null | undefined;
      readonly body?: string | null | undefined;
    },
  ): JudgedFields {
    const fields: { label?: string; url?: string | null; body?: string | null } = {};
    if (command.label !== undefined) fields.label = labelOf(command.label);
    if (command.url !== undefined) {
      if (kind !== 'LINK') contentMismatch('a link');
      fields.url = urlOf(command.url);
    }
    if (command.body !== undefined) {
      switch (kind) {
        case 'TEXT':
          fields.body = requiredBodyOf(command.body, CUSTOM_MENU_TEXT_MAX);
          break;
        case 'LINK':
          fields.body = optionalBodyOf(command.body, CUSTOM_MENU_TEXT_MAX);
          break;
        case 'PHOTO':
        case 'DOCUMENT':
          fields.body = optionalBodyOf(command.body, CUSTOM_MENU_CAPTION_MAX);
          break;
      }
    }
    return fields;
  }

  /** The button under its row lock, at the version the caller read, and not archived. */
  private async lockedActive(
    scope: TenantContext,
    tx: TransactionScope,
    id: string,
    expectedVersion: number,
  ): Promise<StoredCustomMenuButton> {
    const row = await this.deps.repository.find(scope, id, tx, true);
    if (row === null || row.archivedAt !== null) throw unknownButton(id);
    if (row.version !== expectedVersion) throw versionConflict(id, expectedVersion);
    return row;
  }

  private async assertLabelFree(
    scope: TenantContext,
    tx: TransactionScope,
    label: string,
    exceptId: string | null,
    reserved: readonly string[],
  ): Promise<void> {
    const taken = await this.deps.repository.findActiveByLabel(scope, label, tx);
    const clash = reserved.some((one) => one.trim() === label);
    if (clash || (taken !== null && taken !== exceptId)) {
      throw errors.conflict(
        CUSTOM_MENU_BUTTON_ERROR_CODES.LABEL_TAKEN,
        'Another button of the main menu already has this label.',
      );
    }
  }

  private async assertBots(
    scope: TenantContext,
    tx: TransactionScope,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const existing = new Set(await this.deps.repository.existingBotIds(scope, ids, tx));
    const unknown = ids.filter((id) => !existing.has(id));
    if (unknown.length > 0) {
      throw errors.validation(
        CUSTOM_MENU_BUTTON_ERROR_CODES.BOT_INVALID,
        'A selected bot is not a bot of this tenant.',
        { botInstanceIds: unknown },
      );
    }
  }

  /** The row for a new file, refused when it would take the tenant past its storage bound. */
  private async newMedia(
    scope: TenantContext,
    tx: TransactionScope,
    file: JudgedFile,
    replacedBytes: number,
  ): Promise<NewCustomMenuMedia> {
    const used = await this.deps.repository.storageBytes(scope, tx);
    if (used - replacedBytes + file.bytes.byteLength > CUSTOM_MENU_STORAGE_MAX_BYTES) {
      throw errors.preconditionFailed(
        CUSTOM_MENU_BUTTON_ERROR_CODES.STORAGE_FULL,
        'The tenant already holds the most button media it may.',
        { maxBytes: CUSTOM_MENU_STORAGE_MAX_BYTES },
      );
    }
    return {
      id: this.deps.ids.uuid(),
      kind: file.kind,
      mimeType: file.mimeType,
      fileName: file.fileName,
      byteLength: file.bytes.byteLength,
      sha256: file.sha256,
      content: file.bytes,
    };
  }

  private async audit(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    action: string,
    id: string,
    before: StoredCustomMenuButton | null,
    after: StoredCustomMenuButton,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action,
        entityType: CUSTOM_MENU_BUTTON_AUDIT_ENTITY,
        entityId: id,
        before: before === null ? null : customMenuButtonViewOf(before),
        after: customMenuButtonViewOf(after),
        result: 'SUCCESS',
      },
      tx,
    );
  }

  /**
   * The shared shape of every write: replay first, then one authorized transaction with
   * scope activity read inside it, and the answer remembered in that transaction.
   */
  private async mutate(
    scope: TenantContext,
    actor: ActorContext,
    denial: MutationDenial,
    idempotencyKey: string,
    requestHash: string,
    work: (tx: TransactionScope) => Promise<{
      readonly changed: boolean;
      readonly button: StoredCustomMenuButton;
    }>,
  ): Promise<CustomMenuButtonMutationResponse> {
    // Its own key space inside the surface's: the builder's keys can never replay these.
    const key = `custom-menu-button:${idempotencyKey}`;
    const replayed = await this.deps.idempotency.find<CustomMenuButtonMutationResponse>(
      scope,
      actor.surface,
      key,
      requestHash,
    );
    if (replayed !== null) return replayed.result;
    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      CUSTOM_MENU_BUTTON_EDIT_PERMISSION,
      denial,
      async (tx) => {
        // INSIDE the transaction: a surface checks when the request arrives, and a stop can
        // commit in between.
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        const { changed, button } = await work(tx);
        const answer: CustomMenuButtonMutationResponse = {
          changed,
          button: customMenuButtonViewOf(button),
        };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          key,
          requestHash,
          answer,
          tx,
        );
        return answer;
      },
    );
  }

  private denial(scope: TenantContext, action: string, id: string | null): MutationDenial {
    return {
      action,
      entityType: CUSTOM_MENU_BUTTON_AUDIT_ENTITY,
      entityId: id ?? scope.tenantId,
    };
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: MutationDenial,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, CUSTOM_MENU_BUTTON_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        CUSTOM_MENU_BUTTON_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }
}

function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' ? actor.id : null;
}

function unknownButton(id: string) {
  return errors.notFound(
    CUSTOM_MENU_BUTTON_ERROR_CODES.UNKNOWN_BUTTON,
    'No such custom button in this tenant, or it is archived.',
    { id },
  );
}

function versionConflict(id: string, expectedVersion: number) {
  return errors.conflict(
    CONTROL_ERROR_CODES.VERSION_CONFLICT,
    'The button changed while you were editing it. Reload and reapply your change.',
    { id, expectedVersion },
  );
}
