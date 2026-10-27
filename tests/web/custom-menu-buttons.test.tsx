import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  CUSTOM_MENU_BUTTON_ERROR_CODES,
  CUSTOM_MENU_STORAGE_MAX_BYTES,
  MAIN_MENU_BUTTON_IDS,
  customMenuRefOf,
  customerRowsOf,
  defaultMainMenuButtonConfig,
  explicitMainMenuV2Schema,
  type CustomMenuButtonView,
  type MainMenuBuilderItem,
} from '@nexa/contracts';
import { BotButtonsPage } from '../../apps/web/src/pages/bot-buttons';
import { ERROR_TEXT } from '../../apps/web/src/error-text';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customVisibleOf, withoutUnusableCustom } from '../../apps/web/src/pages/bot-buttons/model';
import { renderPage, type Api } from './harness';
import {
  BOT_A,
  BOT_B,
  builderApi,
  builderItem,
  builderView,
  draftView,
  mutationAnswer,
  refusal,
} from './bot-buttons-builder-fixture';

/**
 * R10 D2 — the owner's custom buttons in the Web Admin: the builder's pool and preview, the
 * draft it saves, and the panel that defines them. As the builder's own suite, every case
 * drives the real page through the real client against stubbed `fetch`.
 */

const ID_LINK = '01900000-0000-7000-8000-00000000c001';
const ID_TEXT = '01900000-0000-7000-8000-00000000c002';
const ID_OLD = '01900000-0000-7000-8000-00000000c003';
const REF_LINK = customMenuRefOf(ID_LINK);
const REF_TEXT = customMenuRefOf(ID_TEXT);
const REF_OLD = customMenuRefOf(ID_OLD);

function custom(
  id: string,
  label: string,
  overrides: Partial<CustomMenuButtonView> = {},
): CustomMenuButtonView {
  return {
    id,
    ref: customMenuRefOf(id),
    label,
    kind: 'LINK',
    url: 'https://t.me/acme',
    body: null,
    botScope: 'ALL',
    botInstanceIds: [],
    media: null,
    version: 1,
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const page = () => <BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates />;
const chip = (id: string) => document.querySelector(`[data-chip="${id}"]`) as HTMLElement | null;
const chipButton = (id: string) =>
  document.querySelector(`[data-chip-button="${id}"]`) as HTMLButtonElement;
const pool = () => screen.getByTestId('bb-pool');
const pooled = () =>
  [...pool().querySelectorAll('[data-chip]')].map((one) => one.getAttribute('data-chip') ?? '');
const drawnRows = () =>
  [...document.querySelectorAll('.bb-row')].map((row) =>
    [...row.querySelectorAll('[data-chip]')].map((one) => one.getAttribute('data-chip') ?? ''),
  );
const state = () => screen.getByTestId('bb-state').getAttribute('data-status');
const draftPuts = (api: Api) =>
  api.calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/bot-menu/builder/draft'));
const toolbarButton = (name: string) =>
  within(document.querySelector('.bb-toolbar') as HTMLElement).getByRole('button', {
    name,
  }) as HTMLButtonElement;
const modeButton = (name: string) =>
  within(document.querySelector('.bb-canvas-head [role="group"]') as HTMLElement).getByRole(
    'button',
    { name },
  );

async function ready(): Promise<void> {
  await waitFor(() => expect(chip('catalog')).not.toBeNull());
}

/** A v2 draft that places the link button under the first row. */
const placedLayout = () =>
  explicitMainMenuV2Schema.parse({
    v: 2,
    rows: [['catalog', 'services'], [REF_LINK]],
    buttons: MAIN_MENU_BUTTON_IDS.map((id) => defaultMainMenuButtonConfig(id)),
    customButtons: [{ ref: REF_LINK, enabled: true, style: 'primary' }],
  });

const customerKeys = () =>
  [...document.querySelectorAll('[data-testid="bb-customer-preview"] .menu-preview-row')].map(
    (row) => [...row.querySelectorAll('.menu-preview-key')].map((one) => one.textContent ?? ''),
  );

afterEach(() => cleanup());

/** The add button stays off until the list has loaded; clicking it earlier opens nothing. */
async function openCreateDialog(): Promise<void> {
  const add = (await screen.findByRole('button', { name: t('web.cmb_add') })) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.click(add);
}

describe('custom buttons in the builder', () => {
  it('offers the owner’s ACTIVE buttons in the Available pool, marked as his own, and not an archived one', async () => {
    builderApi(
      builderView({
        customButtons: [
          custom(ID_LINK, 'کانال ما'),
          custom(ID_TEXT, 'قوانین', { kind: 'TEXT', url: null, body: 'متن' }),
          custom(ID_OLD, 'قدیمی', { archivedAt: '2026-10-02T00:00:00.000Z' }),
        ],
      }),
    );
    renderPage(page());
    await ready();
    expect(pooled()).toEqual(expect.arrayContaining([REF_LINK, REF_TEXT]));
    expect(pooled()).not.toContain(REF_OLD);
    const linkChip = chip(REF_LINK) as HTMLElement;
    expect(within(linkChip).getByText('کانال ما')).toBeTruthy();
    expect(within(linkChip).getByText(t('web.bb_custom_badge'))).toBeTruthy();
  });

  it('places a custom button through the Inspector and saves a v2 draft with its configuration', async () => {
    const api = builderApi(builderView({ customButtons: [custom(ID_LINK, 'کانال ما')] }), [
      {
        url: '/bot-menu/builder/draft',
        body: mutationAnswer({ version: 1, layout: placedLayout() }),
      },
    ]);
    renderPage(page());
    await ready();
    fireEvent.click(chipButton(REF_LINK));
    fireEvent.change(
      within(screen.getByTestId('bb-inspector')).getByLabelText(t('web.bb_place_into')),
      { target: { value: 'new' } },
    );
    fireEvent.click(
      screen
        .getByTestId('bb-inspector')
        .querySelector('[data-move="web.bb_place_go"]') as HTMLElement,
    );
    expect(drawnRows().at(-1)).toEqual([REF_LINK]);
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await waitFor(() => expect(draftPuts(api)).toHaveLength(1));
    const sent = draftPuts(api)[0]?.body as { layout: Record<string, unknown> };
    expect(sent.layout['v']).toBe(2);
    expect(sent.layout['rows']).toEqual([
      ['catalog', 'services'],
      ['wallet', 'help'],
      ['trial', 'referral'],
      ['apps'],
      ['tickets'],
      [REF_LINK],
    ]);
    expect(sent.layout['customButtons']).toEqual([
      { ref: REF_LINK, enabled: true, style: 'default' },
    ]);
  });

  it('saves v1 for a draft that never placed a custom button, as before', async () => {
    const api = builderApi(builderView({ customButtons: [custom(ID_LINK, 'کانال ما')] }), [
      { url: '/bot-menu/builder/draft', body: mutationAnswer({ version: 1 }) },
    ]);
    renderPage(page());
    await ready();
    fireEvent.click(chipButton('help'));
    fireEvent.click(
      screen
        .getByTestId('bb-inspector')
        .querySelector('[data-move="web.bb_move_prev_row"]') as HTMLElement,
    );
    fireEvent.click(toolbarButton(t('web.bb_save_draft')));
    await waitFor(() => expect(draftPuts(api)).toHaveLength(1));
    expect((draftPuts(api)[0]?.body as { layout: { v: number } }).layout.v).toBe(1);
  });

  it('draws a placed custom button in the editor and drops one archived since the draft was saved', async () => {
    builderApi(
      builderView({
        customButtons: [
          custom(ID_LINK, 'کانال ما'),
          custom(ID_OLD, 'قدیمی', { archivedAt: '2026-10-02T00:00:00.000Z' }),
        ],
        draft: draftView({
          version: 3,
          layout: explicitMainMenuV2Schema.parse({
            v: 2,
            rows: [['catalog', 'services'], [REF_LINK], [REF_OLD]],
            buttons: MAIN_MENU_BUTTON_IDS.map((id) => defaultMainMenuButtonConfig(id)),
            customButtons: [
              { ref: REF_LINK, enabled: true, style: 'default' },
              { ref: REF_OLD, enabled: true, style: 'default' },
            ],
          }),
        }),
      }),
    );
    renderPage(page());
    await ready();
    expect(drawnRows()).toContainEqual([REF_LINK]);
    // The archived one is gone from the rows AND not offered again; the draft reads as changed.
    expect(drawnRows().flat()).not.toContain(REF_OLD);
    expect(pooled()).not.toContain(REF_OLD);
    expect(state()).toBe('unsaved');
  });

  /*
   * Codex #337-2: archiving a PLACED button from the panel below changes the builder's
   * `customButtons` but not its draft, so the draft-moved reseed never ran and the archived
   * reference stayed in the rows — and the server refuses any save or publish of a layout
   * that places it. The page prunes it as soon as the list changes, and keeps every other
   * unsaved edit.
   */
  it('drops a placed button archived from the panel at once, and keeps the other unsaved edits', async () => {
    let archived = false;
    const active = custom(ID_LINK, 'کانال ما');
    const gone = custom(ID_LINK, 'کانال ما', {
      version: 2,
      archivedAt: '2026-10-02T00:00:00.000Z',
    });
    const draft = draftView({ version: 2, layout: placedLayout() });
    const before = builderView({ customButtons: [active], draft });
    const after = builderView({ customButtons: [gone], draft });
    builderApi(before, [
      {
        url: '/bot-menu/builder',
        method: 'GET',
        get body() {
          return archived ? after : before;
        },
      },
      {
        url: '/bot-menu/custom-buttons',
        method: 'GET',
        get body() {
          return {
            featureEnabled: false,
            buttons: [archived ? gone : active],
            storage: { usedBytes: 0, maxBytes: CUSTOM_MENU_STORAGE_MAX_BYTES },
          };
        },
      },
      {
        url: `/bot-menu/custom-buttons/${ID_LINK}/archive`,
        method: 'POST',
        get body() {
          archived = true;
          return { changed: true, button: gone };
        },
      },
    ]);
    renderPage(page());
    await ready();
    expect(drawnRows()).toContainEqual([REF_LINK]);
    // An unrelated unsaved edit, made before the archive.
    fireEvent.click(chipButton('services'));
    fireEvent.click(
      screen
        .getByTestId('bb-inspector')
        .querySelector('[data-move="web.bb_move_own_row"]') as HTMLElement,
    );
    expect(drawnRows()).toContainEqual(['services']);
    expect(state()).toBe('unsaved');

    const item = await screen.findByTestId(`cmb-item-${ID_LINK}`);
    fireEvent.click(within(item).getByRole('button', { name: t('web.cmb_archive') }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: t('web.cmb_archive') }),
    );
    await waitFor(() => expect(drawnRows().flat()).not.toContain(REF_LINK));
    expect(pooled()).not.toContain(REF_LINK);
    expect(drawnRows()).toContainEqual(['services']);
    expect(state()).toBe('unsaved');
  });

  it('a custom button’s Inspector has no icon and no template label, and says it is the owner’s own', async () => {
    builderApi(
      builderView({
        customMenuEnabled: true,
        customButtons: [custom(ID_LINK, 'کانال ما')],
        draft: draftView({ version: 2, layout: placedLayout() }),
      }),
    );
    renderPage(page());
    await ready();
    fireEvent.click(chipButton(REF_LINK));
    const inspector = within(screen.getByTestId('bb-inspector'));
    expect(inspector.getByText(t('web.bb_custom_inspector_note'))).toBeTruthy();
    expect(screen.queryByTestId('bb-icon')).toBeNull();
    expect(screen.queryByTestId('bb-label')).toBeNull();
  });
});

describe('the customer preview equals the contract’s rendering rule', () => {
  const items: MainMenuBuilderItem[] = MAIN_MENU_BUTTON_IDS.map((id) => builderItem(id));
  const view = (overrides: Parameters<typeof builderView>[0] = {}) =>
    builderView({
      customMenuEnabled: true,
      customButtons: [custom(ID_LINK, 'کانال ما')],
      draft: draftView({ version: 2, layout: placedLayout() }),
      ...overrides,
    });

  it('draws the button while the feature is on and the phone’s bot shows it', async () => {
    builderApi(view());
    renderPage(page());
    await ready();
    fireEvent.click(modeButton(t('web.bb_mode_customer')));
    expect(customerKeys()).toContainEqual(['کانال ما']);
    // The same rows the contract's own function gives, label for label.
    const expected = customerRowsOf(
      placedLayout(),
      Object.fromEntries(items.map((item) => [item.id, item.gateOpen])),
      customVisibleOf([custom(ID_LINK, 'کانال ما')], true, BOT_A),
    ).map((row) => row.length);
    expect(customerKeys().map((row) => row.length)).toEqual(expected);
  });

  it('draws nothing custom while the feature is off', async () => {
    builderApi(view({ customMenuEnabled: false }));
    renderPage(page());
    await ready();
    fireEvent.click(modeButton(t('web.bb_mode_customer')));
    expect(customerKeys().flat()).not.toContain('کانال ما');
    expect(screen.getByTestId('cmb-feature-off')).toBeTruthy();
  });

  it('draws nothing custom for a button the phone’s bot does not show', async () => {
    builderApi(
      view({
        customButtons: [
          custom(ID_LINK, 'کانال ما', { botScope: 'SELECTED', botInstanceIds: [BOT_B] }),
        ],
      }),
    );
    renderPage(page());
    await ready();
    fireEvent.click(modeButton(t('web.bb_mode_customer')));
    expect(customerKeys().flat()).not.toContain('کانال ما');
  });

  it('shares its visibility rule and its pruning with the model, not a copy', () => {
    expect(customVisibleOf([custom(ID_LINK, 'x')], true, BOT_A)).toEqual({ [REF_LINK]: true });
    expect(customVisibleOf([custom(ID_LINK, 'x')], false, BOT_A)).toEqual({ [REF_LINK]: false });
    const pruned = withoutUnusableCustom(placedLayout(), []);
    expect(JSON.stringify(pruned.rows)).not.toContain('custom:');
  });
});

describe('the panel that defines the buttons', () => {
  it('lists them with their kind and bots, and the storage used', async () => {
    builderApi(
      builderView({
        customButtons: [
          custom(ID_LINK, 'کانال ما'),
          custom(ID_TEXT, 'قوانین', {
            kind: 'TEXT',
            url: null,
            body: 'متن',
            botScope: 'SELECTED',
            botInstanceIds: [BOT_A],
          }),
        ],
      }),
    );
    renderPage(page());
    const list = await screen.findByTestId('cmb-list');
    expect(within(list).getByText('کانال ما')).toBeTruthy();
    expect(within(list).getByText(t('web.cmb_kind_link'))).toBeTruthy();
    expect(within(list).getByText(/acme_store_bot/u)).toBeTruthy();
    expect(screen.getByTestId('cmb-storage').textContent).toContain('0');
    expect(CUSTOM_MENU_STORAGE_MAX_BYTES).toBeGreaterThan(0);
  });

  it('creates a link button, sending the typed address under a fresh key', async () => {
    const created = custom(ID_LINK, 'کانال ما');
    const api = builderApi(builderView(), [
      {
        url: '/bot-menu/custom-buttons',
        method: 'POST',
        body: { changed: true, button: created },
      },
    ]);
    renderPage(page());
    await openCreateDialog();
    fireEvent.change(screen.getByLabelText(t('web.cmb_label_label')), {
      target: { value: 'کانال ما' },
    });
    fireEvent.change(screen.getByLabelText(t('web.cmb_url_label')), {
      target: { value: 'https://t.me/acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.cmb_save') }));
    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) => call.method === 'POST' && call.url.endsWith('/bot-menu/custom-buttons'),
        ),
      ).toHaveLength(1),
    );
    const body = api.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/bot-menu/custom-buttons'),
    )?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      label: 'کانال ما',
      kind: 'LINK',
      url: 'https://t.me/acme',
      botScope: 'ALL',
      botInstanceIds: [],
      file: null,
    });
    expect(String(body['idempotencyKey']).length).toBeGreaterThanOrEqual(8);
  });

  /*
   * Codex #337-1: an edit that changes the details AND the file is two writes. When the
   * details commit and the file is refused (the storage quota, say), the modal must keep the
   * saved details as its basis — otherwise the retry re-sends them with the version they
   * already replaced and is refused as a conflict on every press.
   */
  it('resumes at the file when only the file was refused, against the version the details saved', async () => {
    const original = custom(ID_TEXT, 'راهنما', {
      kind: 'DOCUMENT',
      url: null,
      body: null,
      media: { fileName: 'old.txt', mimeType: 'text/plain', byteLength: 3 },
    });
    const renamed = { ...original, label: 'راهنمای نو', version: 2 };
    let mediaTries = 0;
    const api = builderApi(builderView({ customButtons: [original] }), [
      {
        url: `/bot-menu/custom-buttons/${ID_TEXT}`,
        method: 'PUT',
        body: { changed: true, button: renamed },
      },
      {
        url: `/bot-menu/custom-buttons/${ID_TEXT}/media`,
        method: 'PUT',
        // `body` is read before `status` for each answer.
        get body() {
          mediaTries += 1;
          return mediaTries === 1
            ? refusal(CUSTOM_MENU_BUTTON_ERROR_CODES.STORAGE_FULL, 'validation')
            : {
                changed: true,
                button: {
                  ...renamed,
                  version: 3,
                  media: { fileName: 'new.txt', mimeType: 'text/plain', byteLength: 5 },
                },
              };
        },
        get status() {
          return mediaTries === 1 ? 400 : 200;
        },
      },
    ]);
    const detailPuts = () =>
      api.calls.filter(
        (call) => call.method === 'PUT' && call.url.endsWith(`/bot-menu/custom-buttons/${ID_TEXT}`),
      );
    const mediaPuts = () =>
      api.calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/media'));
    renderPage(page());
    const item = await screen.findByTestId(`cmb-item-${ID_TEXT}`);
    fireEvent.click(within(item).getByRole('button', { name: t('web.cmb_edit') }));
    fireEvent.change(screen.getByLabelText(t('web.cmb_label_label')), {
      target: { value: 'راهنمای نو' },
    });
    fireEvent.change(screen.getByLabelText(t('web.cmb_file_label')), {
      target: { files: [new File(['hello'], 'new.txt', { type: 'text/plain' })] },
    });
    const save = screen.getByRole('button', { name: t('web.cmb_save') }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(mediaPuts()).toHaveLength(1));
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(detailPuts()).toHaveLength(1);
    expect((detailPuts()[0]?.body as { expectedVersion: number }).expectedVersion).toBe(1);
    expect((mediaPuts()[0]?.body as { expectedVersion: number }).expectedVersion).toBe(2);

    fireEvent.click(save);
    await waitFor(() => expect(mediaPuts()).toHaveLength(2));
    // The details are not sent again: they are already saved, at version 2.
    expect(detailPuts()).toHaveLength(1);
    expect((mediaPuts()[1]?.body as { expectedVersion: number }).expectedVersion).toBe(2);
  });

  it('blocks a save that is certain to be refused, and shows the server’s refusal in Persian', async () => {
    builderApi(builderView(), [
      {
        url: '/bot-menu/custom-buttons',
        method: 'POST',
        status: 400,
        body: refusal(CUSTOM_MENU_BUTTON_ERROR_CODES.URL_INVALID, 'validation'),
      },
    ]);
    renderPage(page());
    await openCreateDialog();
    const save = screen.getByRole('button', { name: t('web.cmb_save') }) as HTMLButtonElement;
    // Nothing typed: no label, no link.
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t('web.cmb_label_label')), { target: { value: '/x' } });
    expect(screen.getByText(t('web.cmb_label_slash'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('web.cmb_label_label')), {
      target: { value: 'لینک' },
    });
    fireEvent.change(screen.getByLabelText(t('web.cmb_url_label')), {
      target: { value: 'http://example.com' },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText(t('web.err_custom_menu_button_url_invalid'))).toBeTruthy();
  });
});

describe('every new error code has a Persian sentence', () => {
  it('maps each code of the catalogue to a non-empty Persian text', () => {
    for (const code of Object.values(CUSTOM_MENU_BUTTON_ERROR_CODES)) {
      const mapped = (ERROR_TEXT as Record<string, string>)[code];
      expect(mapped, code).toBeDefined();
      const sentence = t(mapped as never);
      expect(sentence, code).toMatch(/[؀-ۿ]/u);
    }
  });
});
