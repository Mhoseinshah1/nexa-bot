import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { BotsPage } from '../../apps/web/src/pages/bots';
import { resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * The Bots page (WP13, `docs/wp13-bots-management-audit.md`).
 *
 * What it must get right is the split: `settings.view` reads, `settings.edit` stops,
 * starts and runs the live check, `settings.destructive` replaces the token — each drawn
 * only for the role the server will accept it from. And the two things it must never do:
 * offer to add a bot (owner revision 20), or keep a token in the page once it was sent.
 */

const BOT_ID = '01900000-0000-7000-8000-00000000a001';

const bot = (overrides: Record<string, unknown> = {}) => ({
  id: BOT_ID,
  username: 'acme_store_bot',
  telegramBotId: '7000000001',
  status: 'ACTIVE',
  tenant: {
    id: '01900000-0000-7000-8000-000000000001',
    slug: 'acme',
    displayName: 'Acme',
    kind: 'PRIMARY',
  },
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  webhook: { registeredAt: null, url: null, secret: 'UNKNOWN' },
  commandMenu: 'CURRENT',
  readiness: { state: 'NOT_REGISTERED', causes: ['WEBHOOK_NEVER_REGISTERED'] },
  ...overrides,
});

const installation = { webhookRouteEnabled: true, webhookSecretConfigured: true };

const listRoute = (rows: unknown[] = [bot()]) => ({
  url: '/bots',
  body: { bots: rows, installation },
});

const page = (props: { mayOperate?: boolean; mayReplaceToken?: boolean; denied?: boolean }) =>
  (
    <BotsPage
      denied={props.denied ?? false}
      mayOperate={props.mayOperate ?? false}
      mayReplaceToken={props.mayReplaceToken ?? false}
    />
  ) as ReactElement;

describe('the Bots page', () => {
  it('shows a view-only role the bot, its binding and every readiness cause, and nothing to press', async () => {
    stubApi([listRoute()]);
    const { container } = renderPage(page({}));
    await screen.findByText('@acme_store_bot');

    const text = container.textContent ?? '';
    expect(text).toContain('Acme');
    expect(text).toContain('7000000001');
    // The cause names its remedy.
    expect(text).toContain('botctl telegram register');
    expect(screen.queryByRole('button', { name: 'توقف ربات' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'بررسی زنده با تلگرام' })).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('asks before stopping, and stops only on confirmation', async () => {
    const api = stubApi([
      listRoute(),
      {
        url: `/bots/${BOT_ID}/status`,
        body: {
          bot: bot({ status: 'STOPPED' }),
          installation,
          changed: true,
        },
      },
    ]);
    renderPage(page({ mayOperate: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'توقف ربات' }));

    // The confirmation says what stopping does, and nothing has been sent yet.
    expect(await screen.findByText('ربات متوقف شود؟')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'بله، متوقف شود' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/bots/${BOT_ID}/status`))).toBe(true),
    );
    const sent = api.calls.find((call) => call.url.endsWith(`/bots/${BOT_ID}/status`));
    expect(sent?.body).toMatchObject({ status: 'STOPPED' });
    expect(typeof (sent?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  });

  it('offers the token form only with settings.destructive, sends it once and clears it', async () => {
    const token = `7000000001:${'A'.repeat(35)}`;
    const api = stubApi([
      listRoute(),
      { url: `/bots/${BOT_ID}/token`, body: { bot: bot(), installation, changed: true } },
    ]);
    const { container, rerender } = renderPage(page({ mayOperate: true }));
    await screen.findByText('@acme_store_bot');
    expect(container.querySelector('input[type="password"]')).toBeNull();

    rerender(page({ mayOperate: true, mayReplaceToken: true }));
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'جایگزینی توکن' }));

    await waitFor(() => expect(input.value).toBe(''));
    const sent = api.calls.filter((call) => call.url.endsWith(`/bots/${BOT_ID}/token`));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ token });
    // The token is in the body and nowhere else — not the URL.
    expect(api.calls.every((call) => !call.url.includes(token))).toBe(true);
  });

  it('tells a refused token as its remedy, and still clears the field', async () => {
    stubApi([
      listRoute(),
      {
        url: `/bots/${BOT_ID}/token`,
        status: 400,
        body: {
          error: {
            kind: 'VALIDATION',
            code: 'bot.token_different_bot',
            message: 'different bot',
            correlationId: 'test',
          },
        },
      },
    ]);
    const { container } = renderPage(page({ mayReplaceToken: true }));
    await screen.findByText('@acme_store_bot');
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: `7000000999:${'B'.repeat(35)}` } });
    fireEvent.click(screen.getByRole('button', { name: 'جایگزینی توکن' }));

    expect(await screen.findByText(/متعلق به ربات دیگری است/u)).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('reports what Telegram holds, and says when it is not what was recorded', async () => {
    stubApi([
      listRoute([
        bot({
          webhook: {
            registeredAt: '2026-09-01T10:00:00.000Z',
            url: 'https://bot.example.test/telegram/webhook/a1',
            secret: 'MATCHES',
          },
          readiness: { state: 'REGISTERED', causes: [] },
        }),
      ]),
      {
        url: `/bots/${BOT_ID}/diagnostics`,
        body: {
          diagnostic: {
            botInstanceId: BOT_ID,
            checkedAt: '2026-09-25T10:00:00.000Z',
            identity: {
              outcome: 'IDENTIFIED',
              telegramBotId: '7000000001',
              username: 'acme_store_bot',
              idMatches: true,
              usernameMatches: true,
            },
            webhook: {
              outcome: 'READ',
              url: 'https://elsewhere.example.test/hook',
              urlMatchesRecorded: false,
              pendingUpdateCount: 12,
              lastErrorAt: null,
              lastErrorMessage: null,
              maxConnections: 40,
            },
          },
        },
      },
    ]);
    renderPage(page({ mayOperate: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'بررسی زنده با تلگرام' }));

    const result = await screen.findByTestId('bot-diagnostic');
    expect(within(result).getByText('تلگرام توکن را پذیرفت.')).toBeInTheDocument();
    expect(within(result).getByText('https://elsewhere.example.test/hook')).toBeInTheDocument();
    expect(within(result).getByText('با نشانی ثبت‌شده در این نصب یکی نیست')).toBeInTheDocument();
    expect(result.textContent).toContain('12');
  });

  it('draws start, not stop and not the live check, for a stopped bot', async () => {
    stubApi([
      listRoute([
        bot({
          status: 'STOPPED',
          readiness: { state: 'HELD', causes: ['BOT_NOT_ACTIVE', 'WEBHOOK_NEVER_REGISTERED'] },
        }),
      ]),
    ]);
    renderPage(page({ mayOperate: true }));
    expect(await screen.findByRole('button', { name: 'راه‌اندازی ربات' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'توقف ربات' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'بررسی زنده با تلگرام' })).toBeNull();
  });

  it('fetches nothing for a role without settings.view', () => {
    const api = stubApi([listRoute()]);
    renderPage(page({ denied: true }));
    expect(api.calls).toHaveLength(0);
  });

  /** Owner revision 20 — no "primary bot" to add, and the reseller sales bot is not built. */
  it('records the add-flow decision at /bots, and offers no way to add a bot', async () => {
    stubApi([listRoute()]);
    const resolved = resolve({ path: '/bots', query: new URLSearchParams() }, [
      'settings.view',
      'settings.edit',
      'settings.destructive',
    ]);
    const { container } = renderPage(resolved.element as ReactElement);
    await screen.findByText('@acme_store_bot');
    const text = container.textContent ?? '';
    expect(text).toContain('ربات فروش نماینده');
    expect(text).toContain('ربات اصلی');
    expect(text).toContain('وجود نخواهد داشت');
    // Not the planned placeholder any more, and no add control anywhere.
    expect(text).not.toContain('چرا هنوز فعال نیست');
    for (const button of container.querySelectorAll('button')) {
      expect(button.textContent ?? '').not.toContain('افزودن');
    }
  });
});

/**
 * The route's wiring, not the page's.
 *
 * Every case above hands `BotsPage` its booleans directly, so none of them could see
 * `resolve` pass the wrong permission — or none — into `mayReplaceToken`. The token is
 * the one control on this page behind `settings.destructive`, so these go through the
 * real `resolve` with the permission sets a role actually holds, and each asserts the
 * page rendered (the bot, and the operate controls it was given) before asserting what
 * is absent, so an empty page cannot pass for a refused control.
 */
describe('the /bots route wires the token replacement to settings.destructive', () => {
  const open = (permissions: readonly string[]) => {
    stubApi([listRoute()]);
    const resolved = resolve({ path: '/bots', query: new URLSearchParams() }, permissions);
    return renderPage(resolved.element as ReactElement);
  };

  it('offers no token replacement to a role that may operate the bot but not replace its token', async () => {
    const { container } = open(['settings.view', 'settings.edit']);
    await screen.findByText('@acme_store_bot');
    expect(screen.getByRole('button', { name: 'توقف ربات' })).toBeInTheDocument();

    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'جایگزینی توکن' })).toBeNull();
  });

  it('offers token replacement to a role holding settings.destructive, even without settings.edit', async () => {
    const { container } = open(['settings.view', 'settings.destructive']);
    await screen.findByText('@acme_store_bot');

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'جایگزینی توکن' })).toBeInTheDocument();
    // And the permission it holds grants nothing it does not name.
    expect(screen.queryByRole('button', { name: 'توقف ربات' })).toBeNull();
  });
});
