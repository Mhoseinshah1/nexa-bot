import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { featureFlagSchema, notificationSchema, templateViewSchema } from '@nexa/contracts';
import { FeaturesPage } from '../../apps/web/src/pages/features';
import { ContentPage } from '../../apps/web/src/pages/content';
import { NotificationsPage } from '../../apps/web/src/pages/alerts';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

const NO_PERMISSION = t('web.no_permission');

/**
 * The four control-plane routes the coverage ledger claimed were covered.
 *
 * They were not. The ledger cited "existing control-plane suites" for
 * `/features`, `/content` and `/notifications` — those are API-level
 * integration tests, and no case in `tests/web/` rendered any of these three
 * components at all. That is precisely the gap this suite's own rationale
 * names: the risk it exists to cover is production WIRING, and an API test
 * cannot see a page that never calls the endpoint, reads the wrong field, or
 * throws on a shape the schema permits.
 *
 * Every fixture below is PARSED by the frozen schema first, so a contract
 * change fails here rather than rendering something the server would never
 * send.
 */
const flag = (over: Record<string, unknown> = {}) =>
  featureFlagSchema.parse({
    key: 'ops_notifications',
    description: 'Project operational events to the operations destination.',
    enabled: true,
    source: 'TENANT',
    blastRadius: 'LOCAL',
    version: 2,
    reason: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedByAdminId: 'a1',
    configuration: [],
    ...over,
  });

const template = (over: Record<string, unknown> = {}) =>
  templateViewSchema.parse({
    key: 'event.panel.unreachable',
    locale: 'fa',
    description: 'Sent when a panel stops answering.',
    format: 'PLAIN_TEXT',
    maxLength: 4096,
    body: 'پنل {panel_name} در دسترس نیست.',
    defaultBody: 'پنل {panel_name} در دسترس نیست.',
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: [
      {
        token: 'panel_name',
        type: 'STRING',
        description: 'The panel that stopped answering.',
        required: true,
        repeatable: false,
      },
    ],
    ...over,
  });

const notification = (over: Record<string, unknown> = {}) =>
  notificationSchema.parse({
    id: 'n1',
    kind: 'OPERATIONAL_EVENT',
    status: 'SENT',
    templateKey: 'event.panel.unreachable',
    attemptCount: 1,
    maxAttempts: 5,
    createdAt: '2026-09-06T08:00:00.000Z',
    lastAttemptAt: '2026-09-06T08:00:01.000Z',
    completedAt: '2026-09-06T08:00:01.000Z',
    correlationId: 'c1',
    ...over,
  });

describe('the feature flags page', () => {
  it('renders a flag and the settings it governs', async () => {
    stubApi([{ url: '/features', body: { flags: [flag()] } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);

    expect(await screen.findByText('ops_notifications')).toBeInTheDocument();
  });

  /**
   * A flag is a BOOLEAN and its parameters are settings — the Phase 2 rule
   * that neither registry may grow a field belonging to the other. The only
   * action a flag row offers is enable/disable; a value input beside it would
   * be the first step back.
   */
  it('offers only enable and disable, never a value to type', async () => {
    stubApi([{ url: '/features', body: { flags: [flag({ enabled: true })] } }]);
    const { container } = renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByText('ops_notifications');

    expect(screen.getByRole('button', { name: t('web.disable') })).toBeEnabled();
    // No free-text or numeric entry anywhere on the flag itself.
    expect(container.querySelectorAll('input[type="text"], input[type="number"]')).toHaveLength(0);
  });

  it('draws no toggle at all for an actor who may only view', async () => {
    stubApi([{ url: '/features', body: { flags: [flag({ enabled: true })] } }]);
    renderPage(<FeaturesPage mayEdit={false} denied={false} />);
    await screen.findByText('ops_notifications');

    // Absent, not disabled. The earlier version of this case looped over
    // elements that do not exist without `mayEdit`, so it passed vacuously
    // and would have passed just as happily with the control drawn.
    expect(screen.queryByRole('button', { name: t('web.disable') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.enable') })).toBeNull();
  });
});

describe('the content page', () => {
  /**
   * A template body is stored RAW and rendered nowhere near where it is
   * edited. The editor must therefore show the placeholder token itself, not
   * a substituted value — the legacy defect that baked an admin's own name
   * into `{first_name}` for thirteen thousand customers.
   */
  it('shows the raw body with its placeholder token intact', async () => {
    stubApi([{ url: '/templates', body: { templates: [template()] } }]);
    renderPage(<ContentPage mayEdit denied={false} />);

    expect((await screen.findAllByText('event.panel.unreachable')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\{panel_name\}/).length).toBeGreaterThan(0);
  });

  it('reports a permission refusal rather than an empty catalogue', async () => {
    stubApi([]);
    renderPage(<ContentPage mayEdit={false} denied />);
    expect(await screen.findByText(NO_PERMISSION)).toBeInTheDocument();
  });
});

describe('the notifications page', () => {
  it('renders an intent and its delivery state', async () => {
    stubApi([{ url: '/notifications', body: { notifications: [notification()] } }]);
    renderPage(<NotificationsPage mayTest denied={false} />);

    expect(await screen.findByText('event.panel.unreachable')).toBeInTheDocument();
  });

  /**
   * `attempts_exhausted` is a state a person has to notice. A failed intent
   * that renders identically to a sent one is the legacy "✅ updated" for a
   * write that did nothing.
   */
  it('distinguishes an abandoned intent from a delivered one', async () => {
    stubApi([
      {
        url: '/notifications',
        body: {
          notifications: [
            notification(),
            notification({
              id: 'n2',
              status: 'FAILED',
              attemptCount: 5,
              completedAt: null,
              templateKey: 'event.monitor.capacity',
            }),
          ],
        },
      },
    ]);
    const { container } = renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('event.monitor.capacity');

    // Two rows, and they do not read the same.
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).not.toBe(rows[1]?.textContent);
  });

  it('offers no test send to an actor without settings.edit', async () => {
    stubApi([{ url: '/notifications', body: { notifications: [] } }]);
    const { container } = renderPage(<NotificationsPage mayTest={false} denied={false} />);
    await screen.findAllByText('اعلان‌ها');

    expect(screen.queryByRole('button', { name: /آزمایشی/ })).toBeNull();
    expect(container.textContent).toBeTruthy();
  });
});
