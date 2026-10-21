import { describe, expect, it } from 'vitest';
import { BACKUP_STAGES } from '@nexa/contracts';
import { BACKUP_PHASE_LABELS, phaseRows } from '../../apps/web/src/backup-phases';
import { hasErrorText } from '../../apps/web/src/error-text';
import { t } from '../../apps/web/src/i18n/web.fa';

describe('the backup phase durations view', () => {
  it('lists the recorded stages in pipeline order and omits the ones never reached', () => {
    const rows = phaseRows({ phaseDurationsMs: { ENCRYPT: 9, DUMP: 4 } });
    expect(rows.map((row) => [row.stage, row.ms])).toEqual([
      ['DUMP', 4],
      ['ENCRYPT', 9],
    ]);
  });

  it('is empty for a run from before durations were recorded', () => {
    expect(phaseRows({ phaseDurationsMs: null })).toEqual([]);
  });

  it('keeps a recorded zero, which is a stage that ran, not one that did not', () => {
    expect(phaseRows({ phaseDurationsMs: { CHECKSUM: 0 } }).map((row) => row.ms)).toEqual([0]);
  });

  it('names every stage in Persian', () => {
    for (const stage of BACKUP_STAGES) expect(t(BACKUP_PHASE_LABELS[stage])).not.toBe('');
  });

  it('has the Persian reasons for both memory failures', () => {
    expect(hasErrorText('backup.tool_oom_killed')).toBe(true);
    expect(hasErrorText('backup.memory_insufficient')).toBe(true);
    expect(t('web.err_backup_tool_oom_killed')).toBe('حافظهٔ سرور کافی نبود.');
  });
});
