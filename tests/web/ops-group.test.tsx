import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { OPS_GROUP_MANAGED_SETTING_KEYS } from '@nexa/contracts';
import { OpsGroupPage, opsGroupPollsFast } from '../../apps/web/src/pages/ops-group';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { resolve } from '../../apps/web/src/app';
import { renderPage, setting, stubApi } from './harness';

/**
 * «گروه گزارش‌های مدیریتی» (WP-A4). What the page must get right: connection status in
 * the operator's words, each permission problem as its remedy, the actions only for
 * `settings.edit`, a connection that never asks for a chat id — and the settings page no
 * longer showing the keys this panel supersedes.
 */

const BOT_ID = '01900000-0000-7000-8000-00000000a001';

const view = (overrides: Record<string, unknown> = {}) => ({
  connection: 'CONNECTED',
  group: {
    title: 'Nexa Ops',
    bot: { id: BOT_ID, username: 'acme_store_bot' },
    connectedAt: '2026-09-01T10:00:00.000Z',
    disconnectedAt: null,
  },
  health: 'HEALTHY',
  problems: [],
  checkedAt: '2026-09-01T10:01:00.000Z',
  lastDeliveredAt: '2026-09-01T10:02:00.000Z',
  topics: [
    { category: 'SYSTEM', state: 'READY', lastDeliveredAt: null, recreatedCount: 0 },
    { category: 'PAYMENTS', state: 'READY', lastDeliveredAt: null, recreatedCount: 0 },
  ],
  queue: { pending: 0, preserved: 0 },
  laneEnabled: true,
  pendingCodeExpiresAt: null,
  bots: [{ id: BOT_ID, username: 'acme_store_bot' }],
  manual: { configured: false, inUse: false },
  ...overrides,
});

const statusRoute = (body = view()) => ({ url: '/ops-group', body: { opsGroup: body } });

const page = (props: { mayManage?: boolean; denied?: boolean }) =>
  (
    <OpsGroupPage denied={props.denied ?? false} mayManage={props.mayManage ?? false} />
  ) as ReactElement;

describe('the operations log group page', () => {
  it('says connected, names the group and bot, and shows each topic — with nothing to press for a viewer', async () => {
    stubApi([statusRoute()]);
    const { container } = renderPage(page({}));
    await screen.findByText('Nexa Ops');
    const text = container.textContent ?? '';
    expect(text).toContain('متصل');
    expect(text).toContain('@acme_store_bot');
    expect(text).toContain('⚙️ سیستم و خطاها');
    expect(text).toContain('💳 پرداخت‌ها');
    expect(screen.queryByRole('button', { name: 'اتصال گروه تلگرام' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'قطع اتصال' })).toBeNull();
    // No raw ids for the operator to understand.
    expect(text).not.toContain('message_thread_id');
  });

  it('tells each permission problem as its remedy', async () => {
    stubApi([
      statusRoute(view({ health: 'PROBLEM', problems: ['CANNOT_MANAGE_TOPICS', 'NOT_FORUM'] })),
    ]);
    renderPage(page({ mayManage: true }));
    const problems = await screen.findByTestId('ops-group-problems');
    expect(problems.textContent).toContain('مدیریت تاپیک‌ها');
    expect(problems.textContent).toContain('Topics');
  });

  it('shows the five actions to a manager, and asks before disconnecting', async () => {
    const api = stubApi([
      statusRoute(),
      { url: '/ops-group/disconnect', body: { opsGroup: view({ connection: 'DISCONNECTED' }) } },
    ]);
    renderPage(page({ mayManage: true }));
    for (const name of [
      'اتصال گروه تلگرام',
      'بررسی دسترسی‌ها',
      'ارسال پیام آزمایشی',
      'اتصال مجدد',
      'قطع اتصال',
    ]) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'قطع اتصال' }));
    expect(await screen.findByText('اتصال گروه قطع شود؟')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const confirm = screen.getAllByRole('button', { name: 'قطع اتصال' }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/ops-group/disconnect'))).toBe(true),
    );
  });

  it('connects with one action: a code, a deep link and a command, never a chat id field', async () => {
    const api = stubApi([
      statusRoute(view({ connection: 'NOT_CONFIGURED', group: null, health: 'UNVERIFIED' })),
      {
        url: '/ops-group/connect-code',
        body: {
          code: 'ABCDEFGHJKMN',
          command: '/connect_ops@acme_store_bot ABCDEFGHJKMN',
          deepLink: 'https://t.me/acme_store_bot?startgroup=ops-ABCDEFGHJKMN&admin=manage_topics',
          expiresAt: '2026-09-01T10:10:00.000Z',
          botUsername: 'acme_store_bot',
        },
      },
    ]);
    const { container } = renderPage(page({ mayManage: true }));
    expect((await screen.findAllByText('قطع')).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole('button', { name: 'اتصال گروه تلگرام' }));
    const code = await screen.findByTestId('ops-group-code');
    expect(code.querySelector('a')?.getAttribute('href')).toContain('startgroup=ops-ABCDEFGHJKMN');
    expect(code.textContent).toContain('/connect_ops@acme_store_bot ABCDEFGHJKMN');
    const sent = api.calls.find((call) => call.url.endsWith('/ops-group/connect-code'));
    expect(sent?.body).toMatchObject({ botInstanceId: BOT_ID });
    // The normal flow has no field for a chat id; the manual one is closed under «پیشرفته».
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
  });

  it('offers the retry of preserved reports, and sends it', async () => {
    const api = stubApi([
      statusRoute(view({ queue: { pending: 0, preserved: 3 } })),
      {
        url: '/ops-group/requeue',
        body: { opsGroup: view({ queue: { pending: 3, preserved: 0 } }), requeued: 3 },
      },
    ]);
    renderPage(page({ mayManage: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'ارسال مجدد گزارش‌های ارسال‌نشده' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/ops-group/requeue'))).toBe(true),
    );
  });

  it('warns when the reports are switched off', async () => {
    stubApi([statusRoute(view({ laneEnabled: false }))]);
    renderPage(page({}));
    expect(await screen.findByText(/ارسال گزارش‌ها خاموش است/)).toBeInTheDocument();
  });

  it('is reachable from the navigation for settings.view', () => {
    const resolved = resolve({ path: '/ops-group', query: new URLSearchParams() }, [
      'settings.view',
    ]);
    expect(resolved.title).toBe('گروه گزارش‌های مدیریتی');
  });
});

describe('Codex review #2 of PR #99', () => {
  it('keeps the key when a test press finds the first still running, and asks for its answer', async () => {
    const api = stubApi([
      statusRoute(),
      {
        url: '/ops-group/test',
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'platform.idempotency_in_flight',
            message: 'still running',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(page({ mayManage: true }));
    const button = await screen.findByRole('button', { name: 'ارسال پیام آزمایشی' });
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.calls.filter((call) => call.url.endsWith('/ops-group/test'))).toHaveLength(1),
    );
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.calls.filter((call) => call.url.endsWith('/ops-group/test'))).toHaveLength(2),
    );
    const keys = api.calls
      .filter((call) => call.url.endsWith('/ops-group/test'))
      .map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it('polls fast only for a pending code or a connected group not yet checked', () => {
    const none = view({ connection: 'NOT_CONFIGURED', group: null, health: 'UNVERIFIED' });
    expect(opsGroupPollsFast(none as never)).toBe(false);
    expect(
      opsGroupPollsFast({ ...none, pendingCodeExpiresAt: '2026-09-01T10:10:00.000Z' } as never),
    ).toBe(true);
    expect(opsGroupPollsFast(view({ health: 'UNVERIFIED' }) as never)).toBe(true);
    expect(
      opsGroupPollsFast(view({ connection: 'DISCONNECTED', health: 'UNVERIFIED' }) as never),
    ).toBe(false);
    expect(opsGroupPollsFast(view() as never)).toBe(false);
  });
});

describe('the settings page, after WP-A4', () => {
  it('no longer shows the chat, topic, severity and attempt keys', async () => {
    stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            ...OPS_GROUP_MANAGED_SETTING_KEYS.map((key) => setting({ key })),
            setting({ key: 'ops.notifications.max_per_minute', value: 20 }),
          ],
        },
      },
    ]);
    const { container } = renderPage((<SettingsPage mayEdit denied={false} />) as ReactElement);
    await screen.findByText('ops.notifications.max_per_minute');
    for (const key of OPS_GROUP_MANAGED_SETTING_KEYS) {
      expect(container.textContent ?? '').not.toContain(key);
    }
  });
});
