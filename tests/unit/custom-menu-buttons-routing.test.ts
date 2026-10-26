import { describe, expect, it } from 'vitest';
import { CATALOGUE_FA } from '@nexa/i18n';
import { customMenuRouteValue } from '@nexa/contracts';
import { BotRuntime } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { intentOf } from '../../apps/api/src/surfaces/telegram/runtime/intent-of';
import { BOT_INTENTS } from '../../apps/api/src/surfaces/telegram/runtime/intents';

/**
 * R10 D2 — how a tap on an owner-defined main-menu button is recognised. A reply keyboard
 * sends the label as text; the label map's VALUE (`mb:<id>`) is what routes, never the typed
 * text, and a registry label always wins a collision.
 */

const ID = '01900000-0000-7000-8000-00000000c001';
const message = (text: string) => ({ message: { text } });
// What any text that is not a command and not a label becomes: free text for whatever window
// the customer has open (a username), never a button.
const FREE_TEXT = 'USERNAME_TEXT';

describe('intentOf for an owner-defined button', () => {
  const menu = new Map<string, string>([
    ['کانال ما', customMenuRouteValue(ID)],
    [CATALOGUE_FA['bot.menu.catalog'], '/catalog'],
  ]);

  it('routes a custom label to CUSTOM_MENU_BUTTON with the id from the map value', () => {
    expect(intentOf(message('کانال ما'), menu)).toEqual({
      intent: 'CUSTOM_MENU_BUTTON',
      targetId: ID,
      callbackQueryId: null,
    });
    // Whitespace around the tap is the same tap.
    expect(intentOf(message('  کانال ما  '), menu).targetId).toBe(ID);
  });

  it('does not route typed text that merely reads mb:<id> (the map VALUE routes, never the text)', () => {
    expect(intentOf(message(`mb:${ID}`), menu).intent).toBe(FREE_TEXT);
    // Even when the lookalike is a key of the map itself, pointing nowhere.
    const odd = new Map<string, string>([[`mb:${ID}`, '/catalog']]);
    expect(intentOf(message(`mb:${ID}`), odd).intent).toBe('CATALOG');
    // And a text that is not a label never reaches a custom button.
    expect(intentOf(message('کانال'), menu).intent).toBe(FREE_TEXT);
  });

  it('keeps routing a registry label to its command, and never lets a slash text be a label', () => {
    expect(intentOf(message(CATALOGUE_FA['bot.menu.catalog']), menu).intent).toBe('CATALOG');
    const shadow = new Map<string, string>([['/start', customMenuRouteValue(ID)]]);
    expect(intentOf(message('/start'), shadow).intent).toBe('START');
  });

  it('treats a malformed route value as no button at all (the text stays free text)', () => {
    const bad = new Map<string, string>([
      ['بد۱', 'mb:not-a-uuid'],
      ['بد۲', `mb:${ID.toUpperCase()}`],
      ['بد۳', `mb:${ID} `],
    ]);
    for (const label of ['بد۱', 'بد۲', 'بد۳']) {
      expect(intentOf(message(label), bad).intent).toBe(FREE_TEXT);
    }
  });

  it('declares the intent in the closed vocabulary', () => {
    expect(BOT_INTENTS).toContain('CUSTOM_MENU_BUTTON');
  });
});

describe('BotRuntime.menuFor with an owner-defined label', () => {
  const shared = new Map<string, string>([
    [CATALOGUE_FA['bot.menu.catalog'], '/catalog'],
    [CATALOGUE_FA['bot.menu.admin'], '/admin'],
  ]);
  const scope = { tenantId: '01900000-0000-7000-8000-0000000000aa', botInstanceId: null };
  const runtimeWith = (tenantRoutes: ReadonlyMap<string, string>) =>
    new BotRuntime({
      mainMenu: shared,
      menuRoutes: { routesFor: () => Promise.resolve(tenantRoutes) },
    } as never);

  it('adds the custom label and keeps the shared ones', async () => {
    const routes = await runtimeWith(new Map([['کانال ما', customMenuRouteValue(ID)]])).menuFor(
      scope as never,
      message('کانال ما'),
    );
    expect(routes.get('کانال ما')).toBe(customMenuRouteValue(ID));
    expect(routes.get(CATALOGUE_FA['bot.menu.catalog'])).toBe('/catalog');
  });

  it('never lets a custom label take over a label the shared table already routes', async () => {
    const admin = CATALOGUE_FA['bot.menu.admin'];
    const routes = await runtimeWith(
      new Map([
        [admin, customMenuRouteValue(ID)],
        [CATALOGUE_FA['bot.menu.catalog'], customMenuRouteValue(ID)],
      ]),
    ).menuFor(scope as never, message(admin));
    expect(routes.get(admin)).toBe('/admin');
    expect(routes.get(CATALOGUE_FA['bot.menu.catalog'])).toBe('/catalog');
  });

  it('still lets a RENAMED registry button win over the shared default (R1)', async () => {
    const routes = await runtimeWith(new Map([['نام تازه', '/catalog']])).menuFor(
      scope as never,
      message('نام تازه'),
    );
    expect(routes.get('نام تازه')).toBe('/catalog');
  });

  it('reads the table only for a text message', async () => {
    const routes = await runtimeWith(new Map([['کانال ما', customMenuRouteValue(ID)]])).menuFor(
      scope as never,
      { callback_query: { id: 'x', data: 'y' } },
    );
    expect(routes).toBe(shared);
  });
});
