import { describe, expect, it } from 'vitest';
import { templateDefinition, type TemplateKey } from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import { backupCaptionRenderer } from '../../apps/api/src/modules/commerce/ops-log/application/backup-caption';

/**
 * L31 — the backup file's caption: short, Persian, from the operator's template; and a log
 * switch that never costs a backup its delivery.
 *
 * MUTATION: ignoring the type's switch -> the "switched off" test; sizing in bytes instead of
 * mebibytes -> the size line; counting the next backup from the completion time instead of
 * the run's start (the scheduler's `lastSucceededAt + interval`) -> the next-backup line.
 */

const AT = new Date('2026-10-12T00:30:00Z'); // 04:00 Tehran: the run COMPLETED then
const STARTED = new Date('2026-10-12T00:20:00Z'); // 03:50 Tehran: the run began then
const facts = {
  at: AT,
  startedAt: STARTED,
  fileName: 'nexa-backup-test.nxb',
  archiveBytes: 44 * 1024 * 1024 + 300_000,
  checksum: 'a'.repeat(64),
};

function renderer(options: { off?: string[]; scheduled?: boolean }) {
  return backupCaptionRenderer({
    scope: () => ({
      tenantId: '01900000-0000-7000-8000-000000000001' as never,
      botInstanceId: null,
    }),
    settings: { valueOf: async () => (options.off ?? []) as never },
    schedule: async () => ({ enabled: options.scheduled ?? true, intervalMs: 2 * 3_600_000 }),
    render: async (_scope, key, values) =>
      renderTemplateBody(
        templateDefinition(key as TemplateKey),
        CATALOGUE_FA[key as TemplateKey],
        values,
        'fa',
        DEFAULT_TEMPLATE_PRESENTATION,
      ),
  });
}

describe('L31 — the backup caption', () => {
  it('is short and Persian: the time, the file and its size in Persian digits, the verification, the next backup', async () => {
    const text = (await renderer({})(facts))!;
    expect(text.split('\n').length).toBeLessThanOrEqual(6);
    expect(text).toContain('💾 بکاپ — ۱۴۰۵/۰۷/۲۰ ۰۴:۰۰');
    expect(text).toContain('nexa-backup-test.nxb · ۴۴ مگ');
    expect(text).toContain('✅ رمزگذاری و بازیابی آزمایشی موفق');
    // The scheduler's own rule: the run's START plus the interval (03:50 + 2h), not 04:00 + 2h.
    expect(text).toContain('🕒 بکاپ بعدی: ۱۴۰۵/۰۷/۲۰ ۰۵:۵۰');
    expect(text).not.toMatch(/NaN|undefined|\{[a-zA-Z]+\}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it('leaves the next-backup line out when no schedule is on, rather than invent a time', async () => {
    const text = (await renderer({ scheduled: false })(facts))!;
    expect(text).not.toContain('بکاپ بعدی');
  });

  it('switched off, answers null so the technical caption stands and the archive is still delivered', async () => {
    expect(await renderer({ off: ['BACKUP_FILE'] })(facts)).toBeNull();
    expect(await renderer({ off: ['USER_NEW'] })(facts)).not.toBeNull();
  });

  it('has no tenant to read a template from: null, never a throw', async () => {
    const none = backupCaptionRenderer({
      scope: () => null,
      settings: { valueOf: async () => [] as never },
      schedule: async () => ({ enabled: false, intervalMs: 0 }),
      render: async () => 'x',
    });
    expect(await none(facts)).toBeNull();
  });
});
