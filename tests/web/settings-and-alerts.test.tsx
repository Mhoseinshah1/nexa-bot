import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { AlertsPage } from '../../apps/web/src/pages/alerts';
import { SystemPage } from '../../apps/web/src/pages/system';
import { event, renderPage, setting, stubApi } from './harness';

const settings = (rows: unknown[]) => [{ url: '/settings', body: { settings: rows } }];

describe('the settings screen', () => {
  /**
   * Owner revision 22 — several support accounts, with add, remove, reorder and
   * validate. None of those is expressible in a text field, which is why the
   * key gets a control of its own rather than a JSON blob to type.
   */
  it('edits support accounts as an ordered list', async () => {
    stubApi(
      settings([
        setting({
          key: 'support.accounts',
          value: ['@Support1', '@Support2'],
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
        }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);

    await screen.findByText('support.accounts');
    // One label per row, distinguished by its position: three identically
    // labelled fields are indistinguishable to a screen reader.
    expect((screen.getByLabelText('شناسهٔ پشتیبانی 1') as HTMLInputElement).value).toBe(
      '@Support1',
    );
    expect((screen.getByLabelText('شناسهٔ پشتیبانی 2') as HTMLInputElement).value).toBe(
      '@Support2',
    );
    expect(screen.getByRole('button', { name: 'افزودن حساب پشتیبانی' })).toBeInTheDocument();
    // Reordering is real, and keyboard-reachable: move buttons rather than a
    // drag handle a keyboard user cannot operate.
    expect(screen.getAllByRole('button', { name: 'انتقال به پایین' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'حذف' }).length).toBe(2);
  });

  it('sends the reordered list, in the new order', async () => {
    const api = stubApi([
      ...settings([
        setting({
          key: 'support.accounts',
          value: ['@Support1', '@Support2'],
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
          version: 3,
          source: 'TENANT',
        }),
      ]),
      {
        url: '/settings/support.accounts',
        body: {
          setting: setting({ key: 'support.accounts', value: ['@Support2', '@Support1'] }),
          changed: true,
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('support.accounts');

    fireEvent.click(screen.getAllByRole('button', { name: 'انتقال به بالا' })[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({
        value: ['@Support2', '@Support1'],
        expectedVersion: 3,
      });
    });
  });

  /** Owner revision 23 — channels, each with a required-membership flag. */
  it('edits channels with a mandatory flag per channel', async () => {
    stubApi(
      settings([
        setting({
          key: 'telegram.channels',
          value: [{ handle: '@Channel1', mandatory: true }],
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
        }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);

    await screen.findByText('telegram.channels');
    expect((screen.getByLabelText('شناسهٔ کانال 1') as HTMLInputElement).value).toBe('@Channel1');
    const flag = screen.getByRole('switch', { name: 'عضویت اجباری 1' });
    expect(flag).toHaveAttribute('aria-checked', 'true');
  });

  /**
   * Owner revision 24 — an amount AND a currency, plus the precedence rule.
   *
   * The per-gateway override cannot be expressed: no payment gateway is
   * registered anywhere in this system, so there is nothing for an override to
   * be keyed by. The screen says that rather than leaving the gap.
   */
  it('edits the top-up minimum as money and states the precedence it cannot yet honour', async () => {
    stubApi(
      settings([
        setting({
          key: 'wallet.topup.minimum',
          value: { amountMinor: '20000', currency: 'IRT' },
          zeroMeaning: 'DISABLES',
          configures: null,
          consumer: 'PLANNED',
        }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);

    await screen.findByText('wallet.topup.minimum');
    expect((screen.getByLabelText('مبلغ به کوچک‌ترین واحد') as HTMLInputElement).value).toBe(
      '20000',
    );
    expect((screen.getByLabelText('واحد پول') as HTMLSelectElement).value).toBe('IRT');
    expect(screen.getByText(/حداقلِ مخصوص هر درگاه/)).toBeInTheDocument();
    expect(screen.getByText(/هیچ درگاه پرداختی ثبت نشده/)).toBeInTheDocument();
  });

  /** Owner revision 1 — the currency every amount inherits. */
  it('offers Toman and Rial as the store currency, and nothing else', async () => {
    stubApi(
      settings([
        setting({ key: 'sales.currency', value: 'IRT', configures: null, consumer: 'PLANNED' }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('sales.currency');

    const select = screen.getByLabelText('واحد پول') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['IRT', 'IRR']);
    expect([...select.options].map((option) => option.text)).toEqual(['تومان', 'ریال']);
  });

  /**
   * A setting nothing reads must SAY nothing reads it.
   *
   * An operator who configures required channel membership has to know that
   * nothing enforces it yet; a screen that answers "saved" for a change with no
   * observable effect is the legacy defect the whole registry exists to end.
   */
  it('warns that a setting with no consumer changes no behaviour', async () => {
    stubApi(
      settings([
        setting({ key: 'sales.currency', value: 'IRT', configures: null, consumer: 'PLANNED' }),
        setting({ key: 'ops.notifications.max_attempts', value: 5, consumer: 'ACTIVE' }),
      ]),
    );
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('sales.currency');

    // Exactly one of the two rows carries the warning.
    expect(screen.getAllByText(/چیزی آن را نمی‌خواند/)).toHaveLength(1);
  });

  it('offers no save control without the edit permission', async () => {
    stubApi(settings([setting()]));
    renderPage(<SettingsPage mayEdit={false} denied={false} />);
    await screen.findByText('ops.notifications.max_attempts');
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });

  it('says a save that changed nothing changed nothing', async () => {
    stubApi([
      ...settings([setting({ version: 2, source: 'TENANT' })]),
      {
        url: '/settings/ops.notifications.max_attempts',
        body: { setting: setting({ version: 2, source: 'TENANT' }), changed: false },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByText('ops.notifications.max_attempts');
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    expect(await screen.findByText('ثبت شد، اما مقداری تغییر نکرد.')).toBeInTheDocument();
  });

  it('reports a stored value the registry no longer accepts', async () => {
    stubApi(settings([setting({ storedValueInvalid: true, version: 4, source: 'DEFAULT' })]));
    renderPage(<SettingsPage mayEdit denied={false} />);
    expect(
      await screen.findByText(/مقدار ذخیره‌شده با تعریف این کلید نمی‌خواند/),
    ).toBeInTheDocument();
  });
});

describe('management alerts', () => {
  /**
   * Owner revision 21 — the narrowing is the SERVER's.
   *
   * Filtering fifty fetched rows down to two in the browser would leave the
   * cursor having already walked past the other forty-eight, so paging would
   * drop rows silently.
   */
  it('asks the server for the management scope', async () => {
    const api = stubApi([{ url: '/ops-log', body: { events: [event()] } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');

    expect(api.calls[0]?.url).toContain('scope=MANAGEMENT');
  });

  it('pages with the cursor pair rather than an offset', async () => {
    const api = stubApi([
      {
        url: '/ops-log',
        body: { events: [event({ id: 'e1', lastSeenAt: '2026-09-06T08:00:00.000Z' })] },
      },
    ]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');

    fireEvent.click(screen.getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() => {
      const paged = api.calls.find((call) => call.url.includes('beforeId'));
      expect(paged?.url).toContain('beforeId=e1');
      // Both halves of the cursor: `lastSeenAt` alone is not unique, and a
      // strict comparison on it skips the tail of a group that straddles a page.
      expect(paged?.url).toContain('before=2026-09-06T08%3A00%3A00.000Z');
    });
  });

  it('says plainly that it is not the operational history', async () => {
    stubApi([{ url: '/ops-log', body: { events: [] } }]);
    renderPage(<AlertsPage denied={false} />);
    expect(await screen.findByText('این صفحه تاریخچهٔ عملیاتی نیست')).toBeInTheDocument();
    expect(screen.getByText(/گروه گزارش تلگرام/)).toBeInTheDocument();
  });

  it('defaults to the unresolved conditions, and can be widened', async () => {
    const api = stubApi([{ url: '/ops-log', body: { events: [] } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('هشدار بازی وجود ندارد.');
    expect(api.calls[0]?.url).toContain('open=true');

    fireEvent.click(screen.getByRole('button', { name: 'همه' }));
    await waitFor(() => {
      expect(api.calls.some((call) => !call.url.includes('open='))).toBe(true);
    });
  });
});

describe('system and operations', () => {
  const route = { path: '/system', query: new URLSearchParams() };

  /** Owner revision 25 — the general logs surface does not exist. */
  it('has no logs page, and says its absence is a decision', async () => {
    stubApi([
      { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
      {
        url: '/health/info',
        body: {
          name: 'nexa',
          version: '1.0.0',
          commit: 'abc123',
          buildTime: '2026-09-06T00:00:00.000Z',
          nodeVersion: 'v22.11.0',
          environment: 'production',
        },
      },
    ]);
    renderPage(<SystemPage route={route} permissions={['panels.view', 'admins.view']} />);

    expect(await screen.findByText('صفحهٔ لاگ عمومی وجود ندارد')).toBeInTheDocument();
    // No tab leads to one, and nothing on the page is a log browser.
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['وضعیت', 'پایش', 'مدیران']);
    expect(screen.getByText(/گروه گزارش تلگرام/)).toBeInTheDocument();
  });
});
