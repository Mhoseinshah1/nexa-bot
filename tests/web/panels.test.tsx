import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { PanelsPage, PanelDetailPage, NewPanelPage } from '../../apps/web/src/pages/panels';
import { t } from '../../apps/web/src/i18n/web.fa';
import { panel, product, renderPage, stubApi } from './harness';

/** The panels list reads its archive filter from the URL, as `/system` does. */
const LIVE_ROUTE = { path: '/panels', query: new URLSearchParams() };

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
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
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
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);

    await screen.findByText('Frankfurt A');
    expect(screen.getByText('Marzban')).toBeInTheDocument();
    expect(screen.getByText('سالم')).toBeInTheDocument();
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });

  it('shows staleness as its own fact rather than folding it into the state', async () => {
    stubApi(list([panel({ health: { ...(panel().health as object), stale: true } })]));
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
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
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');

    // No column is a button, so no header can sort.
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header.querySelector('button')).toBeNull();
    }

    // The forward control on an ASCENDING keyset is NEWER — see the pin below.
    const newer = screen.getByRole('button', { name: 'تازه‌تر' });
    expect(newer).not.toBeDisabled();
    newer.click();

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('cursor=opaque-cursor-1'))).toBe(true);
    });
  });

  it('offers no next page when the server says there is none', async () => {
    stubApi(list([panel()], null));
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');
    expect(screen.getByRole('button', { name: 'تازه‌تر' })).toBeDisabled();
  });

  /**
   * Codex, review eight: `GET /panels` pages an ASCENDING keyset — oldest
   * first, `nextCursor` toward newer panels — and the shared pager labelled
   * the forward control "older" and the way back "newer", the opposite of
   * what each did. The forward control must say NEWER here and the way back
   * OLDER, while the descending lists keep the defaults.
   */
  it('labels the forward control newer, because the panel keyset ascends', async () => {
    const api = stubApi(list([panel()], 'opaque-cursor-1'));
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');

    const forward = screen.getByRole('button', { name: 'تازه‌تر' });
    const back = screen.getByRole('button', { name: 'قدیمی‌تر' });
    expect(forward).toBeEnabled();
    expect(back).toBeDisabled();
    forward.click();
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('cursor=opaque-cursor-1'))).toBe(true);
    });
    // And the way back to the first — oldest — page is OLDER.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeEnabled();
    });
  });

  it('shows a permission refusal rather than an empty list', async () => {
    stubApi(list([]));
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit={false} denied />);
    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
  });

  /**
   * F4/M8 — the panels toolbar had the gate and no test.
   *
   * A whole-project mutation run deleted `hidden={!mayRequest(panels, denied)}`
   * outright and all 277 tests passed. The round's own prose said the rule was
   * applied at "the three places nothing looked" and its mutation table listed
   * one of them, so two gates and this toolbar shipped as rules no test could
   * distinguish from their absence.
   *
   * Asserted on the ATTRIBUTE, deliberately. A role query cannot see this:
   * `dom-accessibility-api` short-circuits on the `hidden` IDL property, so
   * `queryByRole` returns null whether or not the element is painted — which
   * is how the toolbar shipped visible-but-role-invisible for a whole round.
   * The stylesheet half, that `[hidden]` actually stops the paint against
   * `.toolbar { display: flex }`, is asserted in `stylesheet-contract.test.tsx`
   * where the real CSS is in the document. Neither end proves the other.
   */
  it('withdraws the archive filter from an actor who may not read the fleet', async () => {
    stubApi(list([]));
    const { container } = renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit={false} denied />);
    await screen.findByText('شما به این بخش دسترسی ندارید.');

    const toolbar = container.querySelector('.toolbar');
    expect(toolbar, 'the toolbar is still rendered, just not shown').not.toBeNull();
    expect((toolbar as HTMLElement).hasAttribute('hidden')).toBe(true);
  });

  /**
   * F4/M9 — and neither did the pager beneath it.
   *
   * `CursorPager` is a SIBLING of `StateSwitch`, so the refusal card replaced
   * the table while the pager went on saying "showing 0" and offering an
   * "older" button that pushes a cursor — a new query key, and one more
   * refused request, against the question the card above has just said cannot
   * be answered. Reverting the gate to `queryState(panels) !== 'error'` (which
   * is true in `denied`, because a denied query is disabled and therefore
   * pending for ever) left the suite green.
   */
  it('takes the pager down with the fleet it was describing', async () => {
    stubApi(list([]));
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit={false} denied />);
    await screen.findByText('شما به این بخش دسترسی ندارید.');

    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تازه‌تر' })).toBeNull();
    expect(screen.queryByText('نمایش')).toBeNull();
  });

  /**
   * The OTHER half of both gates above, and the half that was revertible.
   *
   * Round 29 added tests for the toolbar and the pager and rendered both with
   * `denied`. `hidden={denied}` and `{!denied && (` then passed lint, prettier,
   * tsc and all 286 tests while restoring the exact regression they were
   * written to close: on a FINAL refusal — permission revoked mid-session, the
   * common case — `denied` is still false, so the archive Pills stay on screen
   * beside the refusal card and the pager goes on printing "showing 0" over
   * rows nobody can see. `mayRequest` and `queryState` are what make the two
   * states one rule; a test that only ever supplies one of them cannot tell the
   * rule from a coincidence.
   *
   * The sibling rule on the alerts page had both halves from the start. This is
   * the branch's signature shape — right at the site the author was looking at
   * — reproduced inside the commit written to remove it.
   */
  it('withdraws the filter and the pager when the fleet is finally refused', async () => {
    stubApi([
      {
        url: '/panels',
        body: {
          error: {
            kind: 'forbidden',
            code: 'access.permission_denied',
            message: 'no',
            correlationId: 'test',
          },
        },
        status: 403,
      },
    ]);
    const { container } = renderPage(
      // NOT denied: the permission list still says yes, the server says no.
      <PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />,
    );
    await screen.findByText('شما به این بخش دسترسی ندارید.');

    const toolbar = container.querySelector('.toolbar');
    expect((toolbar as HTMLElement).hasAttribute('hidden')).toBe(true);
    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تازه‌تر' })).toBeNull();
    expect(screen.queryByText('نمایش')).toBeNull();
  });

  /**
   * 1b — DENIED flipping true over rows already on screen, which is the state
   * the rule was written for and the one nothing supplied.
   *
   * Two tests bracket this gate and neither reaches it. Round 29's supplies
   * `denied` from the first render, where the query is `enabled: false` and
   * therefore `'loading'` — so the gate is closed for the wrong reason and
   * `denied ? 'denied' :` can be deleted with 290 green. Round 30's supplies
   * `denied={false}` with a 403. The real sequence is neither: the shell
   * re-reads permissions every 60 seconds, so `denied` goes true while the
   * query still holds the rows it fetched a moment ago, and without this term
   * the pager keeps reporting "showing N" for rows the operator may no longer
   * see and offers an "older" that mints a fresh refused request.
   */
  it('withdraws the pager when the permission is lost over rows already shown', async () => {
    stubApi(list([panel({ id: 'p1', name: 'Frankfurt A' })], 'c1'));
    const { rerender } = renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');
    // The rows are here, and so is the pager describing them.
    expect(screen.getByText('نمایش')).toBeInTheDocument();

    // The 60-second permission poll comes back without `panels.view`.
    rerender(<PanelsPage route={LIVE_ROUTE} mayEdit denied />);

    expect(screen.queryByText('نمایش')).toBeNull();
    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
  });

  /**
   * 1c — and the LOADING state, which round 29's record names as a defect it
   * fixed ("all three pagers rendered in `denied` and `loading`") and which no
   * test covers: widening the gate to accept `'loading'` leaves 290 green.
   */
  it('draws no pager before the first page has arrived', () => {
    stubApi(list([panel()]));
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
    // Synchronously after mount: the query is pending, nothing has been said
    // about how many rows there are, so nothing may claim to be showing any.
    expect(screen.queryByText('نمایش')).toBeNull();
  });

  /**
   * F3 — the `'empty'` arm. Narrowing the gate to `['ready']` left 299 green,
   * and it hides the only way OFF an empty page: paging forward onto rows that
   * have since been archived leaves `'empty'`, and the way-back button — "older"
   * on this ascending list — goes with the pager. That is the design claim's second direction — no screen
   * hides an action the server permits.
   */
  it('keeps the way back when a fleet page turns out to be empty', async () => {
    stubApi(list([]));
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
    await screen.findByText('هنوز پنلی ثبت نشده است.');
    expect(screen.getByText('نمایش')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeInTheDocument();
  });

  it('distinguishes an empty fleet from a failed request', async () => {
    stubApi(list([]));
    renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
    expect(await screen.findByText('هنوز پنلی ثبت نشده است.')).toBeInTheDocument();
  });
});

describe('the panel detail', () => {
  /** The id `panel()` mints, which is what the page writes to. */
  const PANEL_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';

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
        activation: null,
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
  /**
   * A panel whose stored credentials cannot authenticate offers no test.
   *
   * `attemptProbe` calls `toProviderCredentials`, which returns null for a
   * `USERNAME_PASSWORD` panel missing either half — so the request answers 412
   * `panel.credentials_missing` every time. Pressing a button that can only
   * fail is not free either: the refusal is recorded.
   *
   * The state is reachable by an ordinary route, not a contrived one. An actor
   * holding `panels.edit` but NOT `panels.credentials.rotate` creates a panel
   * — the create form correctly offers them no credential fields — and lands
   * straight on this page, where this button was the only thing to press.
   */
  it('offers no connection test when the stored credentials cannot authenticate', async () => {
    stubApi(
      detail({
        providerType: 'marzban',
        providerName: 'Marzban',
        credentials: {
          username: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
          password: { configured: false, lastReplacedAt: null },
          apiToken: { configured: false, lastReplacedAt: null },
        },
        activation: null,
      }),
    );
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    expect(screen.queryByRole('button', { name: 'تست اتصال' })).toBeNull();
    // And it SAYS why, on the health tab where the consequence shows up: the
    // monitor cannot probe it either, so its health stays unchecked with no
    // visible cause. An absent control on its own explains nothing.
    screen.getByRole('tab', { name: 'سلامت' }).click();
    expect(
      await screen.findByText(/اعتبارنامه‌های ذخیره‌شده برای این نوع پنل کامل نیستند/),
    ).toBeInTheDocument();
  });

  /**
   * The other direction, at the shape where it is easiest to get wrong.
   *
   * Sanaei is `TOKEN_OR_USERNAME_PASSWORD`: a token ALONE is enough, and a
   * gate written as "all three configured" would refuse a perfectly probeable
   * panel. The test above passes just as happily against that mistake.
   */
  it('offers the connection test when either half of an either/or shape is set', async () => {
    stubApi(
      detail({
        providerType: 'sanaei',
        providerName: 'Sanaei (3X-UI)',
        credentials: {
          username: { configured: false, lastReplacedAt: null },
          password: { configured: false, lastReplacedAt: null },
          apiToken: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
        },
        activation: null,
      }),
    );
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    expect(screen.getByRole('button', { name: 'تست اتصال' })).toBeInTheDocument();
    screen.getByRole('tab', { name: 'سلامت' }).click();
    await waitFor(() => {
      expect(
        screen.queryByText(/اعتبارنامه‌های ذخیره‌شده برای این نوع پنل کامل نیستند/),
      ).toBeNull();
    });
  });

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
    //
    // And it says WHICH THING WILL HAPPEN — which this test used to get wrong
    // about itself. It asserted "saving will overwrite their change" twelve
    // lines before proving, below, that the renamed field is ABSENT from the
    // write. The operator edited the base URL only; the form sends changed
    // fields only; the other administrator's rename is not going anywhere.
    //
    // So the notice here is the untouched one, and it must not promise either
    // an overwrite or the conflict error that only the versioned surfaces can
    // produce.
    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').toContain('تنها فیلدهایی را می‌فرستد');
    expect(notice.textContent ?? '').not.toContain('بازنویسی می‌کند');
    expect(notice.textContent ?? '').not.toContain('خطای تداخل');
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
    // Two presses now, and the second is the one that writes — see the Phase 6B
    // group below, which owns the rule. This case keeps asserting that the
    // control EXISTS on a live panel, which is what its name claims.
    const api = stubApi([
      ...detail(),
      { url: `/panels/${PANEL_ID}/status`, body: { panel: panel({ status: 'ARCHIVED' }) } },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive_confirm') }));
    await waitFor(() => {
      const write = api.calls.find((call) => call.url.includes('/status'));
      expect(write?.body).toMatchObject({ status: 'ARCHIVED' });
    });
  });

  // -------------------------------------------------------------------------
  // What the panel carries, and the second press on archive (Phase 6B)
  // -------------------------------------------------------------------------

  /** One service row, in the shape `serviceSummarySchema` declares. */
  const carriedService = (overrides: Record<string, unknown> = {}) => ({
    id: '019250ab-cdef-7012-8345-6789abcdef01',
    customerId: '019210ab-cdef-7012-8345-6789abcdef01',
    orderId: '019230ab-cdef-7012-8345-6789abcdef01',
    panelId: PANEL_ID,
    productId: '019220ab-cdef-7012-8345-6789abcdef01',
    state: 'ACTIVE',
    providerUsername: 'nx-7f3a91',
    providerUserId: '4821',
    hasSubscription: true,
    expiresAt: '2026-12-01T00:00:00.000Z',
    trafficLimitBytes: '53687091200',
    trafficUsedBytes: '1073741824',
    usageSyncedAt: '2026-09-15T08:00:00.000Z',
    deliveryState: 'DELIVERED',
    deliveredAt: '2026-09-10T12:35:00.000Z',
    provisionedAt: '2026-09-10T12:34:00.000Z',
    terminatedAt: null,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:35:00.000Z',
    ...overrides,
  });

  const workload = (
    products: readonly unknown[],
    services: readonly unknown[],
    cursors: { products?: string | null; services?: string | null } = {},
  ) => [
    // `/products?` and not `/products?panelId=`: `fetchProducts` writes `limit`
    // first, so the filter is not the first parameter. A route keyed on the
    // parameter ORDER is a stub that silently 404s when somebody reorders the
    // builder — which is how the first version of these five cases failed.
    { url: '/products?', body: { products, nextCursor: cursors.products ?? null } },
    { url: '/services?', body: { services, nextCursor: cursors.services ?? null } },
  ];

  const openWorkload = async () => {
    await screen.findByText('Frankfurt A');
    fireEvent.click(screen.getByRole('tab', { name: t('web.panel_tab_workload') }));
  };

  it('asks the server for this panel only, and never for the whole catalogue', async () => {
    // The filter is the point: an unfiltered request would render another
    // panel's products under this panel's heading, which is the "history
    // attributed by current reference" failure in a new place.
    const api = stubApi([...detail(), ...workload([product()], [carriedService()])]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await openWorkload();

    const asked = (path: string) =>
      api.calls.some((call) => call.url.includes(path) && call.url.includes(`panelId=${PANEL_ID}`));
    await waitFor(() => {
      expect(asked('/products')).toBe(true);
      expect(asked('/services')).toBe(true);
    });
  });

  it('names the products and the services this panel carries', async () => {
    stubApi([...detail(), ...workload([product()], [carriedService()])]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await openWorkload();

    expect(await screen.findByText('پلن یک‌ماهه')).toBeTruthy();
    expect(await screen.findByText('nx-7f3a91')).toBeTruthy();
  });

  it('carries no subscription URL, subscription ref or client id for a service it lists', async () => {
    // The same rule the services surface follows: the provider USERNAME is a
    // handle, and everything that grants access to the account is not on a
    // list an operator pages through.
    stubApi([...detail(), ...workload([], [carriedService()])]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await openWorkload();
    await screen.findByText('nx-7f3a91');

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('4821');
    expect(text).not.toContain('sub://');
  });

  it('says there is more on each list the server truncated, and only those', async () => {
    /*
     * BOTH cards, and the count is the assertion.
     *
     * The two notices are two guards on two responses, and `findByText` is
     * satisfied by either — so a single-notice assertion passes with one guard
     * inverted, which is how the first version of this case let exactly that
     * mutation live. Asserting the NUMBER separates them.
     */
    stubApi([
      ...detail(),
      ...workload([product()], [carriedService()], {
        products: 'more-products',
        services: 'more-services',
      }),
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await openWorkload();

    await waitFor(() => {
      expect(screen.getAllByText(t('web.panel_workload_more'))).toHaveLength(2);
    });
  });

  it('claims no completeness it was not given: neither list says there is more', async () => {
    stubApi([...detail(), ...workload([product()], [carriedService()])]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await openWorkload();
    await screen.findByText('nx-7f3a91');

    expect(screen.queryAllByText(t('web.panel_workload_more'))).toHaveLength(0);
  });

  it('distinguishes a panel that carries nothing from one whose lists failed', async () => {
    stubApi([...detail(), ...workload([], [])]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await openWorkload();

    expect(await screen.findByText(t('web.panel_workload_no_products'))).toBeTruthy();
    expect(await screen.findByText(t('web.panel_workload_no_services'))).toBeTruthy();
  });

  it('does not archive on the first press', async () => {
    /*
     * The rule this pull request adds, and the one worth a test on its own:
     * archiving used to be ONE click that took a panel out of the catalogue,
     * out of the monitor's schedule and out of every list.
     */
    const api = stubApi([...detail(), { url: '/status', body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive') }));

    expect(await screen.findByText(t('web.panel_archive_confirm_title'))).toBeTruthy();
    expect(api.calls.some((call) => call.url.includes('/status'))).toBe(false);
  });

  it('tells the operator how many services the panel still carries, before they confirm', async () => {
    // The number comes from the capacity projection the Overview card renders,
    // so the two cannot disagree about it.
    stubApi([
      ...detail({
        capacity: { maxServices: 50, services: 7, reservations: 0, used: 7, available: 43 },
      }),
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive') }));
    const confirmation = (await screen.findByText(t('web.panel_archive_confirm_title'))).closest(
      'div.stack',
    );
    // `Num` renders Western digits here, which is the shell's own choice and
    // not this test's to assert — what matters is that the COUNT is on screen.
    expect(confirmation?.textContent).toContain('7');
  });

  it('archives on the second press', async () => {
    const api = stubApi([
      ...detail(),
      { url: `/panels/${PANEL_ID}/status`, body: { panel: panel({ status: 'ARCHIVED' }) } },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive_confirm') }));

    await waitFor(() => {
      const write = api.calls.find((call) => call.url.includes('/status'));
      expect(write?.body).toMatchObject({ status: 'ARCHIVED' });
    });
  });

  it('takes the question back down when the operator declines it', async () => {
    const api = stubApi([...detail(), { url: '/status', body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive_cancel') }));

    await waitFor(() => {
      expect(screen.queryByText(t('web.panel_archive_confirm_title'))).toBeNull();
    });
    expect(api.calls.some((call) => call.url.includes('/status'))).toBe(false);
  });

  it('leaves no confirmed-looking screen behind when the archive is refused', async () => {
    /*
     * `onError` clears the flag as well as `onSuccess`. Without it the danger
     * banner and its confirm button stay drawn over a panel whose archive just
     * failed, which reads as "press it again" for a command that was refused.
     */
    const api = stubApi([
      ...detail(),
      {
        url: `/panels/${PANEL_ID}/status`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'panel.stale_write',
            message: 'no',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.panel_archive_confirm') }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('/status'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText(t('web.panel_archive_confirm_title'))).toBeNull();
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

  it('refuses to send a restore whose replacement name is empty', async () => {
    /*
     * The rule the Restore button carries once the rename field is open:
     * `disabled={status.isPending || renameOnRestore === ''}`.
     *
     * It had no test. `panelNameSchema` has a minimum length, so a restore
     * carrying `name: ''` can only come back 400 — a button whose single
     * possible outcome is a validation error the operator can see coming.
     *
     * Driven through the real sequence: restore refuses with
     * `panel.name_taken`, which opens the field pre-filled with the panel's
     * own name; clearing it must close the button rather than send.
     */
    const archived = detail({ status: 'ARCHIVED' });
    const api = stubApi([
      ...archived,
      {
        // The panel fixture's own id, not the route param. `PanelDetailPage`
        // is asked for `p1` but writes to the id the SERVER returned, so a
        // stub keyed on `p1` is never matched and the 409 arrives as an
        // unrouted 404 — which is how the first version of this test failed.
        url: `/panels/${PANEL_ID}/status`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'panel.name_taken',
            message: 'a live panel already holds that name',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    const restore = screen.getByRole('button', { name: 'بازگردانی از بایگانی' });
    fireEvent.click(restore);
    // The refusal opens the rename field, pre-filled with the current name.
    await screen.findByText(t('web.panel_restore_name_taken'));
    const field = document.getElementById(`restore-name-${PANEL_ID}`) as HTMLInputElement;
    expect(field.value).toBe('Frankfurt A');
    expect(restore.hasAttribute('disabled')).toBe(false);

    const before = api.calls.filter((call) => call.url.includes('/status')).length;
    fireEvent.change(field, { target: { value: '' } });
    expect(
      restore.hasAttribute('disabled'),
      'an empty replacement name can only be refused by the server',
    ).toBe(true);

    // And pressing it sends nothing, which is the consequence that matters.
    fireEvent.click(restore);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.calls.filter((call) => call.url.includes('/status')).length).toBe(before);

    // A non-empty replacement re-opens it, so the guard is the empty string
    // and not "disabled once the field appears".
    fireEvent.change(field, { target: { value: 'Frankfurt B' } });
    expect(restore.hasAttribute('disabled')).toBe(false);
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
        activation: null,
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

  /**
   * The restore dead end, from the operator's side.
   *
   * The API gained a replacement name, and for one commit the Web Admin could
   * not send one: `setPanelStatus` had no `name`, the Restore button posted a
   * bare status, and the 409 told the operator to rename a panel that
   * `POST /panels/:id` refuses to edit. The archive browser added beside it
   * meant they could now FIND the panel and be told to do something no screen
   * could do — the same dead end, better signposted.
   */
  it('offers a replacement name when a restore is refused because the name was taken', async () => {
    const archived = detail({ status: 'ARCHIVED' });
    const api = stubApi([
      ...archived,
      {
        // The FULL path: the harness matches by substring with longest-wins,
        // and the detail route's `/panels/` is longer than a bare `/status`,
        // so it would answer this POST with the panel body and the mutation
        // would look like a success.
        url: '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8/status',
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'panel.name_taken',
            message: 'Another panel took this name while it was archived.',
            details: {},
            correlationId: 'c1',
          },
        },
      },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // Nothing to resolve yet, so nothing is offered.
    expect(screen.queryByLabelText('نام تازه برای بازگردانی')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));

    // The refusal produces the one control that can act on it, pre-filled.
    const field = (await screen.findByLabelText('نام تازه برای بازگردانی')) as HTMLInputElement;
    expect(field.value).toBe('Frankfurt A');
    expect(screen.getByText(/نام قبلی این پنل را پنل دیگری گرفته است/)).toBeInTheDocument();

    // And the retry carries it to the server.
    fireEvent.change(field, { target: { value: 'Frankfurt A (restored)' } });
    fireEvent.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));

    await waitFor(() => {
      const writes = api.calls.filter((call) => call.method === 'POST');
      expect(writes.length).toBeGreaterThan(1);
    });
    const last = api.calls.filter((call) => call.method === 'POST').at(-1);
    expect(last?.body).toMatchObject({ status: 'DISABLED', name: 'Frankfurt A (restored)' });
  });

  /**
   * The notice must never fire against the operator's OWN write while it
   * settles.
   *
   * `save` and `status` adopt the row they were handed before `refresh()`
   * resolves, so for the width of that round trip `basis` holds the new values
   * and the query still holds the old ones — which reads as a concurrent
   * change. The stub answers in a microtask, so the suite could not see it;
   * with real latency the operator got "somebody else changed this" on top of
   * their own "saved" toast.
   *
   * The write's answer carries a NEWER `updatedAt` because that is what the
   * server does — `update` and `setStatus` both stamp it from the Clock — and
   * a fixture that returned the request's own revision unchanged was modelling
   * a server this one is not.
   */
  it('does not accuse anybody while the operator own write is still settling', async () => {
    const id = panel().id as string;
    const renamed = panel({ name: 'Frankfurt B', updatedAt: '2026-02-02T00:00:00.000Z' });
    const gate: { release: () => void } = { release: () => undefined };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    let detailCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        // BY METHOD as well as by path: the save POSTs to the same URL the
        // detail GETs from, so matching on the path alone made the write itself
        // wait on the gate and the test deadlocked.
        const isDetailRead = (init?.method ?? 'GET') === 'GET';
        if (url.endsWith(`/panels/${id}`) && isDetailRead) {
          detailCalls += 1;
          // The first load is the form's starting point. The SECOND is the
          // refetch after the save, and it is held open — that outstanding
          // request is the window this test exists for.
          if (detailCalls === 1) return json({ panel: panel() });
          await held;
          return json({ panel: renamed });
        }
        return json({ panel: renamed });
      }),
    );

    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt B' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    // The write has landed and the refetch has not. The form must say nothing
    // about anybody else having changed the row.
    await screen.findByText('ذخیره شد.');
    expect(screen.queryByText(/جای دیگری تغییر کرده/)).toBeNull();
    gate.release();
  });

  /**
   * ...and it DOES promise an overwrite when one is actually coming.
   *
   * Same concurrent rename, except this operator has edited the name too. Their
   * save carries `name`, so the other administrator's rename really is about to
   * be replaced, and the notice has to say so rather than reassure.
   */
  it('promises an overwrite only when the save will actually make one', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    const api = stubApi([route, { url: `/panels/${id}/status`, body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // This time the operator edits the NAME.
    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt mine' } });
    route.body = { panel: panel({ name: 'Renamed by somebody else' }) };
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));

    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').toContain('بازنویسی می‌کند');

    // ...and the save WILL make one. Asserting the message alone left the
    // "will actually make one" half of this test's own name unproved: mutating
    // `onSubmit` to drop `name` from the command left it green, still promising
    // an overwrite the request no longer carries.
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => {
      const write = api.calls.find(
        (call) => call.method === 'POST' && call.url.endsWith(`/panels/${id}`),
      );
      expect((write?.body as Record<string, unknown> | undefined)?.['name']).toBe('Frankfurt mine');
    });
  });

  /**
   * A status command in flight must NOT hide a concurrent change.
   *
   * `settling` suppresses the notice so our own write cannot be reported as
   * somebody else's. `save.isPending` is safe for that because it disables the
   * Save button in the same breath. `status.isPending` is not: Save stays live
   * across a Disable/Enable/Archive round trip, and `client.ts` sets no timeout
   * and no abort — so a stalled status POST hid a correct warning with no
   * bound, while the button it was warning about was still pressable.
   */
  it('keeps warning about a concurrent change while a status command is in flight', async () => {
    const id = panel().id as string;
    const gate: { release: () => void } = { release: () => undefined };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    let stored = panel();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url.includes('/status')) {
          // Held open: this is the window the notice must survive.
          await held;
          return json({ panel: stored });
        }
        if (url.endsWith(`/panels/${id}`) && (init?.method ?? 'GET') === 'GET') {
          return json({ panel: stored });
        }
        return json({ panel: stored });
      }),
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt mine' } });

    // Somebody else renames it, and the 90-second poll brings it in — which is
    // how a concurrent change actually reaches an open form.
    stored = panel({ name: 'Renamed by somebody else' });
    await vi.advanceTimersByTimeAsync(95_000);
    await screen.findByText(/جای دیگری تغییر کرده/);

    // Now the operator presses Disable, and that request never answers.
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));
    // WAIT for it to actually be in flight. Asserting straight after the click
    // reads the render before `isPending` has flushed, so the notice is still
    // on screen for a reason that has nothing to do with the rule — which is
    // why the first version of this test could not be killed by re-adding
    // `status.isPending`.
    await waitFor(() => {
      expect(calls.some((call) => call.includes('/status'))).toBe(true);
    });

    // The warning must still be there, and Save — which is still enabled —
    // must still be the thing it warns about.
    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').toContain('بازنویسی می‌کند');
    expect(screen.getByRole('button', { name: 'ذخیره' })).toBeEnabled();
    gate.release();
    vi.useRealTimers();
  });

  /**
   * Two administrators asked to fix the same typo.
   *
   * B renames the panel; A, with the form open, types the same correction. A's
   * save writes the identical string, so nothing of B's is replaced — and
   * warning A that it would sent them to "load the fresh value", which resets
   * the whole form and discards A's own unsaved base URL to avoid a loss that
   * could not happen.
   */
  it('does not call an identical correction an overwrite', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    stubApi([route, { url: `/panels/${id}/status`, body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt B' } });
    // ...and somebody else has already made exactly that change.
    route.body = { panel: panel({ name: 'Frankfurt B' }) };
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));

    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').toContain('تنها فیلدهایی را می‌فرستد');
    expect(notice.textContent ?? '').not.toContain('بازنویسی می‌کند');
  });

  /**
   * An ARCHIVED panel has no Save button — `PanelService.update` refuses one
   * with a 412 — so a notice about what saving will do describes a control that
   * does not exist and a request the server would not accept.
   *
   * The two inputs ARE still on screen, disabled, holding the operator's text.
   * This docstring said they were gone, nine lines above a comment in its own
   * body saying they were not, and that false premise is what an earlier round
   * used to argue the notice could be dropped here entirely.
   */
  it('says nothing about saving a panel that can no longer be saved', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    stubApi([route, { url: `/panels/${id}/status`, body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt mine' } });
    // Somebody else archives AND renames it; a status change refetches the row
    // into this open form, which is how the archived state arrives here.
    route.body = { panel: panel({ name: 'Renamed by somebody else', status: 'ARCHIVED' }) };
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
    });
    // The notice STAYS — it is the only thing that says the row moved, and the
    // only control that re-syncs the draft, and the disabled inputs are still
    // on screen holding the operator's text. What it must not do is say
    // anything about saving, because there is no save.
    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').not.toContain('بازنویسی می‌کند');
    expect(notice.textContent ?? '').not.toContain('تنها فیلدهایی را می‌فرستد');
    expect(screen.getByRole('button', { name: 'گرفتن مقدار تازه' })).toBeInTheDocument();
  });

  /**
   * A base URL corrected to an equivalent spelling is not an overwrite.
   *
   * `validateUrl` stores `new URL(...).toString()`, so `:443` and the implicit
   * default port are the same stored value. Comparing raw text warned two
   * administrators making the same correction about each other, and the escape
   * from that warning resets the whole form.
   */
  it('does not call an equivalent url an overwrite', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    stubApi([route, { url: `/panels/${id}/status`, body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.change(screen.getByLabelText('نشانی پایه'), {
      target: { value: 'https://panel.example:443/v2' },
    });
    route.body = { panel: panel({ baseUrl: 'https://panel.example/v2' }) };
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));

    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').not.toContain('بازنویسی می‌کند');
  });

  /**
   * A restore that renames is the operator's OWN action, and the form must
   * say so.
   *
   * `status.onSuccess` used to ignore the row it was handed, so `basis.name`
   * kept the pre-restore value while the query returned the new one — and
   * `changedElsewhere` fired, telling the operator that somebody else had
   * changed the row, in a notice about concurrent editing, with no concurrency
   * in the flow at all.
   */
  it('does not blame a third party for a rename the operator just made', async () => {
    const id = panel().id as string;
    const archived = detail({ status: 'ARCHIVED' });
    // `detail()` registers the route as the PREFIX `/panels/`, not the full id
    // — the harness matches by substring with longest-wins — so this looks it
    // up the way it is actually registered. Finding it by id silently returned
    // `undefined`, the refetch kept serving the archived row, and the test
    // failed for a reason that had nothing to do with the rule.
    const detailRoute = archived.find((entry) => entry.url === '/panels/');
    const renamed = panel({ name: 'Frankfurt B', status: 'DISABLED' });
    const statusRoute: {
      url: string;
      body: unknown;
      status?: number;
    } = {
      url: `/panels/${id}/status`,
      status: 409,
      body: {
        error: {
          kind: 'CONFLICT',
          code: 'panel.name_taken',
          message: 'Another panel took this name while it was archived.',
          details: {},
          correlationId: 'c1',
        },
      },
    };
    stubApi([...archived, statusRoute]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // The first restore is refused, which is what offers the rename field.
    fireEvent.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));
    const field = (await screen.findByLabelText('نام تازه برای بازگردانی')) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Frankfurt B' } });

    // The second carries the name, and the server both restores and renames.
    statusRoute.status = 200;
    statusRoute.body = { panel: renamed };
    if (detailRoute) detailRoute.body = { panel: renamed };
    fireEvent.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));

    await waitFor(() => {
      expect((screen.getByLabelText('نام') as HTMLInputElement).value).toBe('Frankfurt B');
    });
    // The operator renamed it. Nothing may tell them somebody else did.
    expect(screen.queryByText(/جای دیگری تغییر کرده/)).toBeNull();
  });

  /**
   * A second press with the name unchanged is LEGITIMATE — the colliding panel
   * may have been renamed or archived in between, which frees the name — so the
   * button stays live. What it must not do is answer with the blunt edit
   * message: the operator is acting on advice this screen gave them, and the
   * reply has to keep saying what to do.
   *
   * An earlier version disabled the button for every refused name instead. That
   * killed the retry that would have succeeded, and left a dead control with no
   * message and no way back short of a reload — the dead end this screen exists
   * to remove, reintroduced by a fix for a smaller version of it.
   */
  it('lets the operator press restore again, because the name may since have been freed', async () => {
    const archived = detail({ status: 'ARCHIVED' });
    const api = stubApi([
      ...archived,
      {
        url: '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8/status',
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'panel.name_taken',
            message: 'Another panel took this name while it was archived.',
            details: {},
            correlationId: 'c1',
          },
        },
      },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    const restore = () => screen.getByRole('button', { name: 'بازگردانی از بایگانی' });
    fireEvent.click(restore());
    await screen.findByLabelText('نام تازه برای بازگردانی');
    await waitFor(() => {
      expect(restore()).toBeEnabled();
    });

    const before = api.calls.filter((call) => call.method === 'POST').length;
    fireEvent.click(restore());
    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === 'POST').length).toBeGreaterThan(before);
    });
    // ...and it carried the name, so the server can answer the specific case.
    const last = api.calls.filter((call) => call.method === 'POST').at(-1);
    expect(last?.body).toMatchObject({ status: 'DISABLED', name: 'Frankfurt A' });
  });

  /**
   * And a restore that was never refused sends no name at all — the API
   * refuses one outside this transition, and a rename nobody asked for is a
   * write nobody asked for.
   */
  it('sends no replacement name on a restore that was not refused', async () => {
    const api = stubApi([
      ...detail({ status: 'ARCHIVED' }),
      { url: '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8/status', body: { panel: panel() } },
    ]);
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const write = api.calls.find((call) => call.method === 'POST');
    expect(write?.body).toEqual({ status: 'DISABLED', idempotencyKey: expect.any(String) });
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

  /**
   * The window between a write's response and the refetch that confirms it.
   *
   * Every previous version of the concurrency notice was suppressed by a
   * mutation's `isPending` flag, and every one of them was found false in a
   * state where that flag was the wrong one or had already cleared. The suite
   * could not see any of it because `stubApi` answers in a microtask, which
   * closes the window before React renders inside it. These tests hold the GET
   * open so the window is a real interval.
   */
  const gatedApi = (
    routes: readonly { url: string; method?: string; body: unknown; status?: number }[],
  ) => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let gate: Promise<void> | null = null;
    let open: (() => void) | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({
          url,
          method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        if (method === 'GET' && gate !== null) await gate;
        // A route may pin the METHOD as well as the path. `POST /panels/:id`
        // and `GET /panels/:id` are the same path, so a stub that routes on the
        // URL alone answers a save with the detail body and a refetch with the
        // save's — which is how a test meant to fail a refetch quietly stopped
        // failing anything.
        const matches = routes.filter(
          (route) => url.includes(route.url) && (route.method ?? method) === method,
        );
        const route = matches.sort((a, b) => b.url.length - a.url.length)[0];
        const body =
          route === undefined
            ? {
                error: {
                  kind: 'not_found',
                  code: 'test.unrouted',
                  message: url,
                  correlationId: 'test',
                },
              }
            : route.body;
        return new Response(JSON.stringify(body), {
          status: route === undefined ? 404 : (route.status ?? 200),
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    return {
      calls,
      /** Hold every subsequent GET. */
      hold() {
        gate = new Promise<void>((resolve) => {
          open = resolve;
        });
      },
      release() {
        open?.();
        gate = null;
        open = null;
      },
    };
  };

  /**
   * The restore-with-rename path, which is the ONE flow where this operator's
   * own write moves `basis` while the query still holds the row it replaced.
   *
   * Archiving releases a panel's name, so a restore can be refused 409
   * `panel.name_taken`; the operator supplies a replacement, the write
   * succeeds, and until the refetch lands `basis.name` is the new name while
   * `panel.name` is the old one. Told as "somebody else changed this", that
   * attributes the operator's own rename to a third party — inside a notice
   * about concurrency, with no concurrency anywhere in the flow.
   */
  it('does not blame a third party for the rename the operator gave a restore', async () => {
    const id = panel().id as string;
    const detailRoute = {
      url: `/panels/${id}`,
      body: { panel: panel({ status: 'ARCHIVED' }) } as unknown,
    };
    const statusRoute = {
      url: `/panels/${id}/status`,
      body: {
        error: {
          kind: 'conflict',
          code: 'panel.name_taken',
          message: 'taken',
          correlationId: 'test',
        },
      } as unknown,
      status: 409,
    };
    const api = gatedApi([detailRoute, statusRoute]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // The name this panel had was claimed by a live panel while it was archived.
    fireEvent.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));
    const replacement = await screen.findByLabelText('نام تازه برای بازگردانی');
    fireEvent.change(replacement, { target: { value: 'Frankfurt B' } });

    // The second restore succeeds and returns the row it stored — a row the
    // detail query has not seen yet, and will not see until it refetches.
    statusRoute.status = 200;
    statusRoute.body = {
      panel: panel({
        name: 'Frankfurt B',
        status: 'DISABLED',
        updatedAt: '2026-02-02T00:00:00.000Z',
      }),
    };
    api.hold();
    fireEvent.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));

    // Inside the held refetch: the write has landed, the query has not.
    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(1);
    });
    expect(screen.queryByText(/جای دیگری تغییر کرده/)).toBeNull();

    // And it stays absent once the row the operator wrote actually arrives.
    detailRoute.body = {
      panel: panel({
        name: 'Frankfurt B',
        status: 'DISABLED',
        updatedAt: '2026-02-02T00:00:00.000Z',
      }),
    };
    api.release();
    await screen.findByText('Frankfurt B');
    expect(screen.queryByText(/جای دیگری تغییر کرده/)).toBeNull();
  });

  /**
   * The same false accusation, reached with no mutation pending and no server
   * misbehaviour — the background poll racing the write.
   *
   * A poll fetch issued BEFORE the save commits is still in flight when it
   * does. `invalidateQueries` does not start a second request for a query that
   * is already fetching; it awaits the one in flight. So `refresh()` — and with
   * it `save.isPending`, which spans the awaited `onSuccess` — resolves on the
   * PRE-WRITE row, and the cache holds it until the next poll ninety seconds
   * later. `basis` is the row the operator just stored, `panel` is the row it
   * replaced, and a rule that suppresses only "while our own write is settling"
   * has already stopped suppressing.
   *
   * A failed refetch is NOT this case and needs no rule: `queryState` maps
   * `isError` to the error state, so the form is not on screen to say anything.
   */
  it('does not accuse anybody when a poll in flight answers with the replaced row', async () => {
    const id = panel().id as string;
    const readRoute = {
      url: `/panels/${id}`,
      method: 'GET',
      body: { panel: panel() } as unknown,
      status: 200,
    };
    const writeRoute = {
      url: `/panels/${id}`,
      method: 'POST',
      body: {
        panel: panel({ name: 'Frankfurt mine', updatedAt: '2026-02-02T00:00:00.000Z' }),
      } as unknown,
    };
    const api = gatedApi([readRoute, writeRoute]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // A poll goes out and does not come back yet.
    api.hold();
    await vi.advanceTimersByTimeAsync(95_000);
    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(1);
    });

    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });

    // The poll answers now, with the row the save replaced — and that is what
    // `refresh()` was waiting on, so the write finishes on stale data.
    api.release();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'در حال ذخیره…' })).toBeNull();
    });
    expect((screen.getByLabelText('نام') as HTMLInputElement).value).toBe('Frankfurt mine');
    expect(screen.queryByText(/جای دیگری تغییر کرده/)).toBeNull();
    vi.useRealTimers();
  });

  /**
   * A name the server will store unchanged is not an overwrite.
   *
   * `panelNameSchema` is `z.string().trim()`, so a draft that differs from the
   * stored value only in surrounding whitespace stores the identical string.
   * Warning about it sends the operator to "load the fresh value", which resets
   * the whole form — the loss the warning exists to prevent, incurred to
   * prevent a write that changes nothing.
   */
  it('does not call a name an overwrite when the server would trim it to the stored one', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    stubApi([route, { url: `/panels/${id}/status`, body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // Both administrators correct the name to the same value; the other one
    // saved first, and this one typed a trailing space.
    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt B ' } });
    route.body = { panel: panel({ name: 'Frankfurt B' }) };
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));

    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').not.toContain('بازنویسی می‌کند');
  });

  /**
   * The `changedRemotely` term of `overwrites`, on its own.
   *
   * Without it, an ordinary edit to a field NOBODY else touched is called an
   * overwrite as soon as some OTHER field has moved — the operator is told they
   * are about to clobber a colleague on the one field they are the only one to
   * have changed.
   */
  it('calls no overwrite on the field the operator alone changed', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    stubApi([route, { url: `/panels/${id}/status`, body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // This operator renames. Somebody else touches the BASE URL, not the name —
    // and rewrites it to an EQUIVALENT spelling, so that field cannot become an
    // overwrite under any single-term mutation and the assertion below is about
    // the name term alone.
    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt mine' } });
    route.body = { panel: panel({ baseUrl: 'https://panel.example:443/api' }) };
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));

    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').not.toContain('بازنویسی می‌کند');
  });

  /**
   * A draft that is not yet a URL falls back to comparing the text.
   *
   * `new URL()` throws on a half-typed address, and the catch decides what a
   * comparison the operator's keystrokes have made impossible should answer.
   * Answering "identical" suppresses a real overwrite warning; answering
   * "different" raises one against a value the operator has not finished
   * typing. It compares the raw text, which is right in both directions.
   */
  it('compares a half-typed base URL as text rather than guessing', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    stubApi([route, { url: `/panels/${id}/status`, body: { panel: panel() } }]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // Not parseable by `new URL`, and not the stored value either: a real
    // overwrite, mid-keystroke.
    fireEvent.change(screen.getByLabelText('نشانی پایه'), { target: { value: 'panel.example' } });
    route.body = { panel: panel({ baseUrl: 'https://moved.example/api' }) };
    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال‌سازی' }));

    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    expect(notice.textContent ?? '').toContain('بازنویسی می‌کند');
  });

  /**
   * A tab click must not destroy the draft, the basis, or the revision.
   *
   * The overview holds all of them, and the tab strip used to unmount it — so
   * an operator who saved, glanced at Health while the confirming refetch was
   * in flight, and came back found their own save apparently reverted (the
   * fields re-seeded from the row the query still held) and a notice accusing
   * somebody else of having made the change they had just made themselves.
   *
   * The window this happens in is the one round 22's rule exists for, and the
   * rule's memory lived inside the component the click destroyed.
   */
  it('keeps the draft and the revision across a tab click during a save', async () => {
    const id = panel().id as string;
    const readRoute = {
      url: `/panels/${id}`,
      method: 'GET',
      body: { panel: panel() } as unknown,
    };
    const writeRoute = {
      url: `/panels/${id}`,
      method: 'POST',
      body: {
        panel: panel({ name: 'Frankfurt mine', updatedAt: '2026-02-02T00:00:00.000Z' }),
      } as unknown,
    };
    const api = gatedApi([readRoute, writeRoute]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt mine' } });
    api.hold();
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });

    // Away and back, while the confirming refetch is still outstanding.
    fireEvent.click(screen.getByRole('tab', { name: 'سلامت' }));
    fireEvent.click(screen.getByRole('tab', { name: 'کلیات' }));
    // The draft is the operator's, not the row the query is still holding.
    expect((screen.getByLabelText('نام') as HTMLInputElement).value).toBe('Frankfurt mine');
    // And the REVISION survived too. `basis` is the row the save stored while
    // the query still holds the one it replaced, so without `written` this is
    // where the form accuses a third party. Asserted HERE, inside the held
    // refetch — after `release()` the two agree and the assertion is vacuous,
    // which is what an earlier version of this test did.
    expect(screen.queryByText(/جای دیگری تغییر کرده/)).toBeNull();

    // The refetch lands with the row the operator themselves wrote.
    readRoute.body = writeRoute.body;
    api.release();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'در حال ذخیره…' })).toBeNull();
    });
    expect((screen.getByLabelText('نام') as HTMLInputElement).value).toBe('Frankfurt mine');
    expect(screen.queryByText(/جای دیگری تغییر کرده/)).toBeNull();
  });

  /**
   * A failing background poll must not throw the page away.
   *
   * `queryState` mapped `isError` to the error state, and TanStack Query sets
   * `status: 'error'` on a failed BACKGROUND refetch while `data` is still
   * there — so one transient 5xx from the ninety-second poll replaced the whole
   * detail with an error card, unmounting the tab subtree and silently
   * discarding the operator's unsaved draft, their basis, and the revision
   * their own writes had stored. No operator action is involved: it happens on
   * a timer, and it lands inside the same window the concurrency rule exists
   * for.
   *
   * Keeping the page is only half of it. What is on screen is now older than
   * the server, and a screen that has stopped updating without saying so is the
   * defect this admin exists to remove — so the failure is stated instead of
   * being drawn as an error card over the top of good data.
   */
  it('keeps the page and the draft when a background poll fails', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown, status: 200 };
    stubApi([route]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt mine' } });

    // The poll fails. The query keeps the row it has and reports an error.
    route.status = 503;
    route.body = {
      error: { kind: 'internal', code: 'test.down', message: 'down', correlationId: 'test' },
    };
    await vi.advanceTimersByTimeAsync(95_000);

    // The form is still there, still holding what the operator typed.
    expect(screen.getByLabelText('نام')).toBeInTheDocument();
    expect((screen.getByLabelText('نام') as HTMLInputElement).value).toBe('Frankfurt mine');
    vi.useRealTimers();
  });

  /**
   * ...and it says so, which is the other half and a separate rule.
   *
   * Keeping the page and telling the truth about it are two changes, and a
   * single test asserting both cannot tell the reader which one broke. This
   * one dies if the warning is dropped; the one above dies if the page is.
   */
  it('says so when the data on screen is older than the server', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown, status: 200 };
    stubApi([route]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    expect(screen.queryByText(/تازه‌سازی این صفحه انجام نشد/)).toBeNull();

    route.status = 503;
    route.body = {
      error: { kind: 'internal', code: 'test.down', message: 'down', correlationId: 'test' },
    };
    await vi.advanceTimersByTimeAsync(95_000);

    expect(screen.getByText(/تازه‌سازی این صفحه انجام نشد/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  /**
   * The idempotency key of a credential rotation survives a tab click.
   *
   * `useSubmissionKey` deliberately KEEPS its key when nothing came back — a
   * 5xx or a dropped connection is "did that work?", not "do it twice", and a
   * fresh key turns the operator's question into a second command. The key was
   * a `useRef` inside `CredentialsTab`, which the tab strip unmounts, and the
   * natural response to an ambiguous rotation failure is exactly the action
   * that destroyed it: go and look at Health to see whether it took.
   *
   * The retry then carries a NEW key with an identical payload, so
   * `PanelService.setCredentials` misses the idempotency hit and writes the
   * credential a second time — a second CRITICAL audit row, and the panel's
   * probe eligibility reset — for one operator intention.
   *
   * An earlier round asserted in a comment and a commit message that this tab
   * "genuinely holds nothing that must outlive the click". That was wrong: the
   * typed secrets should indeed be dropped, and the key must not be.
   */
  it('keeps a credential rotation idempotency key across a tab click', async () => {
    const id = panel().id as string;
    const readRoute = { url: `/panels/${id}`, method: 'GET', body: { panel: panel() } as unknown };
    const writeRoute = {
      url: `/panels/${id}/credentials`,
      method: 'POST',
      body: {
        error: { kind: 'internal', code: 'test.down', message: 'down', correlationId: 'test' },
      } as unknown,
      status: 503,
    };
    const api = gatedApi([readRoute, writeRoute]);
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    const rotate = async () => {
      fireEvent.change(screen.getByLabelText('گذرواژه'), { target: { value: 'hunter2' } });
      fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    };
    const keys = () =>
      api.calls
        .filter((call) => call.method === 'POST' && call.url.includes('/credentials'))
        .map((call) => (call.body as { idempotencyKey?: string }).idempotencyKey);

    fireEvent.click(screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }));
    await rotate();
    await waitFor(() => {
      expect(keys()).toHaveLength(1);
    });

    // "Did that work?" — the operator goes to look, and comes back.
    fireEvent.click(screen.getByRole('tab', { name: 'سلامت' }));
    fireEvent.click(screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }));
    await rotate();
    await waitFor(() => {
      expect(keys()).toHaveLength(2);
    });

    const [first, second] = keys();
    expect(second).toBe(first);
  });

  /**
   * A permanent refusal takes the screen down; it does not become a warning.
   *
   * Keeping data through a failed refetch is right for a blip and wrong for an
   * answer. `pollUnlessFinal` STOPS on a final answer — a 403 when a permission
   * is revoked mid-session, or a `ZodError` from a tab holding the previous
   * release across a deploy — so there is no next poll to recover. Letting data
   * win there leaves the tab strip, the editable identity form, the credential
   * rotation form and the Test-connection button all on screen, asserting
   * capabilities the server has just refused, for ever.
   *
   * `sessionView` reached this rule first and says so in `app.tsx`: data wins
   * over a RETRYABLE error and only over a retryable one, and the two rules
   * have to agree about which failures are worth waiting through.
   */
  it('takes the screen down when the refusal is final, rather than warning', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown, status: 200 };
    stubApi([route]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<PanelDetailPage id={id} mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');

    // The permission is revoked. This is an ANSWER, not a blip.
    route.status = 403;
    route.body = {
      error: {
        kind: 'forbidden',
        code: 'access.permission_denied',
        message: 'no',
        correlationId: 'test',
      },
    };
    await vi.advanceTimersByTimeAsync(95_000);

    await waitFor(() => {
      expect(screen.queryByLabelText('نام')).toBeNull();
    });
    // No form, no tabs, and no warning implying a refresh that will never come.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByText(/تازه‌سازی این صفحه انجام نشد/)).toBeNull();
    /*
     * The REFUSAL's copy, not the connection failure's.
     *
     * The card said "خطا در ارتباط با سرور — ارتباط با سرور برقرار نشد. دوباره
     * تلاش کنید" for a 403 the server answered correctly in microseconds: a
     * false account of what happened, next to an instruction to retry, next to
     * no button — because the retry is now correctly withheld. `StateSwitch`
     * had the right copy all along; a MID-SESSION revocation never reached it,
     * since `denied` comes from the permission list fetched at sign-in.
     */
    expect(screen.getByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(screen.queryByText('خطا در ارتباط با سرور')).toBeNull();
    expect(screen.queryByText(/ارتباط با سرور برقرار نشد/)).toBeNull();
    /*
     * And the HEADING goes with it, which is a separate rule.
     *
     * `PageHead` renders above `StateSwitch` and read `panel.data` directly, so
     * the tab strip and the form came down while the panel's name, its provider
     * and its Test-connection button stayed on screen over the error card. That
     * button records an `access.permission_denied` event and a DENIED audit row
     * per press — a control that can never work, manufacturing exactly the noise
     * the alerts page exists to keep clear. An earlier commit message listed
     * this button among what the OLD rule left drawn; it was still drawn.
     */
    expect(screen.queryByRole('button', { name: 'تست اتصال' })).toBeNull();
    expect(screen.queryByText('Frankfurt A')).toBeNull();
    expect(screen.queryByText('Marzban')).toBeNull();
    // And no retry: after a final answer it can only be refused again.
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).toBeNull();
    vi.useRealTimers();
  });

  /**
   * A viewer without `panels.edit` gets the notice and no writable control.
   *
   * Both halves matter and neither had a test. The notice is the only signal
   * that the row moved and carries the only control that re-syncs the draft, so
   * gating it on write access left a viewer looking at values that had silently
   * gone stale. And `mayWrite` folding in `mayEdit` is what keeps the two text
   * fields and the Save button off their screen — without it this page offers a
   * `panels.view` actor a write the server will refuse.
   */
  it('tells a viewer the row moved without offering them a write', async () => {
    const id = panel().id as string;
    const route = { url: `/panels/${id}`, body: { panel: panel() } as unknown };
    stubApi([route]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<PanelDetailPage id={id} mayEdit={false} mayRotate={false} denied={false} />);
    await screen.findByText('Frankfurt A');

    expect(screen.getByLabelText('نام')).toBeDisabled();
    expect(screen.getByLabelText('نشانی پایه')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();

    // A viewer has no lifecycle control to force a refetch with, so the only
    // way a concurrent change reaches their open page is the 90-second poll —
    // which is also the only way it reaches anybody who is not writing.
    route.body = { panel: panel({ name: 'Renamed by somebody else' }) };
    await vi.advanceTimersByTimeAsync(95_000);
    const notice = await screen.findByText(/جای دیگری تغییر کرده/);
    // Nothing about saving, and nothing about an edit they never began.
    expect(notice.textContent ?? '').not.toContain('بازنویسی می‌کند');
    expect(notice.textContent ?? '').not.toContain('تنها فیلدهایی را می‌فرستد');
    expect(notice.textContent ?? '').not.toContain('ویرایش شما');
    expect(screen.getByRole('button', { name: 'گرفتن مقدار تازه' })).toBeInTheDocument();
    vi.useRealTimers();
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
    renderPage(<NewPanelPage denied={false} mayRotate mayView />);

    // A retry, which the silent form never offered.
    expect(await screen.findByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    // And no form that cannot work.
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });

  it('distinguishes an empty catalogue from a failed one', async () => {
    stubApi([providersRoute({ providers: [] })]);
    renderPage(<NewPanelPage denied={false} mayRotate mayView />);
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
    renderPage(<NewPanelPage denied={false} mayRotate={false} mayView />);
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
    renderPage(<NewPanelPage denied={false} mayRotate mayView />);
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
    renderPage(<NewPanelPage denied={false} mayRotate mayView />);
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
