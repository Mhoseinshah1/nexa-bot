import {
  formatPersianInteger,
  opsLogTypeEnabled,
  type SettingKey,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';

/** What the backup pipeline knows about the archive it is about to deliver. */
export interface BackupCaptionFacts {
  readonly at: Date;
  readonly fileName: string;
  readonly archiveBytes: number;
  readonly checksum: string;
}

export interface BackupCaptionDeps {
  /** The installation's tenant, or null while there is none (nothing to read a template from). */
  readonly scope: () => TenantContext | null;
  readonly settings: { valueOf<T>(scope: TenantContext, key: SettingKey): Promise<T> };
  readonly schedule: () => Promise<{ readonly enabled: boolean; readonly intervalMs: number }>;
  readonly render: (scope: TenantContext, key: TemplateKey, values: TemplateValues) => Promise<string>;
}

/**
 * The backup file's caption (Round 4 PR-D, L31): short, Persian, from the operator's own
 * template `ops.log.backup_caption`, with the time of the next automatic backup when one is
 * scheduled.
 *
 * Returns null — and the technical caption stands — when there is no tenant or when the
 * type's switch is off. The switch governs the CAPTION only: the archive is the disaster-
 * recovery pipeline's delivery and a log switch must never skip it. The caption claims
 * «رمزگذاری و بازیابی آزمایشی موفق», which is true because the pipeline reaches DELIVER only
 * from a VERIFY_RESTORE that passed (ADR-0025).
 */
export function backupCaptionRenderer(
  deps: BackupCaptionDeps,
): (facts: BackupCaptionFacts) => Promise<string | null> {
  return async (facts) => {
    const scope = deps.scope();
    if (scope === null) return null;
    const off = await deps.settings.valueOf<readonly string[]>(
      scope,
      'ops.log.disabled_types' as SettingKey,
    );
    if (!opsLogTypeEnabled(off, 'BACKUP_FILE')) return null;
    const schedule = await deps.schedule();
    const next = schedule.enabled ? new Date(facts.at.getTime() + schedule.intervalMs) : null;
    const mebibytes = Math.max(1, Math.round(facts.archiveBytes / (1024 * 1024)));
    return deps.render(scope, 'ops.log.backup_caption' as TemplateKey, {
      at: facts.at,
      fileName: facts.fileName,
      size: `${formatPersianInteger(mebibytes)} مگ`,
      checksum: facts.checksum.slice(0, 16),
      ...(next === null ? {} : { nextAt: next }),
    });
  };
}
