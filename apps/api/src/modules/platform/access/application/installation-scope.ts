import { errors, isSystemContext, PLATFORM_ERROR_CODES, type ScopeContext } from '@nexa/contracts';

/**
 * ADR-0039 finding F1: the installation's backup and recovery act on the WHOLE database, so
 * they answer the installation tenant's scope only. A hosted or reseller bot's Web Admin —
 * whose owner holds every key in their own tenant — gets not-found, before anything is read,
 * and so does every scope while no installation tenant is resolved.
 *
 * Not-found rather than permission-denied, as `RecoveryService` always said it would be: a
 * denial for an archive or a request that exists in another scope is itself a disclosure.
 * The guard drops `INSTALLATION_ONLY_PERMISSIONS` outside this scope too; this check is the
 * second wall, and the one that also covers the keys any tenant holds (`backup.view`).
 */
export function requireInstallationScope(
  scope: ScopeContext,
  installationTenantId: () => string | null,
): void {
  const installation = installationTenantId();
  if (
    installation === null ||
    isSystemContext(scope) ||
    scope.tenantId.toLowerCase() !== installation.toLowerCase()
  ) {
    throw errors.notFound(
      PLATFORM_ERROR_CODES.BACKUP_INSTALLATION_ONLY,
      'Backups and restores of this installation are managed from its own Web Admin.',
    );
  }
}
