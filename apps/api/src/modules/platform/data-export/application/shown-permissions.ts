import type { PermissionKey } from '@nexa/contracts';

/**
 * The permission list a Web Admin session is SHOWN (chrome only, never an authorization):
 * `data.export` is drawn only for a HOSTED bot's session. The installation's own owner holds
 * it too (the owner role holds every key) but his data is not exported
 * (`data_export.not_hosted`); he reaches a hosted bot's export from «میزبانی‌ها». The server
 * still refuses the routes either way; this only decides whether the link is drawn.
 */
export function withoutInstallationDataExport(
  permissions: readonly PermissionKey[],
  session: { readonly tenantId: string; readonly installationTenantId: string | null },
): PermissionKey[] {
  const installation =
    session.installationTenantId === null ||
    session.tenantId.toLowerCase() === session.installationTenantId.toLowerCase();
  return installation ? permissions.filter((key) => key !== 'data.export') : [...permissions];
}
