import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  DEFAULT_EXPLICIT_MAIN_MENU,
  MAIN_MENU_BUTTON_STYLES,
  type ExplicitMainMenu,
  type MainMenuButtonId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { BotButtonsPage } from '../../apps/web/src/pages/bot-buttons';
import { t } from '../../apps/web/src/i18n/web.fa';
import { navigate } from '../../apps/web/src/router';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { renderPage, type Api } from './harness';
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
const chipButton = (id: MainMenuButtonId) =>
  document.querySelector(`[data-chip-button="${id}"]`) as HTMLButtonElement;
const grip = (id: MainMenuButtonId) => chip(id)?.querySelector('.bb-grip') as HTMLElement;
const pool = () => screen.getByTestId('bb-pool');
const inspector = () => within(screen.getByTestId('bb-inspector'));
const state = () => screen.getByTestId('bb-state').getAttribute('data-status');
const toolbarButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

/** The rows the editor draws, as ids. */
const drawnRows = (): string[][] =>
  [...document.querySelectorAll('.bb-row')].map((row) =>
    [...row.querySelectorAll('[data-chip]')].map((one) => one.getAttribute('data-chip') ?? ''),
  );
const pooled = (): string[] =>
  [...pool().querySelectorAll('[data-chip]')].map((one) => one.getAttribute('data-chip') ?? '');

async function ready(): Promise<void> {
  await waitFor(() => expect(chip('catalog')).not.toBeNull());
}

function select(id: MainMenuButtonId): void {
  fireEvent.click(chipButton(id));
}

function move(key: string): void {
  const button = screen
    .getByTestId('bb-inspector')
    .querySelector(`[data-move="${key}"]`) as HTMLButtonElement;
  fireEvent.click(button);
}

/** A pointer drag from `id`'s grip onto whatever `target()` resolves to once the drag is on. */
function drag(id: MainMenuButtonId, target: () => Element | null): void {
  const from = grip(id);
  fireEvent.pointerDown(from, { pointerId: 1, clientX: 1, clientY: 1 });
  // The gaps between rows exist only while dragging, so the target is found now.
  const element = target();
  expect(element).not.toBeNull();
  document.elementFromPoint = vi.fn(() => element);
  fireEvent.pointerMove(from, { pointerId: 1, clientX: 2, clientY: 2 });
  fireEvent.pointerUp(from, { pointerId: 1, clientX: 2, clientY: 2 });
}

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
  it('drag and drop and the non-drag controls produce the identical draft', async () => {
    // The drag path: help before catalog, wallet onto a new last row, referral to the pool.
    let api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    drag('help', () => chip('catalog'));
    drag('wallet', () => {
      const gaps = document.querySelectorAll('[data-drop="gap"]');
      return gaps[gaps.length - 1] ?? null;
    });
    drag('referral', () => pool());
    const dragged = (await saveAndRead(api)).layout;
    cleanup();

    // The same three changes through the Inspector, without a single drag.
    api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    select('help');
    move('web.bb_move_prev_row');
    move('web.bb_move_earlier');
    move('web.bb_move_earlier');
    select('wallet');
    fireEvent.change(inspector().getByLabelText(t('web.bb_move_into')), {
      target: { value: 'new' },
    });
    move('web.bb_place_go');
    select('referral');
    move('web.bb_remove');
    const clicked = (await saveAndRead(api)).layout;

    expect(dragged.rows).toEqual([
      ['help', 'catalog', 'services'],
      ['trial'],
      ['apps'],
      ['tickets'],
      ['wallet'],
    ]);
    expect(clicked).toEqual(dragged);
  });

  it('is operable from the keyboard alone, and says what each move did', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    const live = screen.getByTestId('bb-live');

    chipButton('help').focus();
    // Up a row: to the end of the first row.
    fireEvent.keyDown(chipButton('help'), { key: 'ArrowUp', altKey: true });
    expect(drawnRows()[0]).toEqual(['catalog', 'services', 'help']);
    expect(live.textContent).toBe(
      t('web.bb_announce_moved')
        .replace('{label}', LABEL('help'))
        .replace('{row}', '1')
        .replace('{index}', '3'),
    );
    // Focus follows the button to its new row.
    expect(document.activeElement).toBe(chipButton('help'));
    // Earlier in the row: the arrow towards the start of a Persian line.
    fireEvent.keyDown(chipButton('help'), { key: 'ArrowRight', altKey: true });
    expect(drawnRows()[0]).toEqual(['catalog', 'help', 'services']);
    // Delete: back to the pool, and still focused there.
    fireEvent.keyDown(chipButton('help'), { key: 'Delete' });
    expect(pooled()).toContain('help');
    expect(live.textContent).toBe(t('web.bb_announce_pool').replace('{label}', LABEL('help')));
    expect(document.activeElement).toBe(chipButton('help'));
    // Alt+Enter in the pool: onto a new last row.
    fireEvent.keyDown(chipButton('help'), { key: 'Enter', altKey: true });
    expect(drawnRows().at(-1)).toEqual(['help']);

    const body = await saveAndRead(api);
    expect(body.layout.rows.at(-1)).toEqual(['help']);
  });

  it('removes a button to the pool and restores it with its configuration kept', async () => {
    const api = builderApi(builderView(), [saved()]);
    renderPage(page());
    await ready();
    select('catalog');
    fireEvent.click(inspector().getByLabelText(t('web.bb_style_success')));
    move('web.bb_remove');
    expect(pooled()).toContain('catalog');
    expect(drawnRows().flat()).not.toContain('catalog');
    expect(screen.getByTestId('bb-where').textContent).toBe(t('web.bb_in_pool'));

    // The customer preview draws nothing for it.
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_customer') }));
    expect(
      within(screen.getByTestId('bb-customer-preview')).queryByText(LABEL('catalog')),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_edit') }));

    move('web.bb_place_go');
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
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_customer') }));
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
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_customer') }));
    const key = screen
      .getByTestId('bb-customer-preview')
      .querySelector('[data-key="wallet"]') as HTMLElement;
    expect(key.getAttribute('data-look')).toBe('danger');
    const body = await saveAndRead(api);
    expect(body.layout.buttons.find((one) => one.button === 'wallet')?.style).toBe('danger');
  });

  it('chooses an icon slot without touching the appearance slot, and shows per-bot eligibility', async () => {
    const api = liveBuilderApi();
    renderPage(page());
    await ready();
    select('catalog');
    fireEvent.change(inspector().getByLabelText(t('web.bb_icon_title')), {
      target: { value: 'wallet' },
    });
    // The marker is the slot's ordinary emoji in a frame, never the label's text.
    expect(chip('catalog')?.querySelector('.bb-icon-mark')?.textContent).toBe('💰');
    expect(chip('catalog')?.querySelector('.bb-chip-label')?.textContent).toBe(LABEL('catalog'));
    const eligibility = within(screen.getByTestId('bb-eligibility'));
    expect(eligibility.getByText('@acme_store_bot')).toBeTruthy();
    expect(eligibility.getByText(t('web.bb_icon_eligible'))).toBeTruthy();
    expect(eligibility.getByText(t('web.bb_icon_not_eligible'))).toBeTruthy();

    let body = await saveAndRead(api);
    let config = body.layout.buttons.find((one) => one.button === 'catalog');
    expect(config?.iconSlot).toBe('wallet');
    expect(config?.appearanceSlot).toBeNull();

    // The other way round: the screen's slot moves, the icon stays.
    fireEvent.change(inspector().getByLabelText(t('web.bot_buttons_slot')), {
      target: { value: 'payment' },
    });
    body = await saveAndRead(api);
    config = body.layout.buttons.find((one) => one.button === 'catalog');
    expect(config?.appearanceSlot).toBe('payment');
    expect(config?.iconSlot).toBe('wallet');
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
    for (const id of ['wallet', 'help'] as const) {
      select(id);
      fireEvent.change(inspector().getByLabelText(t('web.bb_move_into')), {
        target: { value: '0' },
      });
      move('web.bb_place_go');
    }
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
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_customer') }));
    const preview = within(screen.getByTestId('bb-customer-preview'));
    const shown = preview.queryByText(LABEL('trial')) !== null;
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_edit') }));
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
    select('help');
    move('web.bb_move_own_row');
    expect(state()).toBe('unsaved');
    const first = await saveAndRead(api);
    expect(first.expectedDraftVersion).toBeNull();
    expect(first.legacyBaselineVersion).toBe(7);
    expect(first.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(state()).toBe('differs'));

    // The next save names the version the first one produced, under a NEW key.
    select('help');
    move('web.bb_remove');
    const second = await saveAndRead(api);
    expect(second.expectedDraftVersion).toBe(1);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('never lets a read older than the draft it just saved replace that draft', async () => {
    // The read answers the PRE-save draft (no version) even after the save: a stale answer.
    const withoutHelp: ExplicitMainMenu = {
      ...DEFAULT_EXPLICIT_MAIN_MENU,
      rows: [['catalog', 'services'], ['wallet'], ['trial', 'referral'], ['apps'], ['tickets']],
    };
    const api = builderApi(builderView(), [saved({ version: 1, layout: withoutHelp })]);
    renderPage(page());
    await ready();
    select('help');
    move('web.bb_remove');
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
    select('help');
    move('web.bb_remove');
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
    select('help');
    move('web.bb_remove');
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await screen.findByText('rows: A button may be placed once.');
    expect(state()).toBe('invalid');
  });

  it('refuses locally a layout with no ungated button on, and sends nothing', async () => {
    const api = builderApi(builderView());
    renderPage(page());
    await ready();
    for (const id of ['catalog', 'services', 'wallet', 'help', 'apps', 'tickets'] as const) {
      select(id);
      move('web.bb_remove');
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
    select('help');
    move('web.bb_remove');
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
    select('help');
    move('web.bb_remove');
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
    expect(document.querySelector('.bb-grip, .bb-row-grip')).toBeNull();
    select('help');
    expect(
      (
        inspector().getByRole('switch', {
          name: `${t('web.bb_enabled')}: ${LABEL('help')}`,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect((inspector().getByLabelText(t('web.bb_icon_title')) as HTMLSelectElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(chipButton('help'), { key: 'Delete' });
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
    await waitFor(() =>
      expect(document.querySelector('#bot-buttons-label-wallet details')).not.toBeNull(),
    );
    fireEvent.click(label.getByRole('button', { name: t('web.bb_label_edit') }));
    expect(
      (document.querySelector('#bot-buttons-label-wallet details') as HTMLDetailsElement).open,
    ).toBe(true);
  });
});

/**
 * The eight findings of PR #134's review, each pinned by the case that failed before its fix.
 */
describe('the button builder — review of PR #134', () => {
  const withoutHelp: ExplicitMainMenu = {
    ...DEFAULT_EXPLICIT_MAIN_MENU,
    rows: [['catalog', 'services'], ['wallet'], ['trial', 'referral'], ['apps'], ['tickets']],
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
    select('help');
    move('web.bb_remove');
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await waitFor(() => expect(state()).toBe('saving'));
    // In flight: the controls are off and the keyboard moves nothing.
    select('catalog');
    const remove = screen
      .getByTestId('bb-inspector')
      .querySelector('[data-move="web.bb_remove"]') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.keyDown(chipButton('catalog'), { key: 'Delete' });
    expect(drawnRows().flat()).toContain('catalog');
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
    select('help');
    move('web.bb_remove');
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
    select('help');
    move('web.bb_remove');
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
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_live') }));
    const live = screen.getByTestId('bb-live-preview');
    const first = live.querySelector('[data-key="0-0"]') as HTMLElement;
    expect(first.textContent).toContain(LABEL('catalog'));
    expect(first.getAttribute('data-look')).toBe('primary');
    expect(first.querySelector('.bb-icon-mark')).not.toBeNull();
    expect(live.querySelector('[data-key="0-1"]')?.getAttribute('data-look')).toBe('default');
    cleanup();
    // The legacy keyboard has no styles to show.
    builderApi(builderView());
    renderPage(page());
    await ready();
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_live') }));
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
