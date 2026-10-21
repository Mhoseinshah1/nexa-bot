import { describe, expect, it } from 'vitest';
import {
  OPERATION_TYPES,
  templateDefinition,
  type RecordedOperationalEvent,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import {
  CATALOGUE_FA,
  DEFAULT_TEMPLATE_PRESENTATION,
  operationalEventLabelFa,
  renderTemplateBody,
} from '@nexa/i18n';
import { OperationalEventPresenter } from '../../apps/api/src/modules/commerce/ops-log/application/event-presenter';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import type { OpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/application/ports';

/**
 * R5A-2 item 6 — `provisioning.stalled` for an operation that is not a paid PROVISION must not
 * say «ساخت سرویس متوقف مانده است». MUTATION: dropping the presenter branch (or its
 * `PROVISION` exclusion) fails the first (or second) test; dropping a word-table entry fails
 * the exhaustiveness test. The CODE is unchanged: the same event, a different rendered title.
 */
const tenant = {
  tenantId: '01900000-0000-7000-8000-000000000001' as never,
  botInstanceId: null,
} as TenantContext;
const presenter = new OperationalEventPresenter({
  // R5C-2 C1: a service that cannot be read keeps the generic layout this file pins.
  facts: { service: async () => null } as unknown as OpsLogFacts,
  words: i18nOpsLogWords,
});
const recorded: RecordedOperationalEvent = {
  id: 'ev-1',
  code: 'provisioning.stalled',
  severity: 'ERROR',
  message: 'x',
  occurrenceCount: 1,
  firstSeenAt: new Date('2026-10-20T08:00:00Z'),
  lastSeenAt: new Date('2026-10-20T08:00:00Z'),
  isNew: true,
  reopened: false,
};
const event = (operationType?: string) => ({
  code: 'provisioning.stalled',
  severity: 'ERROR' as const,
  message: 'x',
  context: { serviceId: 's', panelId: 'p', reason: 'ATTEMPTS_SPENT', operationType },
});
const render = (templateKey: string, values: unknown) =>
  renderTemplateBody(
    templateDefinition(templateKey as TemplateKey),
    CATALOGUE_FA[templateKey as TemplateKey],
    values as never,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );

describe('provisioning.stalled names the real operation', () => {
  it('a SYNC_USAGE stall reads as a usage read that failed, not a service build', async () => {
    const presented = await presenter.present(tenant, event('SYNC_USAGE'), recorded, {});
    expect(presented).not.toBeNull();
    const text = render(presented!.templateKey, presented!.values);
    expect(text).toContain('خواندن مصرف سرویس ناموفق ماند');
    expect(text).not.toContain('ساخت سرویس');
    expect(presented!.values['code']).toBe('provisioning.stalled');
  });

  it('a PROVISION stall (or one with no operation type) keeps the old title', async () => {
    expect(await presenter.present(tenant, event('PROVISION'), recorded, {})).toBeNull();
    expect(await presenter.present(tenant, event(undefined), recorded, {})).toBeNull();
    expect(presenter.title('provisioning.stalled')).toBe('ساخت سرویس متوقف مانده است');
    expect(operationalEventLabelFa('provisioning.stalled')).toBe('ساخت سرویس متوقف مانده است');
  });

  it('every non-PROVISION operation type has its own words', () => {
    for (const type of OPERATION_TYPES) {
      if (type === 'PROVISION') continue;
      const title = i18nOpsLogWords.stalledOperationTitle(type);
      expect(title, type).not.toBeNull();
      expect(title).not.toContain('ساخت سرویس');
    }
    expect(i18nOpsLogWords.stalledOperationTitle('NOT_A_TYPE')).toBeNull();
  });
});
