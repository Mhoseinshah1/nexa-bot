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
} from '../../../../infrastructure/crypto/recovery-kit.js';
import {
  wrapInstallationKey,
  type InstallationKeyring,
} from '../../../../infrastructure/crypto/installation-keyring.js';
import type {
  InstallationKeyRepository,
  InstallationKeyRow,
  RetainedArchiveScanner,
} from './installation-key.ports.js';
import type { RecoveryRequestRepository, RecoveryWorkspaceFactory } from './ports.js';

/**
 * The Recovery Kit's key lifecycle: export, import, list, remove. ADR-0032.
 *
 * Every method authorises first, through the guard, and leaves an audit row for
 * a refusal as well as for a success. No method ever logs, audits, returns or
 * stores a key's bytes or a passphrase: audit rows carry key IDS and
 * FINGERPRINTS, which identify a key without revealing it.
 *
 * THE ONE INVARIANT, stated where it cannot be missed: nothing in this file can
 * change which key ENCRYPTS. `InstallationKeyring.activeKeyId` is the configured
 * one, read-only, and an imported key is written as a decrypt-only row whose
 * schema has no column for anything else.
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

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export class InstallationKeyService {
  constructor(private readonly deps: InstallationKeyServiceDeps) {}

  // --- List ----------------------------------------------------------------

  /**
   * Every key this installation holds, with what still depends on each.
   *
   * `backup.view`, the same LOW permission as the backup list: a key's label and
   * fingerprint reveal nothing about the key, and an operator who cannot see
   * which keys exist cannot judge whether their archives are restorable.
   */
  async list(scope: TenantContext, actor: ActorContext): Promise<InstallationKeySummary[]> {
    await this.authorize(scope, actor, BACKUP_VIEW, 'recovery_kit.keys_list', null);
    // Brought up to date first, so `available` describes the table as it is
    // and not as it was at the last tick.
    await this.deps.loader.refresh();
    const rows = await this.deps.keys.all();
    const dependencies = await this.dependencyCounts(rows);
    const summaries: InstallationKeySummary[] = [];
    const { keyring } = this.deps;

    for (const [keyId, material] of keyring.configuredKeys) {
      const active = keyId === keyring.activeKeyId;
      summaries.push({
        keyId,
        fingerprint: kekFingerprint(material),
        origin: active ? 'CONFIGURED_ACTIVE' : 'CONFIGURED',
        encrypts: active,
        importedAt: null,
        importedBy: null,
        available: true,
        dependencies: dependencies(keyId),
        removable: false,
      });
    }
    for (const row of rows) {
      if (keyring.isConfigured(row.keyId)) continue;
      const counts = dependencies(row.keyId);
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
      throw errors.validation(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
        'The export request is missing a field or has one that is too long.',
      );
    }
    const command = parsed.data;
    if (command.passphrase !== command.passphraseConfirmation) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
        'The two passphrase entries are different.',
      );
    }
    const problem = passphraseProblem(command.passphrase);
    if (problem !== null) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
        `The Recovery Kit passphrase was refused: ${problem}.`,
      );
    }

    try {
      await this.deps.verifyPassword(
        scope,
        actor,
        command.accountPassword,
        context,
        'recovery_kit.export',
      );
    } catch (error) {
      if (isNexaError(error) && error.code === IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS) {
        // A VALIDATION refusal, not a 401: the session is fine, the step-up
        // failed, and a 401 here would sign the operator out of the page they
        // are working in. The DENIED audit row was written by the verifier.
        throw errors.validation(
          PLATFORM_ERROR_CODES.RECOVERY_KIT_REAUTHENTICATION_FAILED,
          'Your account password was not accepted, so no Recovery Kit was produced.',
        );
      }
      throw error;
    }

    // The keyring as of now, including keys another process imported a moment ago.
    await this.deps.loader.refresh();
    const held = [...this.deps.keyring.keys.entries()].map(([keyId, material]) => ({
      keyId,
      material,
    }));
    const kitId = randomUUID();
    const now = this.deps.clock.now();
    const bytes = await sealRecoveryKit({
      keys: held,
      passphrase: command.passphrase,
      profile: this.deps.kdf,
      kitId,
      createdAt: now,
    });

    await this.deps.audit.record(scope, actor, {
      action: 'recovery_kit.exported',
      entityType: 'RecoveryKit',
      entityId: kitId,
      before: null,
      after: {
        kitId,
        keys: held.map((key) => ({ keyId: key.keyId, fingerprint: kekFingerprint(key.material) })),
      },
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
   *   1. authorise, parse, replay;
   *   2. refuse while a destructive recovery holds the installation — its
   *      executor carries the CURRENT keys into the restored database, and a key
   *      that arrived after that read would vanish at the cutover;
   *   3. open the kit — the expensive KDF, outside any transaction;
   *   4. classify every key against what is held: same id and same bytes is
   *      already held, same id and different bytes is a COLLISION and refuses
   *      the whole import;
   *   5. under the table lock, classify again against the rows as they are now,
   *      write every new key in one transaction with its audit row and the
   *      idempotency record — so a failure on the third key leaves the first two
   *      unwritten too.
   */
  async importKit(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<ImportRecoveryKitResponse> {
    await this.authorize(scope, actor, KIT_IMPORT, 'recovery_kit.import', null);
    const parsed = importRecoveryKitRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
        'The import request is missing the kit, the passphrase or an idempotency key.',
      );
    }
    const command = parsed.data;
    const kitBytes = Buffer.from(command.kit, 'base64');
    const requestHash = sha256(kitBytes);

    const found = await this.deps.idempotency.find<ImportRecoveryKitResponse>(
      scope,
      'WEB',
      command.idempotencyKey,
      requestHash,
    );
    if (found !== null) return found.result;

    await this.assertNotBusy();

    let opened: Awaited<ReturnType<typeof openRecoveryKit>>;
    try {
      opened = await openRecoveryKit(kitBytes, command.passphrase);
    } catch (error) {
      await this.auditDenied(scope, actor, 'recovery_kit.import', null, {
        reason: isNexaError(error) ? error.code : 'internal',
      });
      throw error;
    }

    try {
      const classify = (stored: readonly InstallationKeyRow[]) => {
        const imported: HeldKey[] = [];
        const alreadyHeld: HeldKey[] = [];
        const collisions: string[] = [];
        const storedById = new Map(stored.map((row) => [row.keyId, row]));
        const heldFingerprints = new Set(
          [...this.deps.keyring.keys.values()].map((material) => kekFingerprint(material)),
        );
        for (const key of opened.keys) {
          const held = this.deps.keyring.keys.get(key.keyId);
          const row = storedById.get(key.keyId);
          if (held !== undefined) {
            if (sameKey(held, key.material)) alreadyHeld.push(key);
            else collisions.push(key.keyId);
          } else if (row !== undefined) {
            // A stored row this process could not unwrap. The same key is the
            // same key; a different one under that id is a collision.
            if (row.fingerprint === key.fingerprint) alreadyHeld.push(key);
            else collisions.push(key.keyId);
          } else if (heldFingerprints.has(key.fingerprint)) {
            // These exact bytes are already held under another label. Writing
            // them again would add a second name for one key, which helps
            // nothing and makes the list harder to read.
            alreadyHeld.push(key);
          } else {
            imported.push(key);
          }
        }
        return { imported, alreadyHeld, collisions };
      };

      const refuseCollisions = async (collisions: readonly string[]) => {
        if (collisions.length === 0) return;
        await this.auditDenied(scope, actor, 'recovery_kit.import', opened.header.kitId, {
          reason: 'KEY_COLLISION',
          keyIds: collisions,
        });
        throw new NexaError({
          kind: 'CONFLICT',
          code: PLATFORM_ERROR_CODES.RECOVERY_KIT_KEY_COLLISION,
          message:
            'The Recovery Kit holds a key under a name this installation already uses for a ' +
            'different key. Nothing was imported.',
          details: { keyIds: collisions },
        });
      };

      await refuseCollisions(classify(await this.deps.keys.all()).collisions);

      const active = this.deps.keyring.activeKeyId;
      const wrappingKey = this.deps.keyring.configuredKeys.get(active);
      if (wrappingKey === undefined) {
        // Boot refuses a configuration whose active key is not in it, so this is
        // a bug rather than an operator's mistake.
        throw new Error('the active key is not in the configured keyring');
      }

      const result = await this.deps.uow.run(scope, async (tx) => {
        await this.deps.keys.lock(tx);
        const decided = classify(await this.deps.keys.all(tx));
        await refuseCollisions(decided.collisions);

        const now = this.deps.clock.now();
        for (const key of decided.imported) {
          const material = opened.keys.find((entry) => entry.keyId === key.keyId)!.material;
          await this.deps.keys.insert(tx, {
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
          });
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
        return response;
      });

      await this.deps.loader.refresh();
      return result;
    } finally {
      for (const key of opened.keys) key.material.fill(0);
    }
  }

  // --- Remove --------------------------------------------------------------

  /**
   * Removes ONE imported key, only when nothing retained needs it.
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
      throw errors.validation(
        PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_FOUND,
        'The removal request does not name a key.',
      );
    }
    const command = parsed.data;
    if (command.confirmation.trim() !== command.keyId) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.RECOVERY_CONFIRMATION_INVALID,
        'Type the key name exactly to confirm its removal.',
      );
    }
    if (this.deps.keyring.isConfigured(command.keyId)) {
      await this.auditDenied(scope, actor, 'installation_key.remove', command.keyId, {
        reason: 'CONFIGURED_KEY',
      });
      throw errors.validation(
        PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_REMOVABLE,
        'This key is part of the server configuration and is not removed from here.',
      );
    }

    const requestHash = sha256(Buffer.from(command.keyId, 'utf8'));
    const found = await this.deps.idempotency.find<{ keyId: string; removed: true }>(
      scope,
      'WEB',
      command.idempotencyKey,
      requestHash,
    );
    if (found !== null) return found.result;

    await this.assertNotBusy();

    const rows = await this.deps.keys.all();
    const row = rows.find((candidate) => candidate.keyId === command.keyId);
    if (row === undefined) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_FOUND,
        'No imported key has that name.',
      );
    }

    // The filesystem half of the dependency check, before the transaction: it
    // reads archive headers off disk, which is not something to do holding a
    // lock. Nothing can create a NEW dependency on an imported key — only the
    // configured active key ever seals anything — so this cannot go stale in the
    // direction that matters.
    const counts = (await this.dependencyCounts(rows))(row.keyId);
    if (totalOf(counts) > 0) {
      await this.auditDenied(scope, actor, 'installation_key.remove', row.keyId, {
        reason: 'IN_USE',
        dependencies: counts,
      });
      throw errors.conflict(
        PLATFORM_ERROR_CODES.INSTALLATION_KEY_IN_USE,
        'Something this server still keeps needs this key, so it was not removed.',
        { dependencies: counts },
      );
    }

    const result = await this.deps.uow.run(scope, async (tx) => {
      await this.deps.keys.lock(tx);
      // The database half again, under the lock: another imported key may have
      // been wrapped under this one by a restore in between.
      const locked = await this.deps.keys.all(tx);
      if (locked.some((other) => other.wrappedUnderKeyId === row.keyId)) {
        throw errors.conflict(
          PLATFORM_ERROR_CODES.INSTALLATION_KEY_IN_USE,
          'Another imported key is stored under this one, so it was not removed.',
        );
      }
      const removed = await this.deps.keys.deleteIfUnchanged(tx, row.keyId, row.fingerprint);
      if (!removed) {
        throw errors.notFound(
          PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_FOUND,
          'That key was removed or replaced while this request was being checked.',
        );
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'installation_key.removed',
          entityType: 'InstallationKey',
          entityId: row.keyId,
          before: { keyId: row.keyId, fingerprint: row.fingerprint, kitId: row.kitId },
          after: null,
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
      return response;
    });

    await this.deps.loader.refresh();
    return result;
  }

  // --- Helpers -------------------------------------------------------------

  /** What depends on each key id, computed once for a whole list. */
  private async dependencyCounts(
    rows: readonly InstallationKeyRow[],
  ): Promise<(keyId: string) => InstallationKeyDependencies> {
    const [secrets, archives, workspaces] = await Promise.all([
      this.deps.keys.secretCountsByKeyId(),
      this.deps.archives.retainedArchiveKeyIds(),
      this.deps.keys.openRecoveryWorkspaces(),
    ]);
    const recoveries = new Map<string, number>();
    for (const directory of workspaces) {
      const keyId = await this.deps.archives.archiveKeyId(
        this.deps.workspaces.open(directory).archivePath,
      );
      if (keyId !== null) recoveries.set(keyId, (recoveries.get(keyId) ?? 0) + 1);
    }
    return (keyId) => ({
      secrets: secrets.get(keyId) ?? 0,
      wrappedKeys: rows.filter((row) => row.wrappedUnderKeyId === keyId).length,
      retainedArchives: archives.get(keyId) ?? 0,
      openRecoveries: recoveries.get(keyId) ?? 0,
    });
  }

  private async assertNotBusy(): Promise<void> {
    const lock = await this.deps.recoveries.installationLock();
    if (lock !== null && lock.destructive) {
      throw errors.conflict(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_BUSY,
        'A restore is in progress, so this installation’s keys cannot change until it finishes.',
        { recoveryId: lock.recoveryId },
      );
    }
  }

  private async auditDenied(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    entityId: string | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(scope, actor, {
      action,
      entityType: action.startsWith('installation_key') ? 'InstallationKey' : 'RecoveryKit',
      entityId,
      before: null,
      after,
      result: 'DENIED',
    });
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
