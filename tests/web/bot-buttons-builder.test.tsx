import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  DEFAULT_MAIN_MENU_LAYOUT,
  explicitFromLegacy,
  MAIN_MENU_BUTTON_STYLES,
  type BotMenuBuilderResponse,
  type ExplicitMainMenu,
  type MainMenuButtonId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { BotButtonsPage } from '../../apps/web/src/pages/bot-buttons';
import { HistoryDrawer } from '../../apps/web/src/pages/bot-buttons/history';
import { t } from '../../apps/web/src/i18n/web.fa';
import { navigate } from '../../apps/web/src/router';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { renderPage, stubApi, type Api } from './harness';
import {
  REVISION_1,
  REVISION_2,
  builderApi,
  builderView,
  draftView,
  failBuilderReadsAfterFirst,
  holdRequests,
  liveBuilderApi,
  mutationAnswer,
  refusal,
  revision,
} from './bot-buttons-builder-fixture';

/**
 * The plain starting layout these tests were written against: the registry packed two to a row,
 * every style `default`. The shipped default (`DEFAULT_EXPLICIT_MAIN_MENU`) is Mirza's arrangement
 * since NEXA-OWNER-BATCH-1 PR-1; the drag, style and inspector mechanics are layout-independent.
 */
const DEFAULT_EXPLICIT_MAIN_MENU = explicitFromLegacy(DEFAULT_MAIN_MENU_LAYOUT);

/**
 * Round T (T3) — the button builder on «دکمه‌های ربات».
 *
 * Every case drives the real page through the real client against stubbed `fetch`, and
 * asserts on what the page SENDS (the draft, its versions, its keys) or what it DRAWS from
 * the server's answers. `docs/round-t-button-builder-audit.md` §13 (T3) is the list.
 */

const LABEL = (id: MainMenuButtonId) => CATALOGUE_FA[`bot.menu.${id}` as 'bot.menu.catalog'];

const page = (mayEdit = true, mayViewTemplates = true) => (
  <BotButtonsPage
    mayEdit={mayEdit}
    denied={false}
    mayViewTemplates={mayViewTemplates}
    mayEditTemplates={mayViewTemplates}
  />
);

const chip = (id: MainMenuButtonId) =>
  document.querySelector(`[data-chip="${id}"]`) as HTMLElement | null;
/** The kit's draggable item around a button: what a press, a focus and a key land on. */
const chipButton = (id: MainMenuButtonId) =>
  document.querySelector(`[data-dnd-item="${id}"]`) as HTMLElement;
const pool = () => document.querySelector('[data-dnd-free]') as HTMLElement;
const inspector = () => within(screen.getByTestId('bb-inspector'));
const state = () => screen.getByTestId('bb-state').getAttribute('data-status');
/*
 * Role queries cost one `getComputedStyle` per candidate and per ancestor, and this page draws
 * ~40 buttons: a page-wide `getByRole('button')` measured ~30 ms each and, called ~50 times,
 * was about half of this file's run time (and the first thing to time out when the CPU is
 * shared). The same query, same role, same accessible name, is asked of the one region that
 * owns the control: nothing is weakened, the region just has fewer candidates.
 */
const toolbarButton = (name: string) =>
  within(document.querySelector('.bb-toolbar') as HTMLElement).getByRole('button', {
    name,
  }) as HTMLButtonElement;
const modeButton = (name: string) =>
  within(document.querySelector('.bb-canvas-head [role="group"]') as HTMLElement).getByRole(
    'button',
    { name },
  );

/** The rows the editor draws, as ids. */
const drawnRows = (): string[][] =>
  [...document.querySelectorAll('.dnd-row')].map((row) =>
    [...row.querySelectorAll('[data-chip]')].map((one) => one.getAttribute('data-chip') ?? ''),
  );
const pooled = (): string[] =>
  [...pool().querySelectorAll('[data-chip]')].map((one) => one.getAttribute('data-chip') ?? '');

async function ready(): Promise<void> {
  await waitFor(() => expect(chip('catalog')).not.toBeNull());
}

/** Selecting a button is a press or a focus on it: the editor under the menu opens for it. */
function select(id: MainMenuButtonId): void {
  fireEvent.focus(chipButton(id));
}

/**
 * A pointer drag of `id`'s item onto whatever `target()` resolves to. The pointer travels past
 * the drag threshold first: a press that does not travel is not a drag. jsdom lays nothing
 * out, so every item's rectangle is empty and, in Persian, any point right of its zero-width
 * middle is its START half: a plain `drag` onto an item drops BEFORE it.
 */
function drag(id: MainMenuButtonId, target: () => Element | null, x = 20): void {
  const from = chipButton(id);
  fireEvent.pointerDown(from, { pointerId: 1, clientX: 1, clientY: 1 });
  const element = target();
  expect(element).not.toBeNull();
  document.elementFromPoint = vi.fn(() => element);
  fireEvent.pointerMove(from, { pointerId: 1, clientX: x, clientY: 20 });
  fireEvent.pointerUp(from, { pointerId: 1, clientX: x, clientY: 20 });
}

/** A drag onto the START half of an item (the right half in Persian): before it. */
function dragOntoStart(id: MainMenuButtonId, onto: MainMenuButtonId): void {
  const host = chipButton(onto);
  host.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 30 }) as DOMRect;
  drag(id, () => host, 90);
}

/** Drop on the free-buttons box: the button leaves the menu, its configuration kept. */
const toPool = (id: MainMenuButtonId) => drag(id, pool);
/** Drop on «ردیف تازه»: the button gets a row of its own at the end. */
const toNewRow = (id: MainMenuButtonId) =>
  drag(id, () => document.querySelector('[data-dnd-new-row]'));
/** Drop on a row's empty space: the end of that row. */
const toRowEnd = (id: MainMenuButtonId, row: number) =>
  drag(id, () => document.querySelector(`[data-dnd-row="${String(row)}"]`));

const draftPuts = (api: Api) =>
  api.calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/bot-menu/builder/draft'));
const posts = (api: Api, suffix: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix));

async function saveAndRead(api: Api): Promise<{
  layout: ExplicitMainMenu;
  expectedDraftVersion: number | null;
  legacyBaselineVersion: number | null;
  idempotencyKey: string;
}> {
  const before = draftPuts(api).length;
  fireEvent.click(toolbarButton(t('web.bb_save_draft')));
  await waitFor(() => expect(draftPuts(api).length).toBe(before + 1));
  return draftPuts(api)[before]?.body as never;
}

const saved = (draft: Parameters<typeof mutationAnswer>[0] = { version: 1 }) => ({
  url: '/bot-menu/builder/draft',
  body: mutationAnswer({ ...draft }),
});

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('the button builder — editing the draft', () => {
  it('every drop target works: a button, a new row at the end, the free box', async () => {
    // help before catalog (a button), wallet to «ردیف تازه», referral to the free box.
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    dragOntoStart('help', 'catalog');
    toNewRow('wallet');
    toPool('referral');
    expect(pooled()).toContain('referral');
    const body = (await saveAndRead(api)).layout;
    expect(body.rows).toEqual([
      ['help', 'catalog', 'services'],
      ['trial'],
      ['apps'],
      ['tickets'],
      ['reseller_request'],
      ['wallet'],
    ]);
  });

  it('the row’s empty space and the line between rows are drop targets too', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    toRowEnd('wallet', 0);
    expect(drawnRows()[0]).toEqual(['catalog', 'services', 'wallet']);
    drag('help', () => document.querySelector('[data-dnd-gap="1"]'));
    expect(drawnRows()[1]).toEqual(['help']);
    const body = await saveAndRead(api);
    expect(body.layout.rows[0]).toEqual(['catalog', 'services', 'wallet']);
    expect(body.layout.rows[1]).toEqual(['help']);
  });

  it('has no move, place or remove button anywhere — dragging is the only way', async () => {
    builderApi(builderView());
    renderPage(page());
    await ready();
    select('help');
    expect(document.querySelector('[data-move]')).toBeNull();
    // The only buttons in the menu editor are the draggable items and the mode switch.
    const canvas = document.querySelector('.bb-canvas') as HTMLElement;
    expect(canvas.querySelectorAll('button').length).toBe(3);
  });

  it('is operable from the keyboard alone: focus, Enter grabs, arrows move, Delete frees', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();

    chipButton('help').focus();
    fireEvent.keyDown(chipButton('help'), { key: 'Enter' });
    // Up a row, then along the row.
    fireEvent.keyDown(chipButton('help'), { key: 'ArrowUp' });
    expect(drawnRows()[0]).toContain('help');
    expect(document.activeElement).toBe(chipButton('help'));
    // The arrow towards the start of a Persian line moves it earlier.
    fireEvent.keyDown(chipButton('help'), { key: 'ArrowRight' });
    // Delete: back to the free box, and still focused there.
    fireEvent.keyDown(chipButton('help'), { key: 'Delete' });
    expect(pooled()).toContain('help');
    expect(document.activeElement).toBe(chipButton('help'));
    // An arrow in the free box puts it back into the menu.
    fireEvent.keyDown(chipButton('help'), { key: 'ArrowDown' });
    expect(pooled()).not.toContain('help');
    fireEvent.keyDown(chipButton('help'), { key: 'Enter' });

    const body = await saveAndRead(api);
    expect(body.layout.rows.flat()).toContain('help');
  });

  it('removes a button to the free box and restores it with its configuration kept', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    select('catalog');
    fireEvent.click(inspector().getByLabelText(t('web.bb_style_success')));
    toPool('catalog');
    expect(pooled()).toContain('catalog');
    expect(drawnRows().flat()).not.toContain('catalog');
    expect(screen.getByTestId('bb-where').textContent).toBe(t('web.bb_in_pool'));

    // The customer preview draws nothing for it.
    fireEvent.click(modeButton(t('web.bb_mode_customer')));
    expect(
      within(screen.getByTestId('bb-customer-preview')).queryByText(LABEL('catalog')),
    ).toBeNull();
    fireEvent.click(modeButton(t('web.bb_mode_edit')));

    toNewRow('catalog');
    expect(drawnRows().at(-1)).toEqual(['catalog']);
    const body = await saveAndRead(api);
    expect(body.layout.buttons.find((one) => one.button === 'catalog')?.style).toBe('success');
    expect(body.layout.rows.at(-1)).toEqual(['catalog']);
  });

  it('switching a button off keeps its place — unlike removing it', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    select('services');
    fireEvent.click(
      inspector().getByRole('switch', { name: `${t('web.bb_enabled')}: ${LABEL('services')}` }),
    );
    // Still drawn in the editor, in the same place, marked off.
    expect(drawnRows()[0]).toEqual(['catalog', 'services']);
    expect(within(chip('services') as HTMLElement).getByText(t('web.bb_state_off'))).toBeTruthy();
    // Not drawn for the customer.
    fireEvent.click(modeButton(t('web.bb_mode_customer')));
    const preview = screen.getByTestId('bb-customer-preview');
    expect(within(preview).queryByText(LABEL('services'))).toBeNull();
    expect(within(preview).getByText(LABEL('catalog'))).toBeTruthy();

    const body = await saveAndRead(api);
    expect(body.layout.rows[0]).toEqual(['catalog', 'services']);
    expect(body.layout.buttons.find((one) => one.button === 'services')?.enabled).toBe(false);
  });

  it('offers exactly the four styles and saves the one chosen', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    select('wallet');
    const radios = inspector().getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual([...MAIN_MENU_BUTTON_STYLES]);
    expect(MAIN_MENU_BUTTON_STYLES).toEqual(['default', 'primary', 'success', 'danger']);
    expect(radios.find((radio) => radio.checked)?.value).toBe('default');
    for (const style of MAIN_MENU_BUTTON_STYLES) {
      fireEvent.click(radios.find((radio) => radio.value === style) as HTMLInputElement);
      expect(chip('wallet')?.className).toContain(`bb-style-${style}`);
    }
    fireEvent.click(inspector().getByLabelText(t('web.bb_style_danger')));
    fireEvent.click(modeButton(t('web.bb_mode_customer')));
    const key = screen
      .getByTestId('bb-customer-preview')
      .querySelector('[data-key="wallet"]') as HTMLElement;
    expect(key.getAttribute('data-look')).toBe('danger');
    const body = await saveAndRead(api);
    expect(body.layout.buttons.find((one) => one.button === 'wallet')?.style).toBe('danger');
  });

  it('chooses an icon slot (restored 2026-10-05) without touching the screen slot, and shows per-bot eligibility', async () => {
    const api = liveBuilderApi();
    renderPage(page());
    await ready();
    select('catalog');
    const control = inspector().getByLabelText(t('web.bb_icon_title')) as HTMLSelectElement;
    // Optional: «بدون آیکون» is the default and the first choice.
    expect(control.value).toBe('');
    expect(control.options[0]?.textContent).toBe(t('web.bb_icon_none'));
    fireEvent.change(control, { target: { value: 'wallet' } });
    // The marker is the slot's ordinary emoji in a frame, never the label's text.
    expect(chip('catalog')?.querySelector('.bb-icon-mark')?.textContent).toBe('💰');
    expect(chip('catalog')?.querySelector('.bb-chip-label')?.textContent).toBe(LABEL('catalog'));
    const eligibility = within(screen.getByTestId('bb-eligibility'));
    expect(eligibility.getByText('@acme_store_bot')).toBeTruthy();
    expect(eligibility.getByText(t('web.bb_icon_eligible'))).toBeTruthy();
    expect(eligibility.getByText(t('web.bb_icon_not_eligible'))).toBeTruthy();
    // The customer preview draws the same marker before the same label.
    fireEvent.click(modeButton(t('web.bb_mode_customer')));
    const key = screen
      .getByTestId('bb-customer-preview')
      .querySelector('[data-key="catalog"]') as HTMLElement;
    expect(key.querySelector('.bb-icon-mark')?.getAttribute('data-icon-slot')).toBe('wallet');
    expect(key.textContent).toBe(`💰${LABEL('catalog')}`);
    fireEvent.click(modeButton(t('web.bb_mode_edit')));

    let body = await saveAndRead(api);
    let config = body.layout.buttons.find((one) => one.button === 'catalog');
    expect(config?.iconSlot).toBe('wallet');
    expect(config?.appearanceSlot).toBeNull();

    // Removing it is choosing «بدون آیکون» again: saved as null, the marker gone.
    fireEvent.change(inspector().getByLabelText(t('web.bb_icon_title')), {
      target: { value: '' },
    });
    expect(chip('catalog')?.querySelector('.bb-icon-mark')).toBeNull();
    body = await saveAndRead(api);
    config = body.layout.buttons.find((one) => one.button === 'catalog');
    expect(config?.iconSlot).toBeNull();
  });

  it('keeps a stored screen slot it has no control for, beside the icon', async () => {
    const layout: ExplicitMainMenu = {
      ...DEFAULT_EXPLICIT_MAIN_MENU,
      buttons: DEFAULT_EXPLICIT_MAIN_MENU.buttons.map((one) =>
        one.button === 'catalog' ? { ...one, iconSlot: 'wallet', appearanceSlot: 'payment' } : one,
      ),
    };
    const api = builderApi(builderView({ draft: draftView({ version: 1, layout }) }), [
      saved({ version: 2 }),
    ]);
    renderPage(page());
    await ready();
    select('catalog');
    expect(document.body.textContent).not.toMatch(/آیکون معنایی/);
    expect((inspector().getByLabelText(t('web.bb_icon_title')) as HTMLSelectElement).value).toBe(
      'wallet',
    );
    fireEvent.click(inspector().getByLabelText(t('web.bb_style_success')));
    const body = await saveAndRead(api);
    const config = body.layout.buttons.find((one) => one.button === 'catalog');
    expect(config?.appearanceSlot).toBe('payment');
    expect(config?.iconSlot).toBe('wallet');
    expect(config?.style).toBe('success');
  });

  it('says when no bot can show an icon', async () => {
    builderApi(
      builderView({
        iconEligibility: [
          {
            botInstanceId: '01900000-0000-7000-8000-00000000a003',
            username: 'only_bot',
            status: 'ACTIVE',
            eligible: false,
          },
        ],
      }),
    );
    renderPage(page());
    await ready();
    select('catalog');
    fireEvent.change(inspector().getByLabelText(t('web.bb_icon_title')), {
      target: { value: 'purchase' },
    });
    expect(inspector().getByText(t('web.bb_icon_no_eligible_bot'))).toBeTruthy();
  });

  it('warns about a crowded row without refusing it', async () => {
    builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    for (const id of ['wallet', 'help'] as const) toRowEnd(id, 0);
    expect(drawnRows()[0]).toHaveLength(4);
    expect(
      screen.getByText(t('web.bb_rows_cramped').replace('{rows}', '1'), { exact: false }),
    ).toBeTruthy();
    expect(toolbarButton(t('web.bb_save_draft')).disabled).toBe(false);
  });
});

describe('the button builder — gates are the server’s answer', () => {
  async function renderWithGates(open: boolean | null) {
    builderApi(
      builderView({ itemOverrides: { trial: { gateOpen: open }, referral: { gateOpen: open } } }),
    );
    renderPage(page());
    await ready();
    fireEvent.click(modeButton(t('web.bb_mode_customer')));
    const preview = within(screen.getByTestId('bb-customer-preview'));
    const shown = preview.queryByText(LABEL('trial')) !== null;
    fireEvent.click(modeButton(t('web.bb_mode_edit')));
    const badge = within(chip('trial') as HTMLElement).queryByText(t('web.bb_hidden_now')) !== null;
    select('trial');
    const because = within(screen.getByTestId('bb-gate')).queryByText(
      t('web.bb_hidden_now_because'),
      { exact: false },
    );
    const result = { shown, badge, because: because !== null };
    cleanup();
    return result;
  }

  it('draws a gated button exactly when the server says its gate is open', async () => {
    expect(await renderWithGates(false)).toEqual({ shown: false, badge: true, because: true });
    expect(await renderWithGates(true)).toEqual({ shown: true, badge: false, because: false });
    // Unknown is not open.
    expect(await renderWithGates(null)).toEqual({ shown: false, badge: true, because: true });
  });
});

describe('the button builder — saving', () => {
  it('first save states no draft version and the baseline the page was seeded from, with a key', async () => {
    const api = liveBuilderApi();
    renderPage(page());
    await ready();
    expect(state()).toBe('not_saved');
    toNewRow('help');
    expect(state()).toBe('unsaved');
    const first = await saveAndRead(api);
    expect(first.expectedDraftVersion).toBeNull();
    expect(first.legacyBaselineVersion).toBe(7);
    expect(first.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(state()).toBe('differs'));

    // The next save names the version the first one produced, under a NEW key.
    toPool('help');
    const second = await saveAndRead(api);
    expect(second.expectedDraftVersion).toBe(1);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('never lets a read older than the draft it just saved replace that draft', async () => {
    // The read answers the PRE-save draft (no version) even after the save: a stale answer.
    const withoutHelp: ExplicitMainMenu = {
      ...DEFAULT_EXPLICIT_MAIN_MENU,
      rows: [
        ['catalog', 'services'],
        ['wallet'],
        ['trial', 'referral'],
        ['apps'],
        ['tickets'],
        ['reseller_request'],
      ],
    };
    const api = builderApi(builderView(), [saved({ version: 1, layout: withoutHelp })]);
    renderPage(page());
    await ready();
    toPool('help');
    await saveAndRead(api);
    const reads = () =>
      api.calls.filter((call) => call.method === 'GET' && call.url.endsWith('/bot-menu/builder'))
        .length;
    await waitFor(() => expect(reads()).toBeGreaterThan(1));
    await waitFor(() => expect(state()).toBe('differs'));
    expect(pooled()).toContain('help');
  });

  it('a 409 keeps the edit, says so, never retries, and reloads only when asked', async () => {
    const api = builderApi(builderView(), [
      { url: '/bot-menu/builder/draft', status: 409, body: refusal('control.version_conflict') },
    ]);
    renderPage(page());
    await ready();
    toPool('help');
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await screen.findByTestId('bb-conflict');
    expect(state()).toBe('conflict');
    expect(draftPuts(api)).toHaveLength(1);
    // The operator's edit is still on the page.
    expect(pooled()).toContain('help');

    const reads = () =>
      api.calls.filter((call) => call.method === 'GET' && call.url.endsWith('/bot-menu/builder'))
        .length;
    const before = reads();
    fireEvent.click(screen.getAllByRole('button', { name: t('web.bb_reload') })[0] as HTMLElement);
    // Reloading discards the edit, so it is asked first; cancelling keeps everything.
    const ask = screen.getByRole('alertdialog');
    fireEvent.click(within(ask).getByRole('button', { name: t('web.unsaved_stay') }));
    expect(pooled()).toContain('help');
    fireEvent.click(screen.getAllByRole('button', { name: t('web.bb_reload') })[0] as HTMLElement);
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: t('web.discard') }),
    );
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() => expect(pooled()).not.toContain('help'));
    expect(draftPuts(api)).toHaveLength(1);
  });

  it('shows the server’s issues for a refused layout', async () => {
    builderApi(builderView(), [
      {
        url: '/bot-menu/builder/draft',
        status: 400,
        body: {
          error: {
            kind: 'validation',
            code: 'control.invalid_value',
            message: 'The layout does not match its declaration.',
            details: { issues: [{ path: 'rows', message: 'A button may be placed once.' }] },
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(page());
    await ready();
    toPool('help');
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await screen.findByText('rows: A button may be placed once.');
    expect(state()).toBe('invalid');
  });

  it('refuses locally a layout with no ungated button on, and sends nothing', async () => {
    const api = builderApi(builderView());
    renderPage(page());
    await ready();
    for (const id of ['catalog', 'services', 'wallet', 'help', 'apps', 'tickets'] as const) {
      toPool(id);
    }
    expect(screen.getByText(t('web.bot_buttons_one_required'))).toBeTruthy();
    expect(state()).toBe('invalid');
    expect(toolbarButton(t('web.bb_save_draft')).disabled).toBe(true);
    expect(api.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('guards leaving while the draft is unsaved', async () => {
    builderApi(builderView());
    renderPage(
      <>
        {page()}
        <LeaveGuardHost />
      </>,
    );
    await ready();
    const start = window.location.pathname;
    toPool('help');
    act(() => navigate('/orders'));
    expect(window.location.pathname).toBe(start);
    expect(screen.getByRole('alertdialog', { name: t('web.unsaved_title') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_stay') }));
    expect(pooled()).toContain('help');
  });
});

describe('the button builder — publish, history, reset', () => {
  const savedDraft = () =>
    builderView({
      source: 'EXPLICIT',
      draft: draftView({
        version: 3,
        differsFromPublished: true,
        layout: {
          ...DEFAULT_EXPLICIT_MAIN_MENU,
          rows: [
            ['services', 'catalog'],
            ['wallet', 'help'],
            ['trial', 'referral'],
            ['apps'],
            ['tickets'],
          ],
        },
      }),
      published: {
        layout: DEFAULT_EXPLICIT_MAIN_MENU,
        revision: 2,
        publishedAt: '2026-09-30T10:00:00.000Z',
        publishedByAdminId: null,
      },
    });

  it('publishes only after confirmation, with the diff and both versions it read', async () => {
    const api = builderApi(savedDraft(), [
      {
        url: '/bot-menu/builder/publish',
        body: mutationAnswer({ version: 3, differsFromPublished: false }),
      },
    ]);
    renderPage(page());
    await ready();
    expect(state()).toBe('differs');
    fireEvent.click(toolbarButton(t('web.bb_publish')));
    const dialog = within(screen.getByRole('dialog', { name: t('web.bb_publish_title') }));
    const diff = within(screen.getByTestId('bb-diff'));
    expect(diff.getByText(LABEL('catalog'))).toBeTruthy();
    expect(diff.getByText(LABEL('services'))).toBeTruthy();
    expect(document.querySelector('[data-diff="wallet"]')).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: t('web.bb_cancel') }));
    expect(posts(api, '/publish')).toHaveLength(0);

    fireEvent.click(toolbarButton(t('web.bb_publish')));
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_publish_confirm') }));
    await waitFor(() => expect(posts(api, '/publish')).toHaveLength(1));
    const body = posts(api, '/publish')[0]?.body as Record<string, unknown>;
    expect(body.expectedDraftVersion).toBe(3);
    expect(body.expectedPublishedRevision).toBe(2);
    expect(typeof body.idempotencyKey).toBe('string');
  });

  it('lists an icon-only change in the publish diff (restored 2026-10-05)', async () => {
    builderApi(
      builderView({
        source: 'EXPLICIT',
        draft: draftView({
          version: 3,
          differsFromPublished: true,
          layout: {
            ...DEFAULT_EXPLICIT_MAIN_MENU,
            buttons: DEFAULT_EXPLICIT_MAIN_MENU.buttons.map((one) =>
              one.button === 'wallet' ? { ...one, iconSlot: 'wallet' } : one,
            ),
          },
        }),
        published: {
          layout: DEFAULT_EXPLICIT_MAIN_MENU,
          revision: 2,
          publishedAt: '2026-09-30T10:00:00.000Z',
          publishedByAdminId: null,
        },
      }),
    );
    renderPage(page());
    await ready();
    fireEvent.click(toolbarButton(t('web.bb_publish')));
    const entry = document.querySelector('[data-diff="wallet"]') as HTMLElement | null;
    expect(entry?.textContent).toContain(t('web.bb_change_icon'));
    expect(document.querySelector('[data-diff="catalog"]')).toBeNull();
  });

  it('cannot publish an unsaved edit or an unsaved draft', async () => {
    builderApi(builderView());
    renderPage(page());
    await ready();
    expect(toolbarButton(t('web.bb_publish')).disabled).toBe(true);
    expect(screen.getByTestId('bb-publish-blocker').textContent).toBe(
      t('web.bb_publish_nothing_saved'),
    );
    cleanup();
    builderApi(savedDraft());
    renderPage(page());
    await ready();
    expect(toolbarButton(t('web.bb_publish')).disabled).toBe(false);
    toPool('help');
    expect(toolbarButton(t('web.bb_publish')).disabled).toBe(true);
    expect(screen.getByTestId('bb-publish-blocker').textContent).toBe(
      t('web.bb_publish_save_first'),
    );
  });

  it('restores a revision INTO THE DRAFT after confirmation, and publishes nothing', async () => {
    const old: ExplicitMainMenu = {
      ...DEFAULT_EXPLICIT_MAIN_MENU,
      rows: [['catalog'], ['tickets']],
    };
    const api = builderApi(savedDraft(), [
      {
        url: '/bot-menu/builder/revisions',
        body: {
          revisions: [
            revision(REVISION_2, 2, DEFAULT_EXPLICIT_MAIN_MENU),
            revision(REVISION_1, 1, old),
          ],
          nextBefore: null,
        },
      },
      {
        url: `/bot-menu/builder/revisions/${REVISION_1}/restore`,
        body: mutationAnswer({
          version: 4,
          layout: old,
          restoredFrom: { id: REVISION_1, revision: 1 },
        }),
      },
    ]);
    renderPage(page());
    await ready();
    fireEvent.click(toolbarButton(t('web.bb_history')));
    const history = await screen.findByTestId('bb-history');
    expect(await within(history).findByText(t('web.bb_revision_current'))).toBeTruthy();
    const restoreOne = within(history).getByRole('button', {
      name: `${t('web.bb_restore')}: ${t('web.bb_revision_n').replace('{n}', '1')}`,
    });
    fireEvent.click(restoreOne);
    // Asked first; cancelling sends nothing.
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: t('web.bb_cancel') }),
    );
    expect(api.calls.some((call) => call.url.includes('/restore'))).toBe(false);

    fireEvent.click(toolbarButton(t('web.bb_history')));
    fireEvent.click(
      within(await screen.findByTestId('bb-history')).getByRole('button', {
        name: `${t('web.bb_restore')}: ${t('web.bb_revision_n').replace('{n}', '1')}`,
      }),
    );
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: t('web.bb_restore') }),
    );
    await waitFor(() => expect(posts(api, `/revisions/${REVISION_1}/restore`)).toHaveLength(1));
    expect(posts(api, `/revisions/${REVISION_1}/restore`)[0]?.body).toMatchObject({
      expectedDraftVersion: 3,
    });
    expect(posts(api, '/publish')).toHaveLength(0);
    // The page now edits the restored draft and says it is not live.
    await waitFor(() => expect(drawnRows()).toEqual([['catalog'], ['tickets']]));
    expect(screen.getByText(t('web.bb_restored_from').replace('{n}', '1'))).toBeTruthy();
  });

  it('resets only after confirmation, from the seed chosen', async () => {
    const api = builderApi(savedDraft(), [
      { url: '/bot-menu/builder/reset', body: mutationAnswer({ version: 4 }) },
    ]);
    renderPage(page());
    await ready();
    fireEvent.click(toolbarButton(t('web.bb_reset')));
    let dialog = within(screen.getByRole('dialog', { name: t('web.bb_reset_title') }));
    fireEvent.click(dialog.getByRole('button', { name: t('web.bb_cancel') }));
    expect(posts(api, '/reset')).toHaveLength(0);

    fireEvent.click(toolbarButton(t('web.bb_reset')));
    dialog = within(screen.getByRole('dialog', { name: t('web.bb_reset_title') }));
    fireEvent.click(dialog.getByLabelText(t('web.bb_reset_live')));
    fireEvent.click(dialog.getByRole('button', { name: t('web.bb_reset_confirm') }));
    await waitFor(() => expect(posts(api, '/reset')).toHaveLength(1));
    expect(posts(api, '/reset')[0]?.body).toMatchObject({
      confirm: true,
      seed: 'LIVE',
      expectedDraftVersion: 3,
    });
  });
});

describe('the button builder — banners and permissions', () => {
  it('says the draft never reaches customers, and where the live menu comes from', async () => {
    builderApi(builderView());
    renderPage(page());
    await ready();
    expect(screen.getByText(t('web.bb_draft_note'))).toBeTruthy();
    expect(screen.getByTestId('bb-source').textContent).toBe(t('web.bb_source_legacy'));
  });

  it('blocks publishing a draft the live menu moved under, and offers the reseed from live', async () => {
    const api = builderApi(
      builderView({
        superseded: true,
        draft: draftView({ version: 2, legacyChangedSinceDraft: true }),
      }),
      [{ url: '/bot-menu/builder/reset', body: mutationAnswer({ version: 3 }) }],
    );
    renderPage(page());
    await ready();
    expect(screen.getByText(t('web.bb_superseded'))).toBeTruthy();
    expect(screen.getByText(t('web.bb_legacy_changed'))).toBeTruthy();
    expect(toolbarButton(t('web.bb_publish')).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_reseed_live') }));
    const dialog = within(screen.getByRole('dialog', { name: t('web.bb_reset_title') }));
    expect((dialog.getByLabelText(t('web.bb_reset_live')) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(dialog.getByRole('button', { name: t('web.bb_reset_confirm') }));
    await waitFor(() => expect(posts(api, '/reset')).toHaveLength(1));
    expect(posts(api, '/reset')[0]?.body).toMatchObject({ seed: 'LIVE', confirm: true });
  });

  it('says when the published layout cannot be read, or the saved draft cannot', async () => {
    builderApi(
      builderView({
        publishedUnreadable: true,
        draft: draftView({ version: 2, storedValueInvalid: true }),
      }),
    );
    renderPage(page());
    await ready();
    expect(screen.getByText(t('web.bb_published_unreadable'))).toBeTruthy();
    expect(screen.getByText(t('web.bb_stored_invalid'))).toBeTruthy();
  });

  it('a viewer without settings.edit sees the menu and its history, and no control that writes', async () => {
    builderApi(builderView(), [
      {
        url: '/bot-menu/builder/revisions',
        body: {
          revisions: [revision(REVISION_1, 1, DEFAULT_EXPLICIT_MAIN_MENU)],
          nextBefore: null,
        },
      },
    ]);
    renderPage(page(false));
    await ready();
    expect(screen.getByText(t('web.bb_read_only'))).toBeTruthy();
    for (const name of ['web.bb_save_draft', 'web.bb_publish', 'web.bb_reset'] as const) {
      expect(screen.queryByRole('button', { name: t(name) })).toBeNull();
    }
    // Nothing can be grabbed: no item is in the tab order, and a drop changes nothing.
    expect(document.querySelector('[data-dnd-item][tabindex="0"]')).toBeNull();
    toPool('help');
    select('help');
    expect(
      (
        inspector().getByRole('switch', {
          name: `${t('web.bb_enabled')}: ${LABEL('help')}`,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      [...screen.getByTestId('bb-inspector').querySelectorAll('select')].every(
        (one) => (one as HTMLSelectElement).disabled || one.closest('fieldset')?.disabled,
      ),
    ).toBe(true);
    expect(pooled()).not.toContain('help');
    fireEvent.click(toolbarButton(t('web.bb_history')));
    const history = await screen.findByTestId('bb-history');
    expect(within(history).queryByRole('button', { name: /./ })).toBeNull();
  });

  it('shows the server’s label warnings and sends label edits to the texts card', async () => {
    builderApi(
      builderView({
        itemOverrides: {
          wallet: { duplicateLabel: true, slashLabel: true, labelOverridden: true, label: '/x' },
        },
      }),
    );
    renderPage(page());
    await ready();
    select('wallet');
    const label = within(screen.getByTestId('bb-label'));
    expect(label.getByText(t('web.bot_buttons_label_duplicate'))).toBeTruthy();
    expect(label.getByText(t('web.bb_label_slash'))).toBeTruthy();
    expect(label.getByText(t('web.bb_label_note'))).toBeTruthy();
    await waitFor(() => expect(document.querySelector('#bot-buttons-label-wallet')).not.toBeNull());
    // «ویرایش متن» opens the label's own editor in a side sheet — no jump to another section.
    const before = window.scrollY;
    fireEvent.click(label.getByRole('button', { name: t('web.bb_label_edit') }));
    const sheet = screen.getByRole('dialog', { name: '/x' });
    expect(within(sheet).getByText(t('web.bot_buttons_label_duplicate'))).toBeTruthy();
    expect(within(sheet).getAllByText('bot.menu.wallet').length).toBeGreaterThan(0);
    expect(window.scrollY).toBe(before);
  });
});

/**
 * The eight findings of PR #134's review, each pinned by the case that failed before its fix.
 */
describe('the button builder — review of PR #134', () => {
  const withoutHelp: ExplicitMainMenu = {
    ...DEFAULT_EXPLICIT_MAIN_MENU,
    rows: [
      ['catalog', 'services'],
      ['wallet'],
      ['trial', 'referral'],
      ['apps'],
      ['tickets'],
      ['reseller_request'],
    ],
  };
  const explicitView = (overrides: Parameters<typeof builderView>[0] = {}) =>
    builderView({
      source: 'EXPLICIT',
      draft: draftView({ version: 3, differsFromPublished: true, layout: withoutHelp }),
      published: {
        layout: {
          ...DEFAULT_EXPLICIT_MAIN_MENU,
          buttons: DEFAULT_EXPLICIT_MAIN_MENU.buttons.map((config) =>
            config.button === 'catalog'
              ? { ...config, style: 'primary' as const, iconSlot: 'purchase' as const }
              : config,
          ),
        },
        revision: 2,
        publishedAt: '2026-09-30T10:00:00.000Z',
        publishedByAdminId: null,
      },
      ...overrides,
    });

  it('#1 allows no edit while a write is in flight, so its answer drops nothing', async () => {
    const api = builderApi(builderView(), [saved({ version: 1, layout: withoutHelp })]);
    const held = holdRequests('PUT', '/bot-menu/builder/draft');
    renderPage(page());
    await ready();
    toPool('help');
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await waitFor(() => expect(state()).toBe('saving'));
    // In flight: the controls are off and the keyboard moves nothing.
    toPool('catalog');
    expect(drawnRows().flat()).toContain('catalog');
    expect(document.querySelector('[data-dnd-item][tabindex="0"]')).toBeNull();
    held.release();
    await waitFor(() => expect(state()).toBe('differs'));
    expect(draftPuts(api)).toHaveLength(1);
    expect(pooled()).toEqual(['help']);
  });

  it('#2 keeps a publish’s answer over the snapshot that was on screen before it', async () => {
    const api = builderApi(explicitView(), [
      {
        url: '/bot-menu/builder/publish',
        body: mutationAnswer({ version: 3, differsFromPublished: false, layout: withoutHelp }),
      },
    ]);
    renderPage(page());
    await ready();
    const reads = () =>
      api.calls.filter((call) => call.method === 'GET' && call.url.endsWith('/bot-menu/builder'))
        .length;
    const before = reads();
    fireEvent.click(toolbarButton(t('web.bb_publish')));
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_publish_confirm') }));
    await waitFor(() => expect(posts(api, '/publish')).toHaveLength(1));
    await waitFor(() => expect(state()).toBe('published'));
    // The re-read answers the pre-publish snapshot again (a lagging or unchanged read).
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(state()).toBe('published');
  });

  it('#3 forgets an earlier write’s refusal once a later write succeeds', async () => {
    builderApi(builderView(), [
      {
        url: '/bot-menu/builder/draft',
        status: 400,
        body: {
          error: {
            kind: 'validation',
            code: 'control.invalid_value',
            message: 'The layout does not match its declaration.',
            details: { issues: [{ path: 'rows', message: 'A button may be placed once.' }] },
            correlationId: 'test',
          },
        },
      },
      { url: '/bot-menu/builder/reset', body: mutationAnswer({ version: 1 }) },
    ]);
    renderPage(page());
    await ready();
    toPool('help');
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await screen.findByText('rows: A button may be placed once.');
    fireEvent.click(toolbarButton(t('web.bb_reset')));
    const dialog = within(screen.getByRole('dialog', { name: t('web.bb_reset_title') }));
    fireEvent.click(dialog.getByRole('button', { name: t('web.bb_reset_confirm') }));
    await waitFor(() => expect(state()).toBe('differs'));
    expect(screen.queryByText('rows: A button may be placed once.')).toBeNull();
  });

  it('#4 keeps the edit and the conflict when the re-read after a 409 fails', async () => {
    builderApi(builderView(), [
      { url: '/bot-menu/builder/draft', status: 409, body: refusal('control.version_conflict') },
    ]);
    failBuilderReadsAfterFirst();
    renderPage(page());
    await ready();
    toPool('help');
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await screen.findByTestId('bb-conflict');
    fireEvent.click(screen.getAllByRole('button', { name: t('web.bb_reload') })[0] as HTMLElement);
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: t('web.discard') }),
    );
    await screen.findByText('platform.unavailable');
    expect(pooled()).toContain('help');
    expect(screen.getByTestId('bb-conflict')).toBeTruthy();
    expect(screen.getByTestId('bb-live').textContent).not.toBe(t('web.bb_reloaded'));
  });

  it('#5 draws the live keyboard with the published layout’s styles and icons', async () => {
    builderApi(explicitView());
    renderPage(page());
    await ready();
    fireEvent.click(modeButton(t('web.bb_mode_live')));
    const live = screen.getByTestId('bb-live-preview');
    const first = live.querySelector('[data-key="0-0"]') as HTMLElement;
    expect(first.textContent).toContain(LABEL('catalog'));
    expect(first.getAttribute('data-look')).toBe('primary');
    expect(first.querySelector('.bb-icon-mark')?.getAttribute('data-icon-slot')).toBe('purchase');
    expect(live.querySelector('[data-key="0-1"]')?.getAttribute('data-look')).toBe('default');
    cleanup();
    // The legacy keyboard has no styles to show.
    builderApi(builderView());
    renderPage(page());
    await ready();
    fireEvent.click(modeButton(t('web.bb_mode_live')));
    expect(
      screen
        .getByTestId('bb-live-preview')
        .querySelector('[data-key="0-0"]')
        ?.getAttribute('data-look'),
    ).toBe('default');
  });

  it('#6 never calls a publish over an unreadable layout the first publication', async () => {
    builderApi(
      explicitView({
        publishedUnreadable: true,
        published: {
          layout: null,
          revision: 2,
          publishedAt: '2026-09-30T10:00:00.000Z',
          publishedByAdminId: null,
        },
      }),
    );
    renderPage(page());
    await ready();
    fireEvent.click(toolbarButton(t('web.bb_publish')));
    const dialog = within(screen.getByRole('dialog', { name: t('web.bb_publish_title') }));
    expect(dialog.getByText(t('web.bb_publish_over_unreadable'))).toBeTruthy();
    expect(dialog.queryByText(t('web.bb_publish_first'))).toBeNull();
  });

  it('F-2 never says "no layout change" over a superseded layout: customers’ keyboard changes', async () => {
    // P-5's path: reseeded from live, revision 2 restored into the draft — the draft equals
    // what is published, yet customers see what an older release wrote, and publishing
    // replaces it.
    const view = explicitView({ source: 'LEGACY', superseded: true });
    builderApi(
      builderView({
        ...view,
        draft: draftView({
          version: 4,
          differsFromPublished: false,
          layout: view.published?.layout ?? DEFAULT_EXPLICIT_MAIN_MENU,
        }),
      }),
    );
    renderPage(page());
    await ready();
    expect(toolbarButton(t('web.bb_publish')).disabled).toBe(false);
    fireEvent.click(toolbarButton(t('web.bb_publish')));
    const dialog = within(screen.getByRole('dialog', { name: t('web.bb_publish_title') }));
    expect(dialog.getByText(t('web.bb_publish_over_superseded'))).toBeTruthy();
    expect(dialog.queryByText(t('web.bb_publish_no_layout_change'))).toBeNull();
    expect(dialog.queryByTestId('bb-diff')).toBeNull();
  });

  it('#8 warns, without refusing, when an icon would sit beside a label’s own emoji', async () => {
    builderApi(builderView({ itemOverrides: { services: { label: 'سرویس‌ها' } } }));
    renderPage(page());
    await ready();
    select('catalog');
    fireEvent.change(inspector().getByLabelText(t('web.bb_icon_title')), {
      target: { value: 'purchase' },
    });
    expect(screen.getByTestId('bb-icon-doubled')).toBeTruthy();
    select('services');
    fireEvent.change(inspector().getByLabelText(t('web.bb_icon_title')), {
      target: { value: 'service' },
    });
    expect(screen.queryByTestId('bb-icon-doubled')).toBeNull();
    expect(toolbarButton(t('web.bb_save_draft')).disabled).toBe(false);
  });
});

describe('the button builder — round-T follow-ups (owner, 2026-10-02)', () => {
  const published = (): BotMenuBuilderResponse => {
    const view = builderView({ source: 'EXPLICIT' });
    return builderView({
      source: 'EXPLICIT',
      draft: draftView({ version: 3, differsFromPublished: false }),
      published: {
        layout: view.draft.layout,
        revision: 2,
        publishedAt: '2026-09-30T10:00:00.000Z',
        publishedByAdminId: null,
      },
    });
  };

  it('QA-4 names a revision’s publisher by name, never by an id prefix', async () => {
    builderApi(builderView(), [
      {
        url: '/bot-menu/builder/revisions',
        body: {
          revisions: [
            revision(REVISION_2, 2, DEFAULT_EXPLICIT_MAIN_MENU),
            { ...revision(REVISION_1, 1, DEFAULT_EXPLICIT_MAIN_MENU), createdByAdminName: null },
          ],
          nextBefore: null,
        },
      },
    ]);
    renderPage(page());
    await ready();
    fireEvent.click(toolbarButton(t('web.bb_history')));
    const history = await screen.findByTestId('bb-history');
    const by = await within(history).findAllByTestId('bb-revision-by');
    // Revision 2 names its publisher; revision 1's administrator row is gone: no line at all.
    expect(by).toHaveLength(1);
    expect(by[0]?.textContent).toBe(`${t('web.bb_revision_by')} سارا احمدی`);
    expect(history.textContent).not.toContain('01900000');
  });

  it('QA-6 never reads «published» while a restore is replacing the draft', async () => {
    builderApi(published(), [
      {
        url: '/bot-menu/builder/revisions',
        body: {
          revisions: [revision(REVISION_1, 1, DEFAULT_EXPLICIT_MAIN_MENU)],
          nextBefore: null,
        },
      },
      {
        url: `/bot-menu/builder/revisions/${REVISION_1}/restore`,
        body: mutationAnswer({
          version: 4,
          differsFromPublished: true,
          restoredFrom: { id: REVISION_1, revision: 1 },
        }),
      },
    ]);
    const held = holdRequests('POST', '/restore');
    renderPage(page());
    await ready();
    expect(state()).toBe('published');
    fireEvent.click(toolbarButton(t('web.bb_history')));
    fireEvent.click(
      within(await screen.findByTestId('bb-history')).getByRole('button', {
        name: `${t('web.bb_restore')}: ${t('web.bb_revision_n').replace('{n}', '1')}`,
      }),
    );
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: t('web.bb_restore') }),
    );
    await waitFor(() => expect(state()).toBe('saving'));
    held.release();
    await waitFor(() => expect(state()).toBe('differs'));
  });

  it('QA-6 the same for a reset', async () => {
    builderApi(published(), [
      { url: '/bot-menu/builder/reset', body: mutationAnswer({ version: 5 }) },
    ]);
    const held = holdRequests('POST', '/reset');
    renderPage(page());
    await ready();
    expect(state()).toBe('published');
    fireEvent.click(toolbarButton(t('web.bb_reset')));
    const dialog = within(screen.getByRole('dialog', { name: t('web.bb_reset_title') }));
    fireEvent.click(dialog.getByRole('button', { name: t('web.bb_reset_confirm') }));
    await waitFor(() => expect(state()).toBe('saving'));
    held.release();
    await waitFor(() => expect(state()).not.toBe('saving'));
  });
});

describe('the button builder — drag quality (owner, 2026-10-02)', () => {
  it('a press that does not travel moves nothing, whatever is under it', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    const before = drawnRows();
    const from = chipButton('help');
    fireEvent.pointerDown(from, { pointerId: 1, clientX: 10, clientY: 10 });
    document.elementFromPoint = vi.fn(() => pool());
    // Three pixels: a trembling finger or a click, not a drag.
    fireEvent.pointerMove(from, { pointerId: 1, clientX: 12, clientY: 12 });
    fireEvent.pointerUp(from, { pointerId: 1, clientX: 12, clientY: 12 });
    expect(drawnRows()).toEqual(before);
    expect(state()).not.toBe('unsaved');
    expect(draftPuts(api)).toHaveLength(0);
  });

  it('a drop where the button already is, or a cancelled drag, changes nothing', async () => {
    builderApi(builderView());
    renderPage(page());
    await ready();
    const before = drawnRows();
    // `services` is right after `catalog`: onto catalog's END half is where it already is.
    const catalog = chipButton('catalog');
    catalog.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 30 }) as DOMRect;
    drag('services', () => catalog, 10);
    // Escape abandons a drag that would have moved something.
    fireEvent.pointerDown(chipButton('help'), { pointerId: 3, clientX: 1, clientY: 1 });
    document.elementFromPoint = vi.fn(() => pool());
    fireEvent.pointerMove(chipButton('help'), { pointerId: 3, clientX: 40, clientY: 40 });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerUp(chipButton('help'), { pointerId: 3, clientX: 40, clientY: 40 });
    // A pointer the browser cancels (a scroll gesture, a call) moves nothing either.
    fireEvent.pointerDown(chipButton('help'), { pointerId: 4, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(chipButton('help'), { pointerId: 4, clientX: 40, clientY: 40 });
    fireEvent.pointerCancel(chipButton('help'), { pointerId: 4 });
    fireEvent.pointerUp(chipButton('help'), { pointerId: 4, clientX: 40, clientY: 40 });
    expect(drawnRows()).toEqual(before);
    expect(state()).not.toBe('unsaved');
  });

  it('decides before/after by the half of the button under the pointer, in reading order (RTL)', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    // Persian: the RIGHT half of catalog is its start — help goes before it.
    dragOntoStart('help', 'catalog');
    expect(drawnRows()[0]).toEqual(['help', 'catalog', 'services']);
    // The LEFT half of catalog is its end — wallet goes after it, before services.
    const host = chipButton('catalog');
    host.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 30 }) as DOMRect;
    drag('wallet', () => host, 10);
    expect(drawnRows()[0]).toEqual(['help', 'catalog', 'wallet', 'services']);
    const body = await saveAndRead(api);
    expect(body.layout.rows[0]).toEqual(['help', 'catalog', 'wallet', 'services']);
  });

  it('draws the drop zones from the start: the gaps, «ردیف تازه» and the free box', async () => {
    builderApi(builderView());
    renderPage(page());
    await ready();
    expect(document.querySelectorAll('[data-dnd-gap]').length).toBe(drawnRows().length + 1);
    expect(document.querySelector('[data-dnd-new-row]')).not.toBeNull();
    expect(pool()).not.toBeNull();
    expect(screen.getByText(t('web.bb_pool_hint'))).toBeTruthy();
  });

  it('keeps the keyboard path in a left-to-right page: arrows follow the reading direction', async () => {
    builderApi(builderView());
    const before = document.documentElement.dir;
    document.documentElement.dir = 'ltr';
    try {
      renderPage(page());
      await ready();
      // The default draft's first row is catalog, services.
      fireEvent.keyDown(chipButton('services'), { key: 'Enter' });
      fireEvent.keyDown(chipButton('services'), { key: 'ArrowLeft' });
      expect(drawnRows()[0]).toEqual(['services', 'catalog']);
      fireEvent.keyDown(chipButton('services'), { key: 'ArrowRight' });
      expect(drawnRows()[0]).toEqual(['catalog', 'services']);
    } finally {
      document.documentElement.dir = before;
    }
  });
});

describe('the builder’s editor under the preview', () => {
  it('draws the selected button’s editor in three titled columns: place, look, show and target', async () => {
    builderApi(builderView());
    renderPage(page());
    await ready();
    select('wallet');
    const inspector = screen.getByTestId('bb-inspector');
    const columns = within(inspector).getAllByRole('group', {
      name: new RegExp(
        `^(${t('web.bx_bb_col_place')}|${t('web.bx_bb_col_look')}|${t('web.bx_bb_col_show')})$`,
      ),
    });
    expect(columns.map((one) => one.getAttribute('aria-labelledby') !== null)).toEqual([
      true,
      true,
      true,
    ]);
    const [place, look, show] = columns as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(place).getByTestId('bb-where')).toBeInTheDocument();
    expect(place.querySelector('button')).toBeNull();
    expect(within(look).getByTestId('bb-icon')).toBeInTheDocument();
    expect(within(look).getByText(t('web.bb_style_title'))).toBeInTheDocument();
    expect(within(show).getByTestId('bb-label')).toBeInTheDocument();
    expect(within(show).getByText(t('web.bot_buttons_target'))).toBeInTheDocument();
    // Below the canvas in the document, not beside it.
    const canvas = document.querySelector('.bb-canvas') as HTMLElement;
    expect(
      canvas.compareDocumentPosition(inspector) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

/*
 * PR #285 review, A6: the history drawer pages ten revisions at a time with «قبلی / بعدی» on
 * the server's `before` keyset — no «نسخه‌های قدیمی‌تر» that grows one list without end.
 */
describe('the revision history pager', () => {
  const rid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const span = (from: number, to: number) =>
    Array.from({ length: from - to + 1 }, (_, index) =>
      revision(rid(from - index), from - index, DEFAULT_EXPLICIT_MAIN_MENU),
    );

  it('shows ten a page and walks older and back by cursor, never by offset', async () => {
    const api = stubApi([
      {
        url: '/bot-menu/builder/revisions?limit=10',
        body: { revisions: span(25, 16), nextBefore: 16 },
      },
      {
        url: '/bot-menu/builder/revisions?before=16&limit=10',
        body: { revisions: span(15, 6), nextBefore: 6 },
      },
    ]);
    renderPage(
      <HistoryDrawer
        open
        onClose={() => undefined}
        publishedRevision={25}
        items={new Map()}
        customs={new Map()}
        mayEdit={false}
        onRestore={() => undefined}
      />,
    );
    const history = await screen.findByTestId('bb-history');
    const shown = () =>
      Array.from(screen.getByTestId('bb-history').querySelectorAll('[data-revision]'), (node) =>
        Number(node.getAttribute('data-revision')),
      );
    await waitFor(() => expect(shown()).toEqual(span(25, 16).map((one) => one.revision)));
    expect(history).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'نسخه‌های قدیمی‌تر' })).toBeNull();
    const next = screen.getByRole('button', { name: t('web.page_older') });
    const previous = screen.getByRole('button', { name: t('web.page_newer') });
    expect(previous).toBeDisabled();

    fireEvent.click(next);
    await waitFor(() => expect(shown()).toEqual(span(15, 6).map((one) => one.revision)));
    const reads = api.calls.filter((call) => call.url.includes('/revisions'));
    expect(reads.map((call) => call.url)).toEqual([
      expect.stringContaining('/bot-menu/builder/revisions?limit=10'),
      expect.stringContaining('/bot-menu/builder/revisions?before=16&limit=10'),
    ]);
    expect(reads.some((call) => /offset|page=/.test(call.url))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: t('web.page_newer') }));
    await waitFor(() => expect(shown()).toEqual(span(25, 16).map((one) => one.revision)));
  });
});
