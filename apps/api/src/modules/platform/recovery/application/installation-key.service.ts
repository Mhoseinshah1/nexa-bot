import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  errors,
  exportRecoveryKitRequestSchema,
  IDENTITY_ERROR_CODES,
  importRecoveryKitRequestSchema,
  isNexaError,
  NexaError,
  PLATFORM_ERROR_CODES,
  RECOVERY_KIT_FILE_EXTENSION,
  RECOVERY_KIT_MAX_KEYS,
  removeInstallationKeyRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type ImportRecoveryKitResponse,
  type InstallationKeyDependencies,
  type InstallationKeySummary,
  type PermissionKey,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { recordMutationDenial } from '../../access/application/authorized-mutation.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import {
  kekFingerprint,
  openRecoveryKit,
  passphraseProblem,
  sealRecoveryKit,
  type KitKdfProfile,
  type OpenedKit,
} from '../../../../infrastructure/crypto/recovery-kit.js';
import {
  wrapInstallationKey,
  type InstallationKeyring,
} from '../../../../infrastructure/crypto/installation-keyring.js';
import type {
  InstallationKeyRepository,
  InstallationKeyRow,
  RetainedArchive,
  RetainedArchiveScanner,
} from './installation-key.ports.js';
import type { RecoveryRequestRepository, RecoveryWorkspaceFactory } from './ports.js';

/**
 * The Recovery Kit's key lifecycle: export, import, list, remove. ADR-0032.
 *
 * Every method authorises first, through the guard, and leaves an audit row for
 * every refusal as well as for a success. No method ever logs, audits, returns
 * or stores a key's bytes or a passphrase: audit rows carry key IDS and
 * FINGERPRINTS, which identify a key without revealing it.
 *
 * THE ONE INVARIANT, stated where it cannot be missed: nothing in this file can
 * change which key ENCRYPTS. `InstallationKeyring.activeKeyId` is the configured
 * one, read-only, and an imported key is written as a decrypt-only row whose
 * schema has no column for anything else.
 *
 * SCOPE ACTIVITY. These writes do not read `ScopeActivityReader`: the keys are
 * the INSTALLATION's, not a tenant's — the same stated exception the recovery
 * module takes (`docs/conventions.md`). They do pass the installation write gate
 * (the unit of work), and refuse while a destructive recovery holds the keys.
 */

export const KIT_EXPORT: PermissionKey = 'recovery.kit.export';
export const KIT_IMPORT: PermissionKey = 'recovery.kit.import';
export const KEY_REMOVE: PermissionKey = 'recovery.key.remove';
const BACKUP_VIEW: PermissionKey = 'backup.view';

export interface InstallationKeyServiceDeps {
  readonly keyring: InstallationKeyring;
  readonly loader: { refresh(): Promise<unknown> };
  readonly keys: InstallationKeyRepository;
  readonly archives: RetainedArchiveScanner;
  readonly recoveries: Pick<RecoveryRequestRepository, 'installationLock'>;
  /** To find an unfinished recovery's uploaded archive from its recorded workspace. */
  readonly workspaces: Pick<RecoveryWorkspaceFactory, 'open'>;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: { record(scope: ScopeContext, event: unknown): Promise<unknown> };
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly kdf: KitKdfProfile;
  /** Step-up: the administrator's own password, throttled like login. */
  readonly verifyPassword: (
    scope: ScopeContext,
    actor: ActorContext,
    password: string,
    context: { ip: string | null },
    action: string,
  ) => Promise<void>;
}

export interface ExportedKit {
  readonly bytes: Buffer;
  readonly kitId: string;
  readonly filename: string;
  readonly keyCount: number;
}

/** A key, stated so a summary can be built for it whatever its origin. */
interface HeldKey {
  readonly keyId: string;
  readonly fingerprint: string;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A live row: one that still holds a key. A tombstone has no wrapped bytes. */
function isLive(row: InstallationKeyRow): boolean {
  return row.wrappedMaterial !== null;
}

type LockedOutcome<T> =
  | { readonly kind: 'done'; readonly result: T }
  | {
      readonly kind: 'refused';
      readonly error: NexaError;
      readonly audit: Record<string, unknown>;
    };

export class InstallationKeyService {
  constructor(private readonly deps: InstallationKeyServiceDeps) {}

  // --- List ----------------------------------------------------------------

  /**
   * Every key this installation holds, with what still depends on each.
   *
   * `backup.view`, the same LOW permission as the backup list: a label reveals
   * nothing about a key, and an operator who cannot see which keys exist cannot
   * judge whether their archives are restorable. A CONFIGURED key's fingerprint
   * is shown only to an actor who may export the kit — it identifies the
   * server's own key, and that is for the people who hold it.
   *
   * It does not reload the keyring: a list is a read, and a read that rebuilt the
   * keyring was how a LOW-permission page view could disturb a key in use. The
   * timer and every write keep it current.
   */
  async list(scope: TenantContext, actor: ActorContext): Promise<InstallationKeySummary[]> {
    await this.authorize(scope, actor, BACKUP_VIEW, 'recovery_kit.keys_list', null);
    const showConfigured = await this.deps.guard.has(scope, actor, KIT_EXPORT);
    const rows = (await this.deps.keys.all()).filter(isLive);
    const dependencies = await this.dependencyCounts(rows);
    const summaries: InstallationKeySummary[] = [];
    const { keyring } = this.deps;

    for (const [keyId, material] of keyring.configuredKeys) {
      const active = keyId === keyring.activeKeyId;
      summaries.push({
        keyId,
        fingerprint: showConfigured ? kekFingerprint(material) : null,
        origin: active ? 'CONFIGURED_ACTIVE' : 'CONFIGURED',
        encrypts: active,
        importedAt: null,
        importedBy: null,
        available: true,
        dependencies: dependencies(keyId, null),
        arrivedByRestore: false,
        removable: false,
      });
    }
    for (const row of rows) {
      if (keyring.isConfigured(row.keyId)) continue;
      const counts = dependencies(row.keyId, row.importedAt);
      summaries.push({
        keyId: row.keyId,
        fingerprint: row.fingerprint,
        origin: 'IMPORTED',
        // Never, and asserted by a test: there is no path from a row to this
        // being true.
        encrypts: false,
        importedAt: row.importedAt.toISOString(),
        importedBy: row.importedByLabel,
        available: keyring.importedKeys.has(row.keyId),
        dependencies: counts,
        arrivedByRestore: row.restoredAt !== null,
        removable: totalOf(counts) === 0,
      });
    }
    return summaries;
  }

  // --- Export --------------------------------------------------------------

  /**
   * Seals every key this installation holds into a kit.
   *
   * EVERY key, configured and imported: the kit exists to open this
   * installation's archives — sealed under the active key — AND whatever older
   * archives this installation could itself open. A kit that left one out would
   * look complete until the archive that needed it.
   *
   * Not idempotent by key and not meant to be: every export draws a fresh salt
   * and nonce, and two kits of the same keys are two files. It changes nothing
   * durable but its audit row.
   */
  async exportKit(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
    context: { ip: string | null },
  ): Promise<ExportedKit> {
    await this.authorize(scope, actor, KIT_EXPORT, 'recovery_kit.export', null);
    const parsed = exportRecoveryKitRequestSchema.safeParse(input);
    if (!parsed.success) {
      // No zod details: they would echo the field values back, and the values
      // are a password and a passphrase.
      throw await this.refused(
        scope,
        actor,
        'recovery_kit.export',
        null,
        { reason: 'MALFORMED_REQUEST' },
        errors.validation(
          PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
          'The export request is missing a field or has one that is too long.',
        ),
      );
    }
    const command = parsed.data;
    if (command.passphrase !== command.passphraseConfirmation) {
      throw await this.refused(
        scope,
        actor,
        'recovery_kit.export',
        null,
        { reason: 'PASSPHRASE_MISMATCH' },
        errors.validation(
          PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
          'The two passphrase entries are different.',
        ),
      );
    }
    const problem = passphraseProblem(command.passphrase);
    if (problem !== null) {
      throw await this.refused(
        scope,
        actor,
        'recovery_kit.export',
        null,
        { reason: 'PASSPHRASE_TOO_WEAK' },
        errors.validation(
          PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
          `The Recovery Kit passphrase was refused: ${problem}.`,
        ),
      );
    }

    await this.stepUp(scope, actor, command.accountPassword, context, 'recovery_kit.export');

    // The keyring as of now, including keys another process imported a moment ago.
    await this.deps.loader.refresh();
    const held = [...this.deps.keyring.keys.entries()].map(([keyId, material]) => ({
      keyId,
      // Copies, so nothing the keyring does while scrypt runs can change what
      // is sealed — and fingerprinted BEFORE the await, for the same reason.
      material: Buffer.from(material),
    }));
    const audited = held.map((key) => ({
      keyId: key.keyId,
      fingerprint: kekFingerprint(key.material),
    }));
    const kitId = randomUUID();
    const now = this.deps.clock.now();
    let bytes: Buffer;
    try {
      bytes = await sealRecoveryKit({
        keys: held,
        passphrase: command.passphrase,
        profile: this.deps.kdf,
        kitId,
        createdAt: now,
      });
    } catch (error) {
      if (isNexaError(error)) {
        throw await this.refused(
          scope,
          actor,
          'recovery_kit.export',
          null,
          { reason: error.code },
          error,
        );
      }
      throw error;
    } finally {
      for (const key of held) key.material.fill(0);
    }

    await this.deps.audit.record(scope, actor, {
      action: 'recovery_kit.exported',
      entityType: 'RecoveryKit',
      entityId: kitId,
      before: null,
      after: { kitId, keys: audited },
      reason: 'An administrator exported the Recovery Kit.',
      result: 'SUCCESS',
    });

    const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
    return {
      bytes,
      kitId,
      filename: `nexa-recovery-kit-${stamp}${RECOVERY_KIT_FILE_EXTENSION}`,
      keyCount: held.length,
    };
  }

  // --- Import --------------------------------------------------------------

  /**
   * Adds the kit's keys as DECRYPT-ONLY keys. All of them, or none.
   *
   * The order is the contract:
   *
   *   1. authorise, parse, and STEP UP: the administrator's own password, as on
   *      export. A stolen session must not be able to import a key of its own
   *      choosing — with one, an archive forged under it would open here;
   *   2. replay, keyed by this actor and this kit, and only after the passphrase
   *      has opened the kit again — a replay is not a way around either proof;
   *   3. refuse while a destructive recovery holds the installation — its
   *      executor carries the CURRENT keys into the restored database, and a key
   *      that arrived after that read would vanish at the cutover;
   *   4. open the kit — the expensive KDF, outside any transaction;
   *   5. classify every key against what is held: same id and same bytes is
   *      already held, same id and different bytes is a COLLISION and refuses
   *      the whole import. The same bytes under a NEW id are imported as that id
   *      — a name the kit uses must be a name this installation can look up;
   *   6. under the table lock, re-check the recovery and classify again, then
   *      write every new key in one transaction with its audit row and the
   *      idempotency record — so a failure on the third key leaves the first two
   *      unwritten too.
   */
  async importKit(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
    context: { ip: string | null } = { ip: null },
  ): Promise<ImportRecoveryKitResponse> {
    await this.authorize(scope, actor, KIT_IMPORT, 'recovery_kit.import', null);
    const parsed = importRecoveryKitRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw await this.refused(
        scope,
        actor,
        'recovery_kit.import',
        null,
        { reason: 'MALFORMED_REQUEST' },
        errors.validation(
          PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
          'The import request is missing the kit, the passphrase, the account password or an idempotency key.',
        ),
      );
    }
    const command = parsed.data;
    await this.stepUp(scope, actor, command.accountPassword, context, 'recovery_kit.import');

    const kitBytes = Buffer.from(command.kit, 'base64');
    // Bound to the ACTOR as well as the kit: another administrator's replay of the
    // same key gets a mismatch, not this actor's result.
    const requestHash = sha256(`${actor.id}\n${sha256(kitBytes)}`);
    const found = await this.deps.idempotency.find<ImportRecoveryKitResponse>(
      scope,
      'WEB',
      command.idempotencyKey,
      requestHash,
    );

    let opened: OpenedKit;
    try {
      opened = await openRecoveryKit(kitBytes, command.passphrase);
    } catch (error) {
      throw await this.refused(
        scope,
        actor,
        'recovery_kit.import',
        null,
        { reason: isNexaError(error) ? error.code : 'internal' },
        error,
      );
    }

    try {
      // A replay answers only once the passphrase has opened the kit: the earlier
      // success is not handed back for a passphrase that would have failed.
      if (found !== null) return found.result;

      const busy = await this.busyRefusal();
      if (busy !== null) {
        throw await this.refused(scope, actor, 'recovery_kit.import', null, busy.audit, busy.error);
      }

      const classify = (stored: readonly InstallationKeyRow[]) => {
        const imported: HeldKey[] = [];
        const alreadyHeld: HeldKey[] = [];
        const collisions: string[] = [];
        const storedById = new Map(stored.map((row) => [row.keyId, row]));
        for (const key of opened.keys) {
          const held = this.deps.keyring.keys.get(key.keyId);
          const row = storedById.get(key.keyId);
          if (held !== undefined) {
            if (sameKey(held, key.material)) alreadyHeld.push(key);
            else collisions.push(key.keyId);
          } else if (row !== undefined && isLive(row)) {
            // A stored row this process could not unwrap. The same key is the
            // same key; a different one under that id is a collision.
            if (row.fingerprint === key.fingerprint) alreadyHeld.push(key);
            else collisions.push(key.keyId);
          } else {
            // New — or a TOMBSTONE of that id, which an import may revive: the
            // removal is undone by the same explicit, audited act that would
            // have added it. Bytes already held under ANOTHER id are imported
            // under this one too: a kit's name for a key must resolve here.
            imported.push(key);
          }
        }
        return { imported, alreadyHeld, collisions };
      };

      const collisionError = (collisions: readonly string[]) =>
        new NexaError({
          kind: 'CONFLICT',
          code: PLATFORM_ERROR_CODES.RECOVERY_KIT_KEY_COLLISION,
          message:
            'The Recovery Kit holds a key under a name this installation already uses for a ' +
            'different key. Nothing was imported.',
          details: { keyIds: collisions },
        });

      const early = classify(await this.deps.keys.all());
      if (early.collisions.length > 0) {
        throw await this.refused(
          scope,
          actor,
          'recovery_kit.import',
          opened.header.kitId,
          { reason: 'KEY_COLLISION', keyIds: early.collisions },
          collisionError(early.collisions),
        );
      }

      const tooMany = (count: number) =>
        this.deps.keyring.keys.size + count > RECOVERY_KIT_MAX_KEYS
          ? new NexaError({
              kind: 'VALIDATION',
              code: PLATFORM_ERROR_CODES.RECOVERY_KIT_TOO_MANY_KEYS,
              message:
                `This would leave the installation holding more than ${String(RECOVERY_KIT_MAX_KEYS)} ` +
                'keys, more than one Recovery Kit can carry. Nothing was imported.',
            })
          : null;
      const overLimit = tooMany(early.imported.length);
      if (overLimit !== null) {
        throw await this.refused(
          scope,
          actor,
          'recovery_kit.import',
          opened.header.kitId,
          {
            reason: 'TOO_MANY_KEYS',
            held: this.deps.keyring.keys.size,
            adding: early.imported.length,
          },
          overLimit,
        );
      }

      const active = this.deps.keyring.activeKeyId;
      const wrappingKey = this.deps.keyring.configuredKeys.get(active);
      if (wrappingKey === undefined) {
        // Boot refuses a configuration whose active key is not in it, so this is
        // a bug rather than an operator's mistake.
        throw new Error('the active key is not in the configured keyring');
      }

      const outcome = await this.deps.uow.run(
        scope,
        async (tx): Promise<LockedOutcome<ImportRecoveryKitResponse>> => {
          await this.deps.keys.lock(tx);
          // Again, under the lock: a recovery confirmed since the first check
          // would carry the keys as they were before this write.
          const lockedBusy = await this.busyRefusal(tx);
          if (lockedBusy !== null) return { kind: 'refused', ...lockedBusy };
          const decided = classify(await this.deps.keys.all(tx));
          if (decided.collisions.length > 0) {
            return {
              kind: 'refused',
              error: collisionError(decided.collisions),
              audit: { reason: 'KEY_COLLISION', keyIds: decided.collisions },
            };
          }
          const lockedOverLimit = tooMany(decided.imported.length);
          if (lockedOverLimit !== null) {
            return { kind: 'refused', error: lockedOverLimit, audit: { reason: 'TOO_MANY_KEYS' } };
          }

          const now = this.deps.clock.now();
          for (const key of decided.imported) {
            const material = opened.keys.find((entry) => entry.keyId === key.keyId)!.material;
            const written = await this.deps.keys.upsertImported(tx, {
              id: this.deps.ids.uuid(),
              keyId: key.keyId,
              fingerprint: key.fingerprint,
              wrappedMaterial: wrapInstallationKey({
                keyId: key.keyId,
                material,
                wrappingKeyId: active,
                wrappingKey,
              }),
              wrappedUnderKeyId: active,
              source: 'RECOVERY_KIT',
              kitId: opened.header.kitId,
              importedAt: now,
              importedByAdminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
              importedByLabel: actor.label,
              removedAt: null,
              removedByLabel: null,
              restoredAt: null,
            });
            if (!written) {
              // A live row appeared between the classification and this write.
              // Thrown, so the transaction rolls back every key written before it.
              throw collisionError([key.keyId]);
            }
          }

          const response: ImportRecoveryKitResponse = {
            kitId: opened.header.kitId,
            imported: decided.imported.map(({ keyId, fingerprint }) => ({ keyId, fingerprint })),
            alreadyHeld: decided.alreadyHeld.map(({ keyId, fingerprint }) => ({
              keyId,
              fingerprint,
            })),
          };
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'recovery_kit.imported',
              entityType: 'RecoveryKit',
              entityId: opened.header.kitId,
              before: null,
              after: { ...response, decryptOnly: true, encryptingKeyUnchanged: active },
              reason: 'An administrator imported a Recovery Kit as decrypt-only keys.',
              result: 'SUCCESS',
            },
            tx,
          );
          await rememberOnce(
            this.deps.idempotency,
            scope,
            'WEB',
            command.idempotencyKey,
            requestHash,
            response,
            tx,
          );
          return { kind: 'done', result: response };
        },
      );

      if (outcome.kind === 'refused') {
        throw await this.refused(
          scope,
          actor,
          'recovery_kit.import',
          opened.header.kitId,
          outcome.audit,
          outcome.error,
        );
      }
      await this.deps.loader.refresh();
      return outcome.result;
    } finally {
      for (const key of opened.keys) key.material.fill(0);
    }
  }

  // --- Remove --------------------------------------------------------------

  /**
   * Removes ONE imported key, only when nothing retained needs it.
   *
   * Removal leaves a TOMBSTONE — the row with its bytes erased — rather than
   * deleting it: the executor carries tombstones into a restored candidate, so
   * restoring a backup taken before the removal cannot quietly bring the key
   * back.
   *
   * Configured keys are not removable here at all: they are the server's
   * configuration, and the host is where that changes (`botctl secrets
   * retire-check` says whether it is safe). The confirmation is the key's own
   * label, typed — proof the operator is looking at the row they mean.
   */
  async removeKey(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<{ keyId: string; removed: true }> {
    await this.authorize(scope, actor, KEY_REMOVE, 'installation_key.remove', null);
    const parsed = removeInstallationKeyRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw await this.refused(
        scope,
        actor,
        'installation_key.remove',
        null,
        { reason: 'MALFORMED_REQUEST' },
        errors.validation(
          PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_FOUND,
          'The removal request does not name a key.',
        ),
      );
    }
    const command = parsed.data;
    if (command.confirmation.trim() !== command.keyId) {
      throw await this.refused(
        scope,
        actor,
        'installation_key.remove',
        command.keyId,
        { reason: 'CONFIRMATION_MISMATCH' },
        errors.validation(
          PLATFORM_ERROR_CODES.RECOVERY_CONFIRMATION_INVALID,
          'Type the key name exactly to confirm its removal.',
        ),
      );
    }
    if (this.deps.keyring.isConfigured(command.keyId)) {
      throw await this.refused(
        scope,
        actor,
        'installation_key.remove',
        command.keyId,
        { reason: 'CONFIGURED_KEY' },
        errors.validation(
          PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_REMOVABLE,
          'This key is part of the server configuration and is not removed from here.',
        ),
      );
    }

    const requestHash = sha256(`${actor.id}\n${command.keyId}`);
    const found = await this.deps.idempotency.find<{ keyId: string; removed: true }>(
      scope,
      'WEB',
      command.idempotencyKey,
      requestHash,
    );
    if (found !== null) return found.result;

    const busy = await this.busyRefusal();
    if (busy !== null) {
      throw await this.refused(
        scope,
        actor,
        'installation_key.remove',
        command.keyId,
        busy.audit,
        busy.error,
      );
    }

    const rows = (await this.deps.keys.all()).filter(isLive);
    const row = rows.find((candidate) => candidate.keyId === command.keyId);
    if (row === undefined) {
      throw await this.refused(
        scope,
        actor,
        'installation_key.remove',
        command.keyId,
        { reason: 'NOT_FOUND' },
        errors.notFound(
          PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_FOUND,
          'No imported key has that name.',
        ),
      );
    }

    // The filesystem half of the dependency check, before the transaction: it
    // reads archive headers off disk, which is not something to do holding a
    // lock. Nothing can create a NEW dependency on an imported key — only the
    // configured active key ever seals anything — so this cannot go stale in the
    // direction that matters.
    const counts = (await this.dependencyCounts(rows))(row.keyId, row.importedAt);
    if (totalOf(counts) > 0) {
      throw await this.refused(
        scope,
        actor,
        'installation_key.remove',
        row.keyId,
        { reason: 'IN_USE', dependencies: counts },
        errors.conflict(
          PLATFORM_ERROR_CODES.INSTALLATION_KEY_IN_USE,
          'Something this server still keeps needs this key, so it was not removed.',
          { dependencies: counts },
        ),
      );
    }

    const outcome = await this.deps.uow.run(
      scope,
      async (tx): Promise<LockedOutcome<{ keyId: string; removed: true }>> => {
        await this.deps.keys.lock(tx);
        const lockedBusy = await this.busyRefusal(tx);
        if (lockedBusy !== null) return { kind: 'refused', ...lockedBusy };
        // The database half again, under the lock: another imported key may have
        // been wrapped under this one by a restore in between.
        const locked = await this.deps.keys.all(tx);
        if (locked.some((other) => other.wrappedUnderKeyId === row.keyId)) {
          return {
            kind: 'refused',
            error: errors.conflict(
              PLATFORM_ERROR_CODES.INSTALLATION_KEY_IN_USE,
              'Another imported key is stored under this one, so it was not removed.',
            ),
            audit: { reason: 'IN_USE', dependencies: { wrappedKeys: 1 } },
          };
        }
        const now = this.deps.clock.now();
        const removed = await this.deps.keys.tombstone(
          tx,
          row.keyId,
          row.fingerprint,
          now,
          actor.label ?? actor.id ?? 'an administrator',
        );
        if (!removed) {
          return {
            kind: 'refused',
            error: errors.notFound(
              PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_FOUND,
              'That key was removed or replaced while this request was being checked.',
            ),
            audit: { reason: 'NOT_FOUND' },
          };
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'installation_key.removed',
            entityType: 'InstallationKey',
            entityId: row.keyId,
            before: { keyId: row.keyId, fingerprint: row.fingerprint, kitId: row.kitId },
            after: { tombstone: true },
            reason: 'An administrator removed an imported decrypt-only key nothing depended on.',
            result: 'SUCCESS',
          },
          tx,
        );
        const response = { keyId: row.keyId, removed: true as const };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          command.idempotencyKey,
          requestHash,
          response,
          tx,
        );
        return { kind: 'done', result: response };
      },
    );

    if (outcome.kind === 'refused') {
      throw await this.refused(
        scope,
        actor,
        'installation_key.remove',
        row.keyId,
        outcome.audit,
        outcome.error,
      );
    }
    await this.deps.loader.refresh();
    return outcome.result;
  }

  // --- Helpers -------------------------------------------------------------

  /**
   * What depends on each key, computed once for a whole list.
   *
   * `retainedArchives` counts an archive on this server's disk that is sealed
   * under the key, OR that was taken while the key was held (at or after
   * `heldSince`). The second is the one an archive header cannot show: a backup
   * taken while restored secrets were still sealed under an imported key carries
   * those secrets, and removing the key would leave that backup restorable only
   * with a kit. Conservative on purpose — it may count a backup that holds
   * nothing under the key, and that errs towards keeping a key.
   *
   * FAIL CLOSED throughout: an archive or upload that exists and cannot be read
   * counts against EVERY key, because it may need any of them.
   */
  private async dependencyCounts(
    rows: readonly InstallationKeyRow[],
  ): Promise<(keyId: string, heldSince: Date | null) => InstallationKeyDependencies> {
    const [secrets, scanned, workspaces] = await Promise.all([
      this.deps.keys.secretCountsByKeyId(),
      // FAIL CLOSED: a backup directory that cannot be listed is one unreadable
      // archive — a dependency of every key — never "no archives".
      this.deps.archives
        .retainedArchives()
        .catch(() => ({ archives: [] as readonly RetainedArchive[], unreadable: 1 })),
      this.deps.keys.openRecoveryWorkspaces(),
    ]);
    const recoveries = new Map<string, number>();
    let unreadableUploads = 0;
    for (const directory of workspaces) {
      try {
        const keyId = await this.deps.archives.archiveKeyId(
          this.deps.workspaces.open(directory).archivePath,
        );
        if (keyId !== null) recoveries.set(keyId, (recoveries.get(keyId) ?? 0) + 1);
      } catch {
        // An upload still arriving, or unreadable: it may name any key.
        unreadableUploads += 1;
      }
    }
    const retained = (keyId: string, heldSince: Date | null) =>
      scanned.unreadable +
      scanned.archives.filter(
        (archive: RetainedArchive) =>
          archive.keyId === keyId ||
          (heldSince !== null && archive.takenAt.getTime() >= heldSince.getTime()),
      ).length;
    return (keyId, heldSince) => ({
      secrets: secrets.get(keyId) ?? 0,
      wrappedKeys: rows.filter((row) => row.wrappedUnderKeyId === keyId).length,
      retainedArchives: retained(keyId, heldSince),
      openRecoveries: unreadableUploads + (recoveries.get(keyId) ?? 0),
    });
  }

  /** The step-up, as one refusal: a 400 that keeps the operator signed in. */
  private async stepUp(
    scope: TenantContext,
    actor: ActorContext,
    password: string,
    context: { ip: string | null },
    action: string,
  ): Promise<void> {
    try {
      await this.deps.verifyPassword(scope, actor, password, context, action);
    } catch (error) {
      if (isNexaError(error) && error.code === IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS) {
        // A VALIDATION refusal, not a 401: the session is fine, the step-up
        // failed, and a 401 here would sign the operator out of the page they
        // are working in. The DENIED audit row was written by the verifier.
        throw errors.validation(
          PLATFORM_ERROR_CODES.RECOVERY_KIT_REAUTHENTICATION_FAILED,
          'Your account password was not accepted, so nothing was done.',
        );
      }
      throw error;
    }
  }

  /** Null when no destructive recovery holds the installation; else the refusal. */
  private async busyRefusal(
    tx?: unknown,
  ): Promise<{ readonly error: NexaError; readonly audit: Record<string, unknown> } | null> {
    const lock = await this.deps.recoveries.installationLock(tx);
    if (lock === null || !lock.destructive) return null;
    return {
      error: errors.conflict(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_BUSY,
        'A restore is in progress, so this installation’s keys cannot change until it finishes.',
        { recoveryId: lock.recoveryId },
      ),
      audit: { reason: 'RECOVERY_IN_PROGRESS', recoveryId: lock.recoveryId },
    };
  }

  /** Audits a refusal, then hands back the error to throw. Every refusal leaves a row. */
  private async refused(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    entityId: string | null,
    after: Record<string, unknown>,
    error: unknown,
  ): Promise<unknown> {
    await this.deps.audit.record(scope, actor, {
      action,
      entityType: action.startsWith('installation_key') ? 'InstallationKey' : 'RecoveryKit',
      entityId,
      before: null,
      after,
      result: 'DENIED',
    });
    return error;
  }

  private async authorize(
    scope: ScopeContext,
    actor: ActorContext,
    permission: PermissionKey,
    action: string,
    entityId: string | null,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (denied) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog as never },
        scope,
        actor,
        permission,
        {
          action,
          entityType: action.startsWith('installation_key') ? 'InstallationKey' : 'RecoveryKit',
          entityId,
        },
        denied,
      );
      throw denied;
    }
  }
}

function totalOf(counts: InstallationKeyDependencies): number {
  return counts.secrets + counts.wrappedKeys + counts.retainedArchives + counts.openRecoveries;
}
