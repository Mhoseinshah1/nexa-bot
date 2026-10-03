import { describe, expect, it } from 'vitest';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  intentOf,
  isCallbackQueryUpdate,
  MAIN_MENU_CALLBACK_DATA,
  staleCallbackReply,
} from '../../apps/api/src/surfaces/telegram/bot-runtime.js';

/**
 * Item 12 (blocker C4): NEXA answers on the SAME bot token MirzaBot used, so every inline
 * keyboard MirzaBot ever drew is still sitting in customers' chats after cutover, and a tap
 * on one arrives here as an ordinary `callback_query`.
 *
 * The corpus below is MirzaBot's own `callback_data`, read from the public upstream source
 * (`mahdiMGF2/botmirzapanel`, `index.php`, `admin.php`, `keyboard.php` on its default
 * branch, fetched 2026-10-03): every literal it draws and every `$datain == …` /
 * `preg_match(…, $datain)` it routes on, with a plausible value where the source
 * concatenates a username, an id or a code. `docs/research/` records MirzaBot's buttons by
 * LABEL only, so this is the evidence for the DATA. Whether the deployed MirzaBot was that
 * exact revision is not known here — a real-bot tap of an old keyboard is a manual
 * acceptance item (`docs/open-questions.md`, OQ-C4-01).
 */
const MIRZABOT_CALLBACKS: readonly string[] = [
  // Customer-side literals.
  'none',
  'backuser',
  'backorder',
  'buy',
  'support',
  'helpbtn',
  'fqQuestions',
  'usernotlist',
  'next_page',
  'previous_page',
  'confirmandgetservice',
  'confirmandgetserviceDiscount',
  'confirmchannel',
  'cart_to_offline',
  'aqayepardakht',
  'nowpayments',
  'iranpay',
  'Discount',
  'closelist',
  'username',
  'notusernameget',
  'expirationDate',
  'RemainingVolume',
  'LastTraffic',
  'day',
  'status_var',
  'cancel_sendmessage',
  'subject',
  'subjectde',
  'aptdc',
  // Customer-side patterns, with a value where the source concatenates one.
  'product_user123ab',
  'extend_user123ab',
  'Extra_volume_user123ab',
  'confirmaextra_20',
  'changelink_user123ab',
  'confirmchange_user123ab',
  'removebyuser-user123ab',
  'removeserviceuserco-user123ab',
  'confirmremoveservices-user123ab',
  'subscriptionurl_user123ab',
  'config_user123ab',
  'serviceextendselect_p01',
  'prodcutservice_p01',
  'prodcutservices_p01',
  'confirmserivce-p01',
  'location_3',
  'locationtests_3',
  'locationnotuser_3',
  'categorylist_4',
  'nextpage_2',
  'prevpage_1',
  'Confirmpay_user_17_aB3dE5',
  'Response_5551234567',
  // Admin-side literals and patterns (a bound administrator taps these too).
  'back_admin',
  'PANEL',
  'activepanel',
  'disablepanel',
  'settingcart',
  'copycart',
  'SettingnowPayment',
  'Settingaqayepardakht',
  'NotUser',
  'Automatic_confirmation',
  'statusbot',
  'statuscategory',
  'status_verify',
  'roll_Status',
  'help_Status',
  'get_number',
  'iran_number',
  'onaffiliates',
  'offaffiliates',
  'oncommission',
  'offcommission',
  'onDiscountaffiliates',
  'offDiscountaffiliates',
  'onconfig',
  'offconfig',
  'ononhold',
  'offonhold',
  'onsublink',
  'offsublink',
  'ontestshowpanel',
  'offtestshowpanel',
  'Confirm_pay_aB3dE5',
  'reject_pay_aB3dE5',
  'verify_5551234567',
  'verifyun_5551234567',
  'banuserlist_5551234567',
  'unbanuserr_5551234567',
  'addbalanceuser_5551234567',
  'lowbalanceuser_5551234567',
  'limitusertest_5551234567',
  'confirmnumber_5551234567',
  'vieworderall_5551234567',
  'addordermanualـ5551234567',
  'remoceserviceadmin-user123ab',
  'rejectremoceserviceadmin-user123ab',
  'editstsuts-statusbot-onbot',
  'editstsuts-category-offcategory',
  'editpay-cart-oncard',
  'editpay-nowpayment-offnowpayment',
  'typepanel%marzban',
  'typepanel%x-ui_single',
  'typepanel%alireza',
];

const tap = (data: unknown) =>
  intentOf({ update_id: 1, callback_query: { id: 'cbq-legacy', data } });

describe('Item 12: an old MirzaBot button never becomes a NEXA action', () => {
  it('reads every MirzaBot callback shape as UNSUPPORTED', () => {
    const mapped = MIRZABOT_CALLBACKS.map((data) => [data, tap(data)] as const).filter(
      ([, command]) => command.intent !== 'UNSUPPORTED' || command.targetId !== null,
    );
    expect(mapped.map(([data, command]) => `${data} -> ${command.intent}`)).toEqual([]);
  });

  it('keeps the callback id, so the tap is still answered', () => {
    expect(tap('backuser').callbackQueryId).toBe('cbq-legacy');
  });

  it('is disjoint from NEXA by construction: every NEXA route names a colon, no MirzaBot one does', async () => {
    /*
     * The structural reason the table above holds, pinned so a future route cannot quietly
     * drop the colon: MirzaBot's data is `word`, `word_value`, `word-value` or
     * `word%value` and never contains `:`, while every exported NEXA callback prefix and
     * whole datum does. A NEXA route without one would be the first that a MirzaBot
     * keyboard could reach.
     */
    const runtime = await import('../../apps/api/src/surfaces/telegram/bot-runtime.js');
    const routes = Object.entries(runtime).filter(
      ([name, value]) =>
        (name.endsWith('_CALLBACK_PREFIX') || name.endsWith('_CALLBACK_DATA')) &&
        typeof value === 'string',
    );
    expect(routes.length, 'the export scan found almost nothing').toBeGreaterThan(50);
    expect(routes.filter(([, value]) => !(value as string).includes(':'))).toEqual([]);
    expect(MIRZABOT_CALLBACKS.filter((data) => data.includes(':'))).toEqual([]);
  });

  it('reads malformed data as UNSUPPORTED: empty, missing, not a string, oversized, control characters', () => {
    for (const data of [
      '',
      undefined,
      null,
      42,
      { nested: 'mm:' },
      ['mm:'],
      ' mm:',
      'mm: ',
      'MM:',
      'mm:\u0000',
      'x'.repeat(4096),
      `mm:${'x'.repeat(64)}`,
      '‏mm:',
      'p:not-a-uuid',
    ]) {
      expect(tap(data), JSON.stringify(data)).toMatchObject({
        intent: 'UNSUPPORTED',
        targetId: null,
      });
    }
  });

  it('reads a TRUNCATED NEXA payload as UNSUPPORTED, never as a different id or action', async () => {
    /*
     * Telegram limits callback data to 64 bytes and a client can cut it anywhere. Every
     * exported id-carrying prefix, given half a UUID, must refuse rather than act on a
     * shorter id; and every prefix with its last character cut off must not land on a
     * neighbouring route.
     */
    const runtime = await import('../../apps/api/src/surfaces/telegram/bot-runtime.js');
    const id = '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa';
    const prefixes = Object.entries(runtime)
      .filter(([name, value]) => name.endsWith('_CALLBACK_PREFIX') && typeof value === 'string')
      .map(([, value]) => value as string);
    const actedOnHalfAnId = prefixes
      .map((prefix) => [prefix, tap(`${prefix}${id.slice(0, 18)}`)] as const)
      .filter(([, command]) => command.targetId !== null);
    expect(actedOnHalfAnId.map(([prefix, command]) => `${prefix} -> ${command.intent}`)).toEqual(
      [],
    );
    // A whole uuid with its tail cut, on the routes the money and the services ride on.
    for (const prefix of ['c:', 'p:', 'w:', 'pm:', 's:', 'z:']) {
      expect(tap(`${prefix}${id.slice(0, -1)}`).intent, prefix).toBe('UNSUPPORTED');
    }
  });
});

describe('Item 12: the answer to a button nobody recognises', () => {
  it('is the stale-button sentence with a way back to the main menu, and nothing from the data', () => {
    const reply = staleCallbackReply();
    expect(reply.key).toBe('bot.callback.stale');
    expect(reply.values).toEqual({});
    expect(reply.orderId).toBeNull();
    expect(reply.buttons.map((button) => ('data' in button ? button.data : null))).toEqual([
      MAIN_MENU_CALLBACK_DATA,
    ]);
    expect(tap(MAIN_MENU_CALLBACK_DATA).intent).toBe('MAIN_MENU');
  });

  it('has a Persian default body with no placeholder a payload could fill', () => {
    const body = CATALOGUE_FA['bot.callback.stale'];
    expect(body).toMatch(/[؀-ۿ]/u);
    expect(body.replace(/\{icon:[a-z]+\}/gu, '')).not.toMatch(/\{/u);
  });

  it('tells a tapped button from a typed message', () => {
    expect(isCallbackQueryUpdate({ callback_query: { id: 'x', data: 'backuser' } })).toBe(true);
    expect(isCallbackQueryUpdate({ callback_query: { id: 'x' } })).toBe(true);
    expect(isCallbackQueryUpdate({ message: { text: 'backuser' } })).toBe(false);
    expect(isCallbackQueryUpdate({ callback_query: null })).toBe(false);
    expect(isCallbackQueryUpdate(null)).toBe(false);
  });
});
