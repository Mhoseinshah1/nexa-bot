import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { PanelsPage, PanelDetailPage } from '../../apps/web/src/pages/panels';
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
    stubApi(detail());
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
    stubApi(detail());
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'اعتبارنامه‌ها' }).click();
    await screen.findByText('جایگزینی اعتبارنامه');

    for (const label of ['نام کاربری', 'گذرواژه', 'توکن API']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
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

  it('says a capability is planned rather than pretending the panel can do it', async () => {
    stubApi(detail());
    renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    screen.getByRole('tab', { name: 'قابلیت‌ها' }).click();

    await screen.findByText('HEALTH_CHECK');
    // The descriptor declares HEALTH_CHECK and nothing else, so every other
    // capability must read as planned rather than as available.
    expect(screen.getAllByText('برنامه‌ریزی‌شده').length).toBeGreaterThan(10);
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
});
