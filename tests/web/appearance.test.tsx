import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { APPEARANCE_SLOTS, APPEARANCE_SLOT_FALLBACKS } from '@nexa/contracts';
import { AppearancePage } from '../../apps/web/src/pages/appearance';
import { NAV, resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * «🎨 ظاهر ربات» (Premium UI): every slot with its Persian name, fallback emoji, custom id,
 * switch, preview and reset; the test-message button with a bot chooser when there are
 * several bots; and each bot's actual last answer from Telegram.
 */

const BOT_A = '01900000-0000-7000-8000-00000000a001';
const BOT_B = '01900000-0000-7000-8000-00000000a002';
const ID = '5368324170671202286';

const slot = (
  name: (typeof APPEARANCE_SLOTS)[number],
  overrides: Record<string, unknown> = {},
) => ({
  slot: name,
  fallback: APPEARANCE_SLOT_FALLBACKS[name],
  customEmojiId: null,
  enabled: true,
  version: null,
  updatedAt: null,
  ...overrides,
});

const view = (overrides: Record<string, unknown> = {}) => ({
  slots: APPEARANCE_SLOTS.map((name) => slot(name)),
  bots: [{ id: BOT_A, username: 'acme_store_bot', status: 'ACTIVE', customEmojiTest: null }],
  operatorTelegramBound: true,
  ...overrides,
});

const route = (body = view()) => ({ url: '/appearance', body });

describe('the appearance page', () => {
  it('lists every slot with its Persian name, fallback emoji and marker, and nothing to press for a viewer', async () => {
    stubApi([route()]);
    const { container } = renderPage(<AppearancePage denied={false} mayEdit={false} />);
    await screen.findByText(t('web.appearance_slot_payment'));
    // Ten slots a page; walking the pager shows every one of them, once.
    let text = '';
    let rows = 0;
    for (;;) {
      text += container.textContent ?? '';
      rows += container.querySelectorAll('tbody tr').length;
      const next = screen.queryByRole('button', { name: t('web.page_next') });
      if (next === null || (next as HTMLButtonElement).disabled) break;
      fireEvent.click(next);
    }
    for (const name of APPEARANCE_SLOTS) {
      expect(text).toContain(APPEARANCE_SLOT_FALLBACKS[name]);
      expect(text).toContain(`{icon:${name}}`);
    }
    expect(rows).toBe(APPEARANCE_SLOTS.length);
    expect(screen.queryByRole('button', { name: t('web.save') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.appearance_test_send') })).toBeNull();
    // Nothing decorated until a bot is tested: the page says so, in Persian.
    expect(text).toContain(t('web.appearance_test_never'));
  });

  it('saves one slot with its id, switch and the version it was read at, and offers a reset for a stored one', async () => {
    const api = stubApi([
      route(
        view({
          slots: APPEARANCE_SLOTS.map((name) =>
            slot(name, name === 'wallet' ? { customEmojiId: '1', version: 3 } : {}),
          ),
        }),
      ),
      {
        url: '/appearance/slots/payment',
        body: { slot: slot('payment', { customEmojiId: ID, version: 1 }), changed: true },
      },
      { url: '/appearance/slots/wallet/reset', body: { slot: slot('wallet'), changed: true } },
    ]);
    renderPage(<AppearancePage denied={false} mayEdit />);
    // One compact row per slot; the editor is its sheet.
    fireEvent.click(await screen.findByRole('button', { name: t('web.appearance_slot_payment') }));
    const payment = screen.getByRole('dialog', { name: t('web.appearance_slot_payment') });
    const input = within(payment).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(within(payment).getByRole('alert').textContent).toBe(
      t('web.appearance_custom_id_invalid'),
    );
    expect(within(payment).getByRole('button', { name: t('web.save') })).toBeDisabled();
    fireEvent.change(input, { target: { value: ID } });
    expect(within(payment).getByText(t('web.appearance_preview_custom'))).toBeInTheDocument();
    // Only a stored slot can be reset; the catalogue's own default has nothing to reset.
    expect(within(payment).queryByRole('button', { name: t('web.appearance_reset') })).toBeNull();
    fireEvent.click(within(payment).getByRole('button', { name: t('web.save') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/appearance/slots/payment'))).toBe(true),
    );
    const saved = api.calls.find((call) => call.url.endsWith('/appearance/slots/payment'));
    expect(saved?.body).toMatchObject({ customEmojiId: ID, enabled: true, expectedVersion: null });
    expect(typeof (saved?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
    // A save that went through closes the sheet.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: t('web.appearance_slot_wallet') }));
    const wallet = screen.getByRole('dialog', { name: t('web.appearance_slot_wallet') });
    fireEvent.click(within(wallet).getByRole('button', { name: t('web.appearance_reset') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/appearance/slots/wallet/reset'))).toBe(
        true,
      ),
    );
    // The reset names the version it was read at, so a stale one is a conflict server-side.
    const resetCall = api.calls.find((call) => call.url.endsWith('/appearance/slots/wallet/reset'));
    expect(resetCall?.body).toMatchObject({ expectedVersion: 3 });
  });

  it('saves again under the SAME key after a lost answer and a close and reopen of the sheet', async () => {
    const api = stubApi([
      route(),
      {
        url: '/appearance/slots/payment',
        method: 'POST',
        status: 503,
        body: {
          error: { kind: 'INTERNAL', code: 'internal.unhandled', message: 'x', correlationId: 'c' },
        },
      },
    ]);
    renderPage(<AppearancePage denied={false} mayEdit />);
    const saveOnce = async () => {
      fireEvent.click(
        await screen.findByRole('button', { name: t('web.appearance_slot_payment') }),
      );
      const sheet = screen.getByRole('dialog', { name: t('web.appearance_slot_payment') });
      fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: ID } });
      fireEvent.click(within(sheet).getByRole('button', { name: t('web.save') }));
      return sheet;
    };
    const saves = () => api.calls.filter((call) => call.url.endsWith('/appearance/slots/payment'));
    const sheet = await saveOnce();
    await waitFor(() => expect(saves()).toHaveLength(1));
    await waitFor(() =>
      expect(within(sheet).getByRole('button', { name: t('web.close') })).not.toBeDisabled(),
    );
    fireEvent.click(within(sheet).getByRole('button', { name: t('web.close') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await saveOnce();
    await waitFor(() => expect(saves()).toHaveLength(2));
    const keyOf = (body: unknown) => (body as { idempotencyKey: string }).idempotencyKey;
    expect(keyOf(saves()[1]!.body)).toBe(keyOf(saves()[0]!.body));
  });

  it('keeps a slot’s unsaved edit when its sheet closes, marks the row and guards the page', async () => {
    const api = stubApi([route()]);
    renderPage(<AppearancePage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.appearance_slot_payment') }));
    const sheet = screen.getByRole('dialog', { name: t('web.appearance_slot_payment') });
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: ID } });
    fireEvent.click(within(sheet).getByRole('button', { name: t('web.close') }));
    expect(screen.queryByRole('dialog')).toBeNull();

    const row = document.querySelector('tr[data-slot="payment"]') as HTMLElement;
    expect(within(row).getByText(t('web.ob_unsaved_row'))).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: t('web.appearance_slot_payment') }));
    expect(
      within(screen.getByRole('dialog', { name: t('web.appearance_slot_payment') })).getByRole(
        'textbox',
      ),
    ).toHaveValue(ID);
    // Typing saved nothing.
    expect(api.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('keeps the category colours and the QR background in their own tabs, mounted', async () => {
    stubApi([route()]);
    renderPage(<AppearancePage denied={false} mayEdit />);
    await screen.findByRole('button', { name: t('web.appearance_slot_payment') });
    const tab = (label: string) => screen.getByRole('tab', { name: label });
    // The slots tab carries its count, as the demo's does: «جایگاه‌های آیکون ۲۹».
    const slotsTab = screen.getByRole('tab', {
      name: (name) => name.startsWith(t('web.appearance_slots_title')),
    });
    expect(slotsTab).toHaveAttribute('aria-selected', 'true');
    expect(
      slotsTab.textContent?.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)),
    ).toContain(String(APPEARANCE_SLOTS.length));
    fireEvent.click(tab(t('web.qrt_title')));
    expect(tab(t('web.qrt_title'))).toHaveAttribute('aria-selected', 'true');
    // The slots are hidden, not unmounted: their drafts survive the switch.
    const slots = document.querySelector('tr[data-slot="payment"]') as HTMLElement;
    expect(slots.closest('[hidden]')).not.toBeNull();
    fireEvent.click(tab(t('web.cc_title')));
    expect(tab(t('web.cc_title'))).toHaveAttribute('aria-selected', 'true');
  });

  it('tells the operator what Telegram answered — a refused test is not "sent"', async () => {
    const answered = (outcome: string, errorCode: string | null) => ({
      bot: {
        id: BOT_A,
        username: 'acme_store_bot',
        status: 'ACTIVE',
        customEmojiTest: { testedAt: '2026-09-30T09:00:00.000Z', outcome, errorCode },
      },
      decoratedSlots: 1,
    });
    const configured = view({
      slots: APPEARANCE_SLOTS.map((name) =>
        slot(name, name === 'payment' ? { customEmojiId: ID, version: 1 } : {}),
      ),
    });
    stubApi([
      route(configured),
      { url: '/appearance/test', body: answered('REJECTED', 'appearance.custom_emoji_refused') },
    ]);
    renderPage(<AppearancePage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.appearance_test_send') }));
    const toast = await screen.findByText((text) =>
      text.startsWith(t('web.appearance_test_toast_rejected')),
    );
    expect(toast).toBeInTheDocument();
    expect(
      screen.queryByText((text) => text.startsWith(t('web.appearance_test_toast_sent'))),
    ).toBeNull();
  });

  it('sends the test through the chosen bot when there are several, and shows each bot’s real answer', async () => {
    const api = stubApi([
      route(
        view({
          slots: APPEARANCE_SLOTS.map((name) =>
            slot(name, name === 'payment' ? { customEmojiId: ID, version: 1 } : {}),
          ),
          bots: [
            { id: BOT_A, username: 'acme_store_bot', status: 'ACTIVE', customEmojiTest: null },
            {
              id: BOT_B,
              username: 'acme_second_bot',
              status: 'ACTIVE',
              customEmojiTest: {
                testedAt: '2026-09-30T08:00:00.000Z',
                outcome: 'REJECTED',
                errorCode: 'appearance.custom_emoji_refused',
              },
            },
          ],
        }),
      ),
      {
        url: '/appearance/test',
        body: {
          bot: {
            id: BOT_B,
            username: 'acme_second_bot',
            status: 'ACTIVE',
            customEmojiTest: {
              testedAt: '2026-09-30T09:00:00.000Z',
              outcome: 'SENT',
              errorCode: null,
            },
          },
          decoratedSlots: 1,
        },
      },
    ]);
    renderPage(<AppearancePage denied={false} mayEdit />);
    const bots = await screen.findByTestId('appearance-bots');
    expect(bots.textContent).toContain(t('web.appearance_test_outcome_rejected'));
    expect(bots.textContent).toContain(t('web.appearance_test_error_custom_emoji_refused'));
    fireEvent.change(screen.getByLabelText(t('web.appearance_test_bot')), {
      target: { value: BOT_B },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.appearance_test_send') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/appearance/test'))).toBe(true),
    );
    const sent = api.calls.find((call) => call.url.endsWith('/appearance/test'));
    expect(sent?.body).toMatchObject({ botInstanceId: BOT_B });
  });

  it('withholds the test while nothing is configured or the operator has no Telegram bound, and says why', async () => {
    stubApi([route(view({ operatorTelegramBound: false }))]);
    renderPage(<AppearancePage denied={false} mayEdit />);
    const button = await screen.findByRole('button', { name: t('web.appearance_test_send') });
    expect(button).toBeDisabled();
    expect(screen.getByText(t('web.appearance_test_not_bound'))).toBeInTheDocument();
    expect(screen.getByText(t('web.appearance_test_nothing'))).toBeInTheDocument();
  });

  it('is reachable from the bot group on settings.view, and is a page of its own', () => {
    const entry = NAV.find((one) => one.path === '/appearance');
    expect(entry?.permission).toBe('settings.view');
    expect(entry?.group).toBe('web.navgroup_bot');
    const resolved = resolve({ path: '/appearance', query: new URLSearchParams() }, [
      'settings.view',
    ]);
    expect(resolved.title).toBe(t('web.appearance_title'));
  });
});
