import { describe, expect, it } from 'vitest';
import { BOT_COMMANDS } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  intentOf,
  MARKETING_OPT_IN_CALLBACK_DATA,
  MARKETING_OPT_OUT_CALLBACK_DATA,
  marketingPreferenceButton,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';

/**
 * Round N close (§D): the promotional opt-out's three entry points — `/stop`, the opt-out
 * button and the opt-in button — resolve to their intents, and the support screen offers
 * the reverse of what the customer holds.
 */
describe('the promotional opt-out on Telegram', () => {
  it('routes /stop, in any spelling Telegram sends it, to the opt-out', () => {
    expect(intentOf({ message: { text: '/stop' } }).intent).toBe('MARKETING_OPT_OUT');
    expect(intentOf({ message: { text: '  /STOP  ' } }).intent).toBe('MARKETING_OPT_OUT');
    expect(intentOf({ message: { text: '/stop@nexa_bot' } }).intent).toBe('MARKETING_OPT_OUT');
  });

  it('routes the two buttons, which carry no id: the tapper is the subject', () => {
    expect(
      intentOf({ callback_query: { id: 'q1', data: MARKETING_OPT_OUT_CALLBACK_DATA } }),
    ).toEqual({ intent: 'MARKETING_OPT_OUT', targetId: null, callbackQueryId: 'q1' });
    expect(
      intentOf({ callback_query: { id: 'q2', data: MARKETING_OPT_IN_CALLBACK_DATA } }),
    ).toEqual({ intent: 'MARKETING_OPT_IN', targetId: null, callbackQueryId: 'q2' });
  });

  it('offers the reverse of the held preference, and registers /stop with a described command', () => {
    expect(marketingPreferenceButton(true)).toEqual({
      label: { kind: 'TEMPLATE', key: 'bot.marketing.opt_in_button' },
      data: MARKETING_OPT_IN_CALLBACK_DATA,
    });
    expect(marketingPreferenceButton(false)).toEqual({
      label: { kind: 'TEMPLATE', key: 'bot.marketing.opt_out_button' },
      data: MARKETING_OPT_OUT_CALLBACK_DATA,
    });
    const stop = BOT_COMMANDS.find((entry) => entry.command === 'stop');
    expect(stop?.description).toBe('bot.command.stop');
    expect(CATALOGUE_FA['bot.help']).toContain('/stop');
    // The reply after /stop names what still arrives, in the tenant's default copy.
    expect(CATALOGUE_FA['bot.marketing.opted_out']).toContain('پرداخت');
  });
});
