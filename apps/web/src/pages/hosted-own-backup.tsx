import { useQuery } from '@tanstack/react-query';
import { INSTALLATION_ONLY_PERMISSIONS, type PermissionKey } from '@nexa/contracts';
import { fetchOwnHostedBackup } from '../api/client';
import { formatTimestamp } from '../format';
import { t } from '../i18n/web.fa';
import type { Route } from '../router';
import { Banner, KV, PageHead, StateSwitch } from '../ui/kit';
import { RecoveryPage } from './recovery';

/**
 * Phase 6B PR-2 (ADR-0039 § 7): the backup page of a HOSTED bot's own Web Admin says that
 * backups are managed by the host, and shows the last backup's time — no list, no password,
 * no download, no restore. A session that holds any installation-only backup key is the
 * installation's and gets the full page; one that holds none asks the server, and a
 * not-found (this IS the installation) falls back to the full page too.
 */
export function BackupRoutePage({
  route,
  permissions,
}: {
  route: Route;
  permissions: readonly PermissionKey[];
}) {
  const installationKeys = permissions.some((key) =>
    (INSTALLATION_ONLY_PERMISSIONS as readonly string[]).includes(key),
  );
  const own = useQuery({
    queryKey: ['hosted-own-backup'],
    queryFn: fetchOwnHostedBackup,
    enabled: !installationKeys && permissions.includes('backup.view'),
    retry: false,
  });
  if (installationKeys || own.isError || !permissions.includes('backup.view')) {
    return <RecoveryPage route={route} permissions={permissions} />;
  }
  return (
    <div className="stack">
      <PageHead title={t('web.hosted_own_backup_title')} />
      <StateSwitch query={own}>
        <Banner tone="info" title={t('web.hosted_own_backup_title')}>
          {t('web.hosted_own_backup_body')}
        </Banner>
        <KV
          items={[
            [
              t('web.hosted_own_backup_last'),
              own.data?.enabled === false
                ? t('web.hosted_own_backup_off')
                : own.data?.lastBackupAt == null
                  ? t('web.hosted_own_backup_none')
                  : formatTimestamp(own.data.lastBackupAt),
            ],
          ]}
        />
      </StateSwitch>
    </div>
  );
}
