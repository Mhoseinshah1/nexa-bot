import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { PanelsPage, PanelDetailPage, NewPanelPage } from '../../apps/web/src/pages/panels';
import { panel, renderPage, stubApi } from './harness';

/**
 * Panels, rendered against the shapes the server actually returns.
 *
 * These go through the real API client, so the fixtures are parsed by the same
 * zod schemas the server validates against. A fixture that drifts from the
 * contract fails here rather than in production.
 */
describe('the panel list', () => {
  const list = (panels: unknown[], nextCursor: string | null = null) => [
    { url: '/panels', body: { panels, nextCursor } },
  ];

  /**
   * Owner revision 19 — no Location column.
   *
   * Asserted over the rendered COLUMN HEADERS rather than by grepping the
   * source, because the way this comes back is somebody adding a column, not
   * somebody editing the string this test would have grepped for.
   */
  it('renders no location column, and no invented telemetry', async () => {
    stubApi(list([panel()]));
    renderPage(<PanelsPage mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');

    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
    // The panel contract has no location, no user count, no load and no sales
    // figure. A column for any of them could only be invented.
    for (const forbidden of ['لوکیشن', 'بار', 'کاربران', 'فروش']) {
      expect(headers.join(' '), forbidden).not.toContain(forbidden);
    }
  });

  it('renders every column from something the server sent', async () => {
    stubApi(list([panel()]));
    renderPage(<PanelsPage mayEdit denied={false} />);

    await screen.findByText('Frankfurt A');
    expect(screen.getByText('Marzban')).toBeInTheDocument();
    expect(screen.getByText('سالم')).toBeInTheDocument();
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });

  it('shows staleness as its own fact rather than folding it into the state', async () => {
    stubApi(list([panel({ health: { ...(panel().health as object), stale: true } })]));
    renderPage(<PanelsPage mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');
    // A stale HEALTHY is not the same claim as a fresh one, and the state must
    // still read HEALTHY rather than being rewritten by the surface.
    expect(screen.getByText('سالم')).toBeInTheDocument();
    expect(screen.getByText('کهنه')).toBeInTheDocument();
  });

  /**
   * Paging is the SERVER's. The page has no sort control and cannot acquire one
   * by accident: it holds a page of rows and an opaque cursor, and knows
   * nothing about the ordering.
   */
  it('pages forward with the cursor the server minted, and never sorts a page', async () => {
    const api = stubApi(list([panel()], 'opaque-cursor-1'));
    renderPage(<PanelsPage mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');

    // No column is a button, so no header can sort.
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header.querySelector('button')).toBeNull();
    }

    const older = screen.getByRole('button', { name: 'قدیمی‌تر' });
    expect(older).not.toBeDisabled();
    older.click();

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('cursor=opaque-cursor-1'))).toBe(true);
    });
  });

  it('offers no next page when the server says there is none', async () => {
    stubApi(list([panel()], null));
    renderPage(<PanelsPage mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');
    expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeDisabled();
  });

  it('shows a permission refusal rather than an empty list', async () => {
    stubApi(list([]));
    renderPage(<PanelsPage mayEdit={false} denied />);
    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
  });

  it('distinguishes an empty fleet from a failed request', async () => {
    stubApi(list([]));
    renderPage(<PanelsPage mayEdit denied={false} />);
    expect(await screen.findByText('هنوز پنلی ثبت نشده است.')).toBeInTheDocument();
  });
});

describe('the panel detail', () => {
  const detail = (overrides: Record<string, unknown> = {}) => [
    { url: '/panels/', body: { panel: panel(overrides) } },
  ];

  /**
   * The credential rule, asserted over the DOM.
   *
   * `panelSummarySchema` carries no credential value, so there is nothing to
   * leak — and that is exactly why the assertion is worth making at this level:
   * it is the surface that would invent a masked stand-in, and `********` in a
   * populated edit field submits `********` back.
   */
  it('never renders a credential value, masked or otherwise', async () => {
    // A Sanaei panel, so all three fields are in the provider's shape and the
    // presence rows are the only thing that can differ between them.
    stubApi(
      detail({
        providerType: 'sanaei',
        providerName: 'Sanaei (3X-UI)',
        credentials: {
          username: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
          password: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
          apiToken: { configured: false, lastReplacedAt: null },
        },
      }),
    );
    const { container } = renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');

    expect(container.textContent ?? '').not.toContain('*****');
    // Presence, and only presence.
    expect(screen.getAllByText('تنظیم شده').length).toBeGreaterThan(0);
    expect(screen.getAllByText('تنظیم نشده').length).toBeGreaterThan(0);
  });

  it('starts every replace field empty, so submitting the form cannot overwrite a credential with a placeholder', async () => {
    stubApi(detail({ providerType: 'sanaei', providerName: 'Sanaei (3X-UI)' }));
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');

    for (const label of ['نام کاربری', 'گذرواژه', 'توکن API']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    }
  });

  /**
   * T12 at the surface — a field the provider's credential shape does not name
   * is not on the page at all.
   *
   * Marzban authenticates with a username and password; it has no API token.
   * The form offered one anyway, and the value was accepted, encrypted and
   * stored — after which every probe went on reporting missing credentials
   * about a secret the operator had just saved. Neither the presence row nor
   * the replace field may exist for a field the shape does not name, and the
   * page says WHY the field an operator may expect is absent rather than
   * leaving a silent gap.
   */
  it('offers no field the provider credential shape does not name', async () => {
    stubApi(detail()); // marzban — USERNAME_PASSWORD
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');

    // The two the shape names are both there, as a presence row and a field.
    for (const label of ['نام کاربری', 'گذرواژه']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    // The one it does not names nothing on the page.
    expect(screen.queryByLabelText('توکن API')).toBeNull();
    expect(screen.queryByText('توکن API')).toBeNull();
    // And the absence is explained rather than silent.
    expect(
      screen.getByText(/تنها فیلدهایی نمایش داده می‌شوند که این نوع پنل می‌پذیرد/),
    ).toBeInTheDocument();
  });

  it('offers all three fields for a provider whose shape accepts either', async () => {
    stubApi(detail({ providerType: 'sanaei', providerName: 'Sanaei (3X-UI)' }));
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');

    for (const label of ['نام کاربری', 'گذرواژه', 'توکن API']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('does not offer the replace form without the rotate permission', async () => {
    stubApi(detail());
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate={false} denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await waitFor(() => {
      expect(screen.queryByText('جایگزینی اعتبارنامه')).toBeNull();
    });
  });

  /**
   * T33 — the ROW the panel actually holds, not a count of the others.
   *
   * "More than ten are planned" stays true if `held.has(row)` is removed or
   * inverted: the one capability this build really implements would then read
   * as planned too, and the count would still be above ten. The maturity of
   * `HEALTH_CHECK` is the whole claim, so it is read off its own row.
   */
  it('says the capability the panel HOLDS is available now', async () => {
    stubApi(detail());
    const { container } = renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'قابلیت‌ها' }).click();
    await screen.findByText('HEALTH_CHECK');

    const rowFor = (capability: string): string => {
      const row = Array.from(container.querySelectorAll('tbody tr')).find(
        (candidate) => (candidate.querySelector('td')?.textContent ?? '').trim() === capability,
      );
      expect(row, `no row for ${capability}`).toBeDefined();
      return (row?.querySelectorAll('td')[1]?.textContent ?? '').trim();
    };

    // The fixture's `capabilities` is exactly ['HEALTH_CHECK'].
    expect(rowFor('HEALTH_CHECK')).toBe('فعال');
  });

  it('says every capability the panel does NOT hold is planned', async () => {
    stubApi(detail());
    const { container } = renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'قابلیت‌ها' }).click();
    await screen.findByText('HEALTH_CHECK');

    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) => {
      const cells = row.querySelectorAll('td');
      return {
        capability: (cells[0]?.textContent ?? '').trim(),
        maturity: (cells[1]?.textContent ?? '').trim(),
      };
    });

    // Every row is one of the two, and the split is exactly the held set.
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      expect(row.maturity, row.capability).toBe(
        row.capability === 'HEALTH_CHECK' ? 'فعال' : 'برنامه‌ریزی‌شده',
      );
    }
    // Both labels really are present, so neither branch is vacuous.
    expect(rows.filter((row) => row.maturity === 'فعال')).toHaveLength(1);
    expect(rows.filter((row) => row.maturity === 'برنامه‌ریزی‌شده').length).toBeGreaterThan(10);
  });

  it('states that health is latest-state-only rather than drawing a trend it does not have', async () => {
    stubApi(detail());
    const { container } = renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'سلامت' }).click();

    expect(await screen.findByText('فقط آخرین وضعیت')).toBeInTheDocument();
    // No chart: the backend stores one row per panel, so a trend line could
    // only be illustrative — which is what the preview's was.
    expect(container.querySelector('svg.chart')).toBeNull();
  });

  /**
   * `testConnection` is guarded by `panels.edit`, so a viewer pressing this
   * button gets a 403 — and the refusal is not free: it writes an
   * `access.permission_denied` operational event and a `DENIED` audit row.
   * The seeded `operator` role holds `panels.view` without `panels.edit`, so
   * this is an ordinary role, not a contrived one.
   */
  it('does not offer a connection test to an actor who may only view', async () => {
    stubApi(detail());
    renderPage(<PanelDetailPage id="p1" mayEdit={false} mayRotate={false} denied={false} />);
    await screen.findByText('Frankfurt A');
    expect(screen.queryByRole('button', { name: 'تست اتصال' })).toBeNull();
  });

  it('does not offer a connection test on an archived panel', async () => {
    stubApi(detail({ status: 'ARCHIVED' }));
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    expect(screen.queryByRole('button', { name: 'تست اتصال' })).toBeNull();
  });

  /**
   * `probed: false` means the stored health came back WITHOUT a new probe.
   * Saying "tested" for that is the legacy "✅ updated" for a write that did
   * nothing — the pattern this codebase exists to end.
   */
  it('says a replayed test was a replay', async () => {
    stubApi([
      { url: '/panels/p1/test', body: { panel: panel(), probed: false } },
      { url: '/panels/', body: { panel: panel() } },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('button', { name: 'تست اتصال' }).click();

    expect(await screen.findByText(/تست تازه‌ای انجام نشد/)).toBeInTheDocument();
  });

  it('says a real probe was a real probe', async () => {
    stubApi([
      { url: '/panels/p1/test', body: { panel: panel(), probed: true } },
      { url: '/panels/', body: { panel: panel() } },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('button', { name: 'تست اتصال' }).click();

    expect(await screen.findByText('تست انجام شد و سلامت به‌روزرسانی شد.')).toBeInTheDocument();
  });

  /**
   * T07 — a destructive control names what it destroys.
   *
   * Three credential rows rendered a presence badge, a timestamp and an
   * identically named "Remove". With a username and an API token both
   * configured, the operator saw two indistinguishable destructive buttons and
   * a screen reader announced each of them as simply "remove". The name is now
   * both visible and part of the accessible name, and this is asserted over
   * the accessible names rather than over the visible text, because the
   * visible text is what was already the same for all three.
   */
  it('names which credential each remove button destroys', async () => {
    stubApi(detail({ providerType: 'sanaei', providerName: 'Sanaei (3X-UI)' }));
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');

    // Only the CONFIGURED credentials offer removal, and the fixture has two.
    const removes = screen.getAllByRole('button', { name: /^حذف — / });
    expect(removes).toHaveLength(2);
    const names = removes.map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['حذف — نام کاربری', 'حذف — گذرواژه']);
    // Distinct, which is the whole finding.
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * T23 — an untouched form submits nothing.
   *
   * `PanelService.update` treats a PRESENT field as an edit, so posting the
   * unchanged name and base URL advanced `updatedAt`, made the panel
   * immediately probe-eligible and wrote a successful audit row for a change
   * nobody made. The service's own empty-edit guard cannot catch it, because
   * the request is not empty.
   */
  it('sends nothing, and says so, when the operator changed nothing', async () => {
    const api = stubApi(detail());
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    expect(await screen.findByText('چیزی تغییر نکرده است.')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('sends only the field the operator actually changed', async () => {
    const api = stubApi([...detail(), { url: '/panels/p1', body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt B' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toBeDefined();
      const body = write?.body as Record<string, unknown>;
      expect(body['name']).toBe('Frankfurt B');
      // The untouched field is ABSENT, not merely equal: presence is what the
      // service reads as an edit.
      expect(Object.keys(body)).not.toContain('baseUrl');
    });
  });

  /**
   * T20 — the lifecycle the status API supports, offered by the surface.
   *
   * The card disappeared entirely for an ARCHIVED panel and offered only
   * ACTIVE<->DISABLED otherwise, so the Web Admin could neither archive a
   * finished panel — the mechanism that releases its name and takes it out of
   * lists and probes — nor restore one archived through another client.
   */
  it('offers archiving on a live panel', async () => {
    const api = stubApi([...detail(), { url: '/panels/p1/status', body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: 'بایگانی' }));
    await waitFor(() => {
      const write = api.calls.find((call) => call.url.includes('/status'));
      expect(write?.body).toMatchObject({ status: 'ARCHIVED' });
    });
  });

  it('offers restoring on an archived panel, and no longer offers archiving', async () => {
    const archived = detail({ status: 'ARCHIVED' });
    const api = stubApi([
      ...archived,
      { url: '/panels/p1/status', body: { panel: panel({ status: 'DISABLED' }) } },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    expect(screen.queryByRole('button', { name: 'بایگانی' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));
    await waitFor(() => {
      const write = api.calls.find((call) => call.url.includes('/status'));
      // DISABLED, not ACTIVE: a restored panel does not silently resume being
      // dialled by the monitor.
      expect(write?.body).toMatchObject({ status: 'DISABLED' });
    });
  });

  it('offers no lifecycle control at all to an actor who may only view', async () => {
    stubApi(detail());
    renderPage(<PanelDetailPage id="p1" mayEdit={false} mayRotate={false} denied={false} />);
    await screen.findByText('Frankfurt A');
    expect(screen.queryByRole('button', { name: 'بایگانی' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'بازگردانی از بایگانی' })).toBeNull();
  });
});

describe('the new-panel form', () => {
  const providersRoute = (body: unknown, status?: number) => ({
    url: '/providers',
    body,
    ...(status === undefined ? {} : { status }),
  });

  const CATALOGUE = {
    providers: [
      {
        key: 'marzban',
        canonicalName: 'Marzban',
        credentialShape: 'USERNAME_PASSWORD',
        capabilities: ['HEALTH_CHECK'],
        requiredActivationFields: [],
      },
      {
        key: 'sanaei',
        canonicalName: 'Sanaei (3X-UI)',
        credentialShape: 'TOKEN_OR_USERNAME_PASSWORD',
        capabilities: ['HEALTH_CHECK'],
        requiredActivationFields: ['subscriptionDomain'],
      },
    ],
  };

  /**
   * T13 — an outage is not an empty catalogue.
   *
   * Reading `providers.data` directly rendered a complete, enabled form with an
   * empty picker when `/providers` failed. Submitting it returned silently,
   * because `providerType` was still '', so a 503 looked exactly like an
   * installation with no supported providers and offered no retry.
   */
  it('reports a provider-catalogue failure instead of an empty picker', async () => {
    stubApi([
      providersRoute(
        {
          error: {
            kind: 'unavailable',
            code: 'test.down',
            message: 'no',
            correlationId: 'test',
          },
        },
        503,
      ),
    ]);
    renderPage(<NewPanelPage denied={false} />);

    // A retry, which the silent form never offered.
    expect(await screen.findByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    // And no form that cannot work.
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });

  it('distinguishes an empty catalogue from a failed one', async () => {
    stubApi([providersRoute({ providers: [] })]);
    renderPage(<NewPanelPage denied={false} />);
    expect(await screen.findByText('هیچ ارائه‌دهنده‌ای در دسترس نیست.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });

  /**
   * T12 on the create side. The server refuses a credential outside the
   * provider's shape, so offering the field can only produce a 400 after the
   * operator has typed a secret into it.
   */
  it('offers only the credential fields the chosen provider accepts', async () => {
    stubApi([providersRoute(CATALOGUE)]);
    renderPage(<NewPanelPage denied={false} />);
    await screen.findByLabelText('ارائه‌دهنده');

    // Nothing is known before a provider is chosen, so nothing is offered.
    expect(screen.queryByLabelText('نام کاربری')).toBeNull();
    expect(screen.queryByLabelText('توکن API')).toBeNull();

    fireEvent.change(screen.getByLabelText('ارائه‌دهنده'), { target: { value: 'marzban' } });
    expect(screen.getByLabelText('نام کاربری')).toBeInTheDocument();
    expect(screen.getByLabelText('گذرواژه')).toBeInTheDocument();
    expect(screen.queryByLabelText('توکن API')).toBeNull();

    fireEvent.change(screen.getByLabelText('ارائه‌دهنده'), { target: { value: 'sanaei' } });
    expect(screen.getByLabelText('توکن API')).toBeInTheDocument();
  });

  it('never sends a credential the chosen provider cannot use', async () => {
    const api = stubApi([providersRoute(CATALOGUE), { url: '/panels', body: { panel: panel() } }]);
    renderPage(<NewPanelPage denied={false} />);
    await screen.findByLabelText('ارائه‌دهنده');

    // Choose the provider that HAS a token field, fill it, then switch away.
    fireEvent.change(screen.getByLabelText('ارائه‌دهنده'), { target: { value: 'sanaei' } });
    fireEvent.change(screen.getByLabelText('توکن API'), { target: { value: 'a-real-token' } });
    fireEvent.change(screen.getByLabelText('ارائه‌دهنده'), { target: { value: 'marzban' } });

    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt C' } });
    fireEvent.change(screen.getByLabelText('نشانی پایه'), {
      target: { value: 'https://panel.example/api' },
    });
    fireEvent.change(screen.getByLabelText('نام کاربری'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toBeDefined();
      const body = write?.body as { credentials?: Record<string, unknown> };
      expect(body.credentials?.['username']).toBe('admin');
      // The token typed under the other provider is left behind entirely: the
      // secret never reaches the wire to be refused.
      expect(Object.keys(body.credentials ?? {})).not.toContain('apiToken');
    });
  });
});
