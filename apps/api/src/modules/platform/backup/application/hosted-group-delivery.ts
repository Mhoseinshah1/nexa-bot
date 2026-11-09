import {
  BACKUP_TELEGRAM_DOCUMENT_MAX_BYTES,
  formatPersianInteger,
  opsLogTypeEnabled,
  type BackupDeliveryState,
  type Clock,
  type SettingKey,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import type { BackupDeliveryChannel } from './ports.js';
import type { OpsGroupBackupTopic } from './routed-backup-delivery.js';
import type { HostedArchiveDelivery } from './tenant-archive.service.js';

export interface HostedGroupDeliveryDeps {
  /** The operations group's backups topic, asked in the HOSTED tenant's own scope. */
  readonly opsGroup: Pick<OpsGroupBackupTopic, 'route' | 'delivered'>;
  readonly channelFor: (target: {
    readonly token: string;
    readonly chatId: string;
    readonly threadId: number;
  }) => Pick<BackupDeliveryChannel, 'sendDocument'>;
  readonly settings: { valueOf<T>(scope: TenantContext, key: SettingKey): Promise<T> };
  readonly render: (
    scope: TenantContext,
    key: TemplateKey,
    values: TemplateValues,
  ) => Promise<string>;
  readonly clock: Clock;
}

/**
 * Phase 6B PR-2 (ADR-0039 § 7): a verified hosted archive, to the hosted bot's OWN operations
 * group, if that bot connected one — its «💾 بکاپ‌ها» topic, posted by its own bot, captioned
 * from its own template `ops.log.hosted_backup_caption`.
 *
 * Every lookup is made in the HOSTED tenant's scope, so the only group it can find is the
 * hosted bot's: there is no installation scope here to fall back to, and no
 * `BACKUP_TELEGRAM_*` fallback chat (that one is the owner's). With no group, a group that
 * cannot take it, a caption switched off, or a file above Telegram's bot ceiling, the archive
 * stays on the server and the answer says so. The hosted operators get the file, never the
 * password.
 */
export class HostedGroupArchiveDelivery implements HostedArchiveDelivery {
  constructor(private readonly deps: HostedGroupDeliveryDeps) {}

  async deliver(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly archivePath: string;
    readonly archiveBytes: number;
    readonly checksum: string;
    readonly at: Date;
  }): Promise<{
    readonly state: BackupDeliveryState;
    readonly detail: string | null;
    readonly attemptedAt: Date | null;
  }> {
    const scope = { tenantId: input.tenantId, botInstanceId: null } as TenantContext;
    const kept = (detail: string) => ({
      state: 'NOT_ATTEMPTED' as const,
      detail,
      attemptedAt: null,
    });
    if (input.archiveBytes > BACKUP_TELEGRAM_DOCUMENT_MAX_BYTES) {
      return kept('Kept on this server: larger than Telegram accepts from a bot.');
    }
    const off = await this.deps.settings.valueOf<readonly string[]>(
      scope,
      'ops.log.disabled_types' as SettingKey,
    );
    if (!opsLogTypeEnabled(off, 'BACKUP_FILE')) {
      return kept('Kept on this server: the hosted bot turned its backup file log off.');
    }
    const route = await this.deps.opsGroup.route(scope, null);
    if (route.kind === 'NOT_CONNECTED') {
      return kept('Kept on this server: the hosted bot has no operations group.');
    }
    if (route.kind === 'UNAVAILABLE') {
      return kept(
        `Kept on this server: the hosted bot's group is unavailable (${route.errorCode}).`,
      );
    }
    const mebibytes = Math.max(1, Math.round(input.archiveBytes / (1024 * 1024)));
    const fileName = `nexa-hosted-${input.runId}.7z`;
    const caption = await this.deps.render(scope, 'ops.log.hosted_backup_caption' as TemplateKey, {
      at: input.at,
      fileName,
      size: `${formatPersianInteger(mebibytes)} مگ`,
      checksum: input.checksum.slice(0, 16),
    });
    const attemptedAt = this.deps.clock.now();
    const attempt = await this.deps
      .channelFor({ token: route.token, chatId: route.chatId, threadId: route.threadId })
      .sendDocument({ archivePath: input.archivePath, filename: fileName, caption });
    if (attempt.state === 'SUCCEEDED') {
      await this.deps.opsGroup.delivered(scope, route.chatId, attemptedAt).catch(() => undefined);
    }
    return { state: attempt.state, detail: attempt.detail ?? null, attemptedAt };
  }
}
