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

  /**
   * Why the credentials form's `accepts` guard on submit is DEFENCE, not a
   * load-bearing rule — recorded because a review raised the opposite.
   *
   * The concern was real in shape: `PanelDetailPage` is not keyed by panel id,
   * so navigating between two detail routes reuses the component, and a token
   * typed against a Sanaei panel could in principle be submitted to a Marzban
   * one whose field is hidden. The guard was added to `CredentialsTab.onSubmit`
   * to match the create form.
   *
   * It is not reachable through this shell, and this test is what establishes
   * that rather than a claim: changing the id changes the query key, the panel
   * query goes pending, `StateSwitch` renders a skeleton, and the whole tab
   * subtree — with its draft state — unmounts. It remounts empty against the
   * new panel.
   *
   * So the guard cannot be falsified by a test, and no test pretending to
   * falsify it is committed. What IS pinned is the fact the guard depends on:
   * if a future change keeps previous data across the id (React Query's
   * `placeholderData`, say) or drops the loading branch, this test fails and
   * the guard stops being redundant.
   */
  it('unmounts the credentials draft when the panel changes, so no value can cross', async () => {
    stubApi([
      {
        url: '/panels/p1',
        body: { panel: panel({ providerType: 'sanaei', providerName: 'Sanaei (3X-UI)' }) },
      },
      { url: '/panels/p2', body: { panel: panel({ name: 'Frankfurt B' }) } },
    ]);
    const { rerender } = renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');
    fireEvent.change(screen.getByLabelText('توکن API'), { target: { value: 'a-real-token' } });

    rerender(<PanelDetailPage id="p2" mayEdit mayRotate denied={false} />);

    // The loading state replaces the whole subtree: the tab is gone, so the
    // draft it held is gone with it.
    expect(document.querySelectorAll('.skel').length).toBeGreaterThan(0);
    expect(screen.queryByText('جایگزینی اعتبارنامه')).toBeNull();

    // And when it comes back for the new panel it is a fresh mount, with the
    // overview tab selected and nothing carried over.
    await screen.findByText('Frankfurt B');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');
    expect((screen.getByLabelText('نام کاربری') as HTMLInputElement).value).toBe('');
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
   * The edit is compared against the DRAFT BASIS, not the latest query result.
   *
   * `name` is initialised once and the `panel` prop refetches — same query key,
   * so no unmount and no skeleton, the new row simply arrives underneath the
   * open form. Comparing against the live prop turned another administrator's
   * rename into a change THIS operator appears to have made: editing only the
   * base URL sent the stale name too and silently reverted them, and
   * `POST /panels/:id` carries no expected version for the server to refuse it
   * with.
   *
   * A regression the changed-fields-only fix introduced. Before it the form
   * always sent both fields, which reverted them just as surely but did not
   * claim in a comment to send only what changed.
   *
   * Driven through the real refetch: a status change invalidates the panel
   * query, which is exactly how the row arrives while the form is open.
   */
  it('does not revert a concurrent rename when only the other field was edited', async () => {
    // The route parameter IS the panel id in production — `/panels/:id` is the
    // only route that reaches this page, and every link is built from
    // `panel.id`. Using it here rather than a stand-in is what makes the
    // refetch below behave as it does in the browser.
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    // The WRITE routes are keyed by the panel's own id, which is what the API
    // client puts in the path — not the route parameter this page was given.
    const api = stubApi([route, { url: `/panels/${id}/status`, body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // The operator edits the base URL and leaves the name alone.
    fireEvent.change(screen.getByLabelText('نشانی پایه'), {
      target: { value: 'https://panel.example/v2' },
    });

    // Meanwhile somebody else renames the panel...
    route.body = { panel: panel({ name: 'Renamed by somebody else' }) };
    // ...and a status change refetches the row into this open form.
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));
    // The page says the row changed underneath, rather than resolving it
    // silently — nothing on the server can arbitrate, so the operator must.
    expect(await screen.findByText(/جای دیگری تغییر کرده/)).toBeInTheDocument();
    // The form still holds what the operator typed, not the refetched name.
    expect((screen.getByLabelText('نام') as HTMLInputElement).value).toBe('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => {
      const write = api.calls.find(
        (call) => call.method === 'POST' && call.url.endsWith(`/panels/${id}`),
      );
      expect(write?.body).toBeDefined();
      const body = write?.body as Record<string, unknown>;
      expect(body['baseUrl']).toBe('https://panel.example/v2');
      // The name the operator never touched is ABSENT — not resent as the
      // stale value, which is what would overwrite the other administrator.
      expect(Object.keys(body)).not.toContain('name');
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

  /**
   * An ARCHIVED panel refuses every write, so it must offer none.
   *
   * `PanelService.update` and `setCredentials` both answer 412 `panel.archived`.
   * The lifecycle card was gated correctly and the two forms above it were not
   * — and archiving is now one press away on that card, which re-renders this
   * same page as ARCHIVED and leaves the operator looking at an enabled Save.
   * Restore first; that is what the card is for.
   *
   * The FIELDS are asserted, not only the button. Removing Save while leaving
   * the two inputs enabled is a form an operator can type a new name into and
   * never submit — the same untrue screen in a quieter form, and it is what
   * the first version of this fix actually shipped.
   */
  it('offers no save on an archived panel, because the server refuses one', async () => {
    stubApi(detail({ status: 'ARCHIVED' }));
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
    expect(screen.getByLabelText('نام')).toBeDisabled();
    expect(screen.getByLabelText('نشانی پایه')).toBeDisabled();
    // The restore control is still there — the way out is not hidden too.
    expect(screen.getByRole('button', { name: 'بازگردانی از بایگانی' })).toBeInTheDocument();
  });

  /**
   * The other side of the same rule: a LIVE panel must still be editable.
   *
   * Widening the gate from `mayEdit` to `mayEdit && not archived` is one
   * character away from disabling the form for everybody, and the assertion
   * above passes just as happily in that case.
   */
  it('leaves the identity fields editable on a live panel', async () => {
    stubApi(detail());
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    expect(screen.getByLabelText('نام')).toBeEnabled();
    expect(screen.getByLabelText('نشانی پایه')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'ذخیره' })).toBeInTheDocument();
  });

  /**
   * A stored credential the provider cannot use stays visible, and removable.
   *
   * A panel created before the shape rule was enforced can hold an API token on
   * a Marzban panel, whose shape is USERNAME_PASSWORD. Gating the whole
   * presence row on the shape made that secret undiscoverable and unremovable
   * through the Web Admin while the response still reported it, and
   * `setCredentials` still accepts `null` to clear it. A stored secret nobody
   * can see is a stored secret nobody will remove — which is worse than the
   * field the gate was hiding.
   *
   * So the rule is two rules: `shows` covers the presence row and its remove
   * button, `accepts` covers only the replace INPUT, which is the control that
   * would produce a refusal.
   *
   * This test did not exist when the falsification record first claimed
   * mutation U09 was killed by it. Writing the claim before the test is the
   * failure `CLAUDE.md` names as worse than making no claim at all.
   */
  it('keeps an unusable stored credential visible and removable', async () => {
    // Marzban: USERNAME_PASSWORD. The token is stored anyway, as a pre-shape
    // panel's would be.
    stubApi(
      detail({
        providerType: 'marzban',
        providerName: 'Marzban',
        credentials: {
          username: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
          password: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
          apiToken: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
        },
      }),
    );
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');

    // Visible: the row is there, and it is three, not two.
    const removes = screen.getAllByRole('button', { name: /^حذف — / });
    expect(removes.map((button) => button.getAttribute('aria-label'))).toContain('حذف — توکن API');
    // Told: the operator can only act on what the screen says.
    // Substring, because `metaFor` joins the replacement date and this marker
    // into one text node with a separator.
    expect(screen.getAllByText(/این نوع پنل از آن استفاده نمی‌کند/).length).toBeGreaterThan(0);
    // But NOT offered for replacement — that is the request the server refuses.
    expect(screen.queryByLabelText('توکن API')).toBeNull();
    // The two the shape does accept are still offered, so this is not a test
    // that would pass on a credentials tab that rendered nothing at all.
    expect(screen.getByLabelText('نام کاربری')).toBeInTheDocument();
    expect(screen.getByLabelText('گذرواژه')).toBeInTheDocument();
  });

  it('offers no credential write on an archived panel, but still shows what it holds', async () => {
    stubApi(detail({ status: 'ARCHIVED', providerType: 'sanaei', providerName: 'Sanaei (3X-UI)' }));
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();

    await waitFor(() => {
      expect(screen.queryByText('جایگزینی اعتبارنامه')).toBeNull();
    });
    expect(screen.queryAllByRole('button', { name: /^حذف — / })).toHaveLength(0);
    // The presence rows stay: knowing which credentials a retired panel still
    // holds is exactly what an operator needs before restoring it.
    expect(screen.getAllByText('تنظیم شده').length).toBeGreaterThan(0);
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
    renderPage(<NewPanelPage denied={false} mayRotate />);

    // A retry, which the silent form never offered.
    expect(await screen.findByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    // And no form that cannot work.
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });

  it('distinguishes an empty catalogue from a failed one', async () => {
    stubApi([providersRoute({ providers: [] })]);
    renderPage(<NewPanelPage denied={false} mayRotate />);
    expect(await screen.findByText('هیچ ارائه‌دهنده‌ای در دسترس نیست.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });

  /**
   * Initial credentials are a CREDENTIAL write, and the form says so.
   *
   * `PanelService.create` now authorizes `panels.credentials.rotate` whenever
   * the request carries credentials, because writing a panel's first password
   * is the same act as replacing it and was going through the door beside the
   * locked one. Offering the fields to an actor who lacks the permission would
   * draw a control whose only outcome is a denial — and a denial is not free:
   * it writes an audit row and an unresolvable operational event.
   */
  it('offers no credential field to an actor who may not rotate credentials', async () => {
    stubApi([providersRoute(CATALOGUE)]);
    renderPage(<NewPanelPage denied={false} mayRotate={false} />);
    await screen.findByLabelText('ارائه‌دهنده');

    fireEvent.change(screen.getByLabelText('ارائه‌دهنده'), { target: { value: 'sanaei' } });
    for (const label of ['نام کاربری', 'گذرواژه', 'توکن API']) {
      expect(screen.queryByLabelText(label), label).toBeNull();
    }
    // The panel itself can still be created — that is `panels.edit`.
    expect(screen.getByRole('button', { name: 'ذخیره' })).toBeInTheDocument();
  });

  /**
   * T12 on the create side. The server refuses a credential outside the
   * provider's shape, so offering the field can only produce a 400 after the
   * operator has typed a secret into it.
   */
  it('offers only the credential fields the chosen provider accepts', async () => {
    stubApi([providersRoute(CATALOGUE)]);
    renderPage(<NewPanelPage denied={false} mayRotate />);
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
    renderPage(<NewPanelPage denied={false} mayRotate />);
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
