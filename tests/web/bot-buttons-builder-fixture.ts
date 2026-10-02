import {
  BOT_COMMANDS,
  DEFAULT_EXPLICIT_MAIN_MENU,
  MAIN_MENU_BUTTONS,
  botMenuBuilderResponseSchema,
  mainMenuButton,
  normalizeExplicitMainMenu,
  templateDefinition,
  templateViewSchema,
  type BotMenuBuilderResponse,
  type ExplicitMainMenu,
  type MainMenuBuilderItem,
  type MainMenuButtonId,
  type MainMenuDraftView,
  type MainMenuRevisionView,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { vi } from 'vitest';
import { stubApi, type Api, type Route } from './harness';

/**
 * Round T (T3) — the builder's read and write answers, shaped by the contract's own
 * schemas (`botMenuBuilderResponseSchema.parse`), so a fixture that drifts from the
 * contract fails here, not in production.
 */

export const BOT_A = '01900000-0000-7000-8000-00000000a001';
export const BOT_B = '01900000-0000-7000-8000-00000000a002';
export const REVISION_1 = '01900000-0000-7000-8000-0000000be001';
export const REVISION_2 = '01900000-0000-7000-8000-0000000be002';

/** One registry button as the server describes it, its gate shut unless told otherwise. */
export function builderItem(
  id: MainMenuButtonId,
  overrides: Partial<MainMenuBuilderItem> = {},
): MainMenuBuilderItem {
  const button = mainMenuButton(id);
  const gate = button.needsTrialOffer ? 'TRIAL_OFFER' : button.feature !== null ? 'FEATURE' : null;
  return {
    id,
    target: button.command,
    wide: button.wide,
    label: CATALOGUE_FA[button.label],
    defaultLabel: CATALOGUE_FA[button.label],
    labelOverridden: false,
    defaultAppearanceSlot: button.appearanceSlot,
    gate,
    gateOpen: gate === null ? null : false,
    duplicateLabel: false,
    slashLabel: false,
    ...overrides,
  };
}

export function draftView(overrides: Partial<MainMenuDraftView> = {}): MainMenuDraftView {
  return {
    layout: DEFAULT_EXPLICIT_MAIN_MENU,
    version: null,
    updatedAt: null,
    updatedByAdminId: null,
    restoredFrom: null,
    differsFromPublished: true,
    storedValueInvalid: false,
    legacyBaselineVersion: 7,
    legacyChangedSinceDraft: false,
    ...overrides,
  };
}

export function builderView(
  overrides: Partial<BotMenuBuilderResponse> & {
    readonly itemOverrides?: Partial<Record<MainMenuButtonId, Partial<MainMenuBuilderItem>>>;
  } = {},
): BotMenuBuilderResponse {
  const { itemOverrides, ...rest } = overrides;
  return botMenuBuilderResponseSchema.parse({
    source: 'LEGACY',
    superseded: false,
    publishedUnreadable: false,
    settingVersion: 7,
    draft: draftView(),
    published: null,
    items: MAIN_MENU_BUTTONS.map((button) =>
      builderItem(button.id, itemOverrides?.[button.id] ?? {}),
    ),
    live: {
      rows: [
        [CATALOGUE_FA['bot.menu.catalog'], CATALOGUE_FA['bot.menu.services']],
        [CATALOGUE_FA['bot.menu.wallet'], CATALOGUE_FA['bot.menu.help']],
        [CATALOGUE_FA['bot.menu.apps']],
        [CATALOGUE_FA['bot.menu.tickets']],
      ],
    },
    iconEligibility: [
      { botInstanceId: BOT_A, username: 'acme_store_bot', status: 'ACTIVE', eligible: true },
      { botInstanceId: BOT_B, username: 'acme_plain_bot', status: 'ACTIVE', eligible: false },
    ],
    ...rest,
  });
}

/** A write's answer: the heads after it. */
export function mutationAnswer(
  draft: Partial<MainMenuDraftView>,
  changed = true,
): Record<string, unknown> {
  return { changed, head: { draft: draftView(draft), published: null, settingVersion: 7 } };
}

export function revision(
  id: string,
  number: number,
  layout: ExplicitMainMenu | null,
): MainMenuRevisionView {
  return {
    id,
    revision: number,
    layout,
    createdAt: '2026-09-30T10:00:00.000Z',
    createdByAdminId: '01900000-0000-7000-8000-0000000ad001',
    restoredFrom: null,
  };
}

const templateView = (key: TemplateKey, body: string) => {
  const definition = templateDefinition(key);
  return templateViewSchema.parse({
    key,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body,
    defaultBody: body,
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
  });
};

/** Every route the bot-buttons page reads, with the builder answering `view`. */
export function builderApi(
  view: BotMenuBuilderResponse = builderView(),
  extra: readonly Route[] = [],
): Api {
  return stubApi([
    ...extra,
    { url: '/bot-menu/builder', body: view },
    {
      url: '/bot-menu',
      body: {
        layout: { version: 7, storedValueInvalid: false, items: [] },
        keyboard: [],
        commands: {
          hash: 'abcdef0123456789abcdef0123456789',
          entries: BOT_COMMANDS.map((entry) => ({
            command: entry.command,
            description: CATALOGUE_FA[entry.description],
          })),
        },
        bots: [],
      },
    },
    { url: '/appearance', body: { slots: [], bots: [], operatorTelegramBound: false } },
    {
      url: '/templates',
      body: {
        templates: [
          ...MAIN_MENU_BUTTONS.map((button) =>
            templateView(button.label, CATALOGUE_FA[button.label]),
          ),
          ...BOT_COMMANDS.map((entry) =>
            templateView(entry.description, CATALOGUE_FA[entry.description]),
          ),
        ],
      },
    },
  ]);
}

/** The error body the server sends for a refusal. */
export function refusal(code: string, kind = 'conflict'): Record<string, unknown> {
  return { error: { kind, code, message: code, correlationId: 'test' } };
}

/**
 * `builderApi`, with a draft save that BEHAVES like the server's: it answers with the layout
 * it was sent and the next version, and the builder's read answers with that draft from then
 * on. For the cases that save more than once, where a fixed answer would describe a server
 * that forgot the first save.
 */
export function liveBuilderApi(view: BotMenuBuilderResponse = builderView()): Api {
  const api = builderApi(view);
  const recorded = globalThis.fetch;
  let current = view;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const answer = await recorded(input as RequestInfo, init);
    if (method === 'PUT' && url.endsWith('/bot-menu/builder/draft')) {
      const body = JSON.parse(String(init?.body)) as {
        layout: ExplicitMainMenu;
        legacyBaselineVersion: number | null;
      };
      const draft = draftView({
        layout: normalizeExplicitMainMenu(body.layout),
        version: (current.draft.version ?? 0) + 1,
        legacyBaselineVersion:
          current.draft.version === null
            ? body.legacyBaselineVersion
            : current.draft.legacyBaselineVersion,
      });
      current = { ...current, draft };
      return json({
        changed: true,
        head: { draft, published: current.published, settingVersion: current.settingVersion },
      });
    }
    if (method === 'GET' && url.endsWith('/bot-menu/builder')) return json(current);
    return answer;
  });
  return api;
}
