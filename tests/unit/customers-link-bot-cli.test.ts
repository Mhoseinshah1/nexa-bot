import { describe, expect, it } from 'vitest';
import {
  LINK_BOT_CONFIRM_ENV,
  LinkBotArgsError,
  parseLinkBotArgs,
  reportLine,
} from '../../apps/api/src/customers-link-bot.cli';

const BOT = '01900000-0000-7000-8000-00000000a001';
const YES = { [LINK_BOT_CONFIRM_ENV]: 'yes' };

/** OI-1 part 2: the two-key refusal and the dry-run default of the cutover backfill CLI. */
describe('customers-link-bot arguments', () => {
  it('defaults to a dry run', () => {
    expect(parseLinkBotArgs(['--bot', BOT], {})).toMatchObject({
      apply: false,
      botInstanceId: BOT,
    });
    expect(parseLinkBotArgs(['--bot', BOT, '--dry-run'], {}).apply).toBe(false);
  });

  it('requires a valid bot id', () => {
    expect(() => parseLinkBotArgs([], {})).toThrow(LinkBotArgsError);
    expect(() => parseLinkBotArgs(['--bot'], {})).toThrow(/needs a value/);
    expect(() => parseLinkBotArgs(['--bot', 'nope'], {})).toThrow(/uuid/);
  });

  it('refuses --apply without the confirmation environment variable', () => {
    expect(() => parseLinkBotArgs(['--bot', BOT, '--apply'], {})).toThrow(/CONFIRM=yes/);
    for (const v of ['', 'true', '1', 'YES', 'no'])
      expect(() =>
        parseLinkBotArgs(['--bot', BOT, '--apply'], { [LINK_BOT_CONFIRM_ENV]: v }),
      ).toThrow(LinkBotArgsError);
  });

  it('the environment variable alone never applies', () => {
    expect(parseLinkBotArgs(['--bot', BOT], YES).apply).toBe(false);
  });

  it('applies only with both keys', () => {
    expect(parseLinkBotArgs(['--bot', BOT, '--apply'], YES).apply).toBe(true);
  });

  it('refuses --apply with --dry-run, unknown flags and a bad batch size', () => {
    expect(() => parseLinkBotArgs(['--bot', BOT, '--apply', '--dry-run'], YES)).toThrow(
      /exclusive/,
    );
    expect(() => parseLinkBotArgs(['--bot', BOT, '--force'], YES)).toThrow(LinkBotArgsError);
    expect(() => parseLinkBotArgs(['--bot', BOT, '--batch-size', '0'], {})).toThrow(/batch-size/);
    expect(() => parseLinkBotArgs(['--bot', BOT, '--batch-size', '99999'], {})).toThrow(
      /batch-size/,
    );
    expect(parseLinkBotArgs(['--bot', BOT, '--batch-size', '50'], {}).batchSize).toBe(50);
  });

  it('prints counts and the bot id only', () => {
    const line = reportLine({
      mode: 'DRY_RUN',
      botInstanceId: BOT as never,
      eligible: 7,
      linked: 0,
      batches: 0,
    });
    expect(line).toContain('7');
    expect(line).toContain('Nothing written');
  });
});
