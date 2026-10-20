import { describe, expect, it } from 'vitest';
import {
  OPS_LOG_TYPES,
  opsLogTopicForCode,
  templateDefinition,
  type RecordedOperationalEvent,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import { OPERATIONAL_EVENT_LABELS_FA } from '@nexa/i18n';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import { OperationalEventPresenter } from '../../apps/api/src/modules/commerce/ops-log/application/event-presenter';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import type { OpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/application/ports';

/**
 * L25 — a panel going down and coming back, and the generic operational events in Persian.
 * MUTATION: rendering the title from the English code instead of the map -> the generic test.
 */

const tenant = {
  tenantId: '01900000-0000-7000-8000-000000000001' as never,
  botInstanceId: null,
} as TenantContext;
const FIRST = new Date('2026-10-12T08:00:00Z');
const LAST = new Date('2026-10-12T08:42:00Z');

const facts = {
  panelName: async (_s: unknown, id: string) => (id === 'pan-1' ? 'پنل آزمایشی' : null),
  conditionClosedBy: async () => FIRST,
  customer: async () => null,
  order: async () => null,
} as unknown as OpsLogFacts;
const presenter = new OperationalEventPresenter({ facts, words: i18nOpsLogWords });

const recorded = (code: string): RecordedOperationalEvent => ({
  id: 'ev-1',
  code,
  severity: 'ERROR',
  message: 'x',
  occurrenceCount: 1,
  firstSeenAt: FIRST,
  lastSeenAt: LAST,
  isNew: true,
  reopened: false,
});

const render = (templateKey: string, values: unknown) =>
  renderTemplateBody(
    templateDefinition(templateKey as TemplateKey),
    CATALOGUE_FA[templateKey as TemplateKey],
    values as never,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );

describe('L25 — panel down and up', () => {
  it('a panel out of reach is a Persian message with the cause, one technical code, the sales note and a panel button', async () => {
    const presented = await presenter.present(
      tenant,
      {
        code: 'panel.health.tls_failed',
        severity: 'ERROR',
        message: 'x',
        context: { panelId: 'pan-1' },
      },
      recorded('panel.health.tls_failed'),
      {} as never,
    );
    expect(presented).not.toBeNull();
    expect(presented!.logType).toBe('PANEL_STATE');
    expect(presented!.buttons).toEqual([{ kind: 'PANEL', ref: 'pan-1' }]);
    const text = render(presented!.templateKey, presented!.values);
    expect(text).toContain('پنل «پنل آزمایشی» از دسترس خارج شد');
    expect(text).toContain('🔧 کد: TLS_FAILED');
    expect(text).not.toMatch(/panel\.health|NaN|undefined/);
    expect(opsLogTopicForCode('panel.health.tls_failed')).toBe(OPS_LOG_TYPES.PANEL_STATE.topic);
  });

  it('the recovery says how long the panel was down, from when the condition opened', async () => {
    const presented = await presenter.present(
      tenant,
      {
        code: 'panel.health.recovered',
        severity: 'INFO',
        message: 'x',
        dedupeKey: 'panel.health.recovered:pan-1',
      },
      recorded('panel.health.recovered'),
      {} as never,
    );
    const text = render(presented!.templateKey, presented!.values);
    expect(text).toContain('پنل «پنل آزمایشی» برگشت');
    expect(text).toContain('مدت قطعی: ۴۲ دقیقه');
  });

  it('a recovery that closed nothing (a panel never down) announces nothing, and a panel it cannot name falls to the generic layout', async () => {
    const none = new OperationalEventPresenter({
      facts: { ...facts, conditionClosedBy: async () => null } as unknown as OpsLogFacts,
      words: i18nOpsLogWords,
    });
    expect(
      await none.present(
        tenant,
        {
          code: 'panel.health.recovered',
          severity: 'INFO',
          message: 'x',
          dedupeKey: 'panel.health.recovered:pan-1',
        },
        recorded('panel.health.recovered'),
        {} as never,
      ),
    ).toBeNull();
    expect(
      await presenter.present(
        tenant,
        {
          code: 'panel.health.unreachable',
          severity: 'ERROR',
          message: 'x',
          context: { panelId: 'pan-gone' },
        },
        recorded('panel.health.unreachable'),
        {} as never,
      ),
    ).toBeNull();
  });
});

describe('the generic operational event, in Persian from its code', () => {
  it('titles every mapped code from the shared label map and keeps the English only in the one technical line', () => {
    const entries = Object.entries(OPERATIONAL_EVENT_LABELS_FA);
    expect(entries.length).toBeGreaterThan(20);
    for (const [code, label] of entries.slice(0, 40)) {
      expect(presenter.title(code), code).toBe(i18nOpsLogWords.eventTitle(code));
      expect(presenter.title(code), code).not.toBe(code);
      expect(String(label), code).toMatch(/[؀-ۿ]/u);
      expect(String(label), code).not.toMatch(/میرزا|mirza/iu);
    }
  });

  it('a code with no label falls back to a Persian word, never the raw code as a title', () => {
    expect(presenter.title('some.unknown.code')).toBe(
      i18nOpsLogWords.eventTitle('some.unknown.code'),
    );
    expect(presenter.title('some.unknown.code')).toMatch(/[؀-ۿ]/u);
  });
});
