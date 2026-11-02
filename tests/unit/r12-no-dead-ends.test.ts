import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUSAL_REPLIES } from '../../apps/api/src/surfaces/telegram/runtime/refusals';
import {
  NO_WAY_ON_ALLOWED,
  WAY_ON,
  withWayOn,
} from '../../apps/api/src/surfaces/telegram/runtime/way-on';
import type { PendingReply } from '../../apps/api/src/surfaces/telegram/runtime/replies';

/**
 * R12 F3 item 3: no customer reply is a dead end. A reply written with `buttons: []` must be
 * one of: a key `withWayOn` gives a way on (`WAY_ON`), or a key allow-listed with its reason
 * (`NO_WAY_ON_ALLOWED`). A new reply that is neither fails here — the next dead end is caught
 * when it is written, not when a customer is stuck on it.
 */
const TELEGRAM = resolve(import.meta.dirname, '../../apps/api/src/surfaces/telegram');
const files = [
  'bot-runtime.ts',
  ...readdirSync(resolve(TELEGRAM, 'runtime'))
    .filter((file) => file.endsWith('.ts') && !file.startsWith('admin') && file !== 'way-on.ts')
    .map((file) => `runtime/${file}`),
];

/** Every `key: 'bot.…'` literal whose own object says `buttons: []`. */
function emptyButtonKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(resolve(TELEGRAM, file), 'utf8');
    for (const match of source.matchAll(/key:\s*'(bot\.[a-z0-9_.]+)'/gu)) {
      const start = (match.index ?? 0) + match[0].length;
      let segment = source.slice(start, start + 300);
      // The object ends at its statement: never read into the next one.
      const next = segment.search(/key:\s*'bot\.|;/u);
      if (next >= 0) segment = segment.slice(0, next);
      if (/buttons:\s*\[\]/u.test(segment)) {
        const key = match[1] ?? '';
        found.set(key, [...(found.get(key) ?? []), file]);
      }
    }
  }
  return found;
}

const reply = (patch: Partial<PendingReply>): PendingReply => ({
  key: 'bot.order.cancelled',
  values: {},
  buttons: [],
  orderId: null,
  ...patch,
});

describe('R12 F3 item 3: no customer reply is a dead end', () => {
  it('every reply written with no button has a way on or an allow-listed reason', () => {
    const stray = [...emptyButtonKeys()]
      .filter(([key]) => !(key in WAY_ON) && !(key in NO_WAY_ON_ALLOWED))
      .map(([key, where]) => `${key} (${where.join(', ')})`);
    expect(stray, 'add the key to WAY_ON, or to NO_WAY_ON_ALLOWED with the reason').toEqual([]);
  });

  it('every refusal sentence has a way on or an allow-listed reason', () => {
    const stray = [...new Set(Object.values(REFUSAL_REPLIES))].filter(
      (key) => !(key in WAY_ON) && !(key in NO_WAY_ON_ALLOWED),
    );
    expect(stray).toEqual([]);
  });

  it('the keys the owner named all carry a way on', () => {
    for (const key of [
      'bot.order.cancelled',
      'bot.service.action_unavailable',
      'bot.service.not_found',
      'bot.custom_service.unavailable',
      'bot.trial.issued',
      'bot.wallet.topup_expired',
      'bot.service.files_partial',
      'bot.service.files_rate_limited',
      'bot.service.files_unavailable',
      'bot.unknown_command',
    ]) {
      expect(WAY_ON, key).toHaveProperty([key]);
    }
  });

  it('an allow-listed key is not also given a way on, and carries a reason', () => {
    for (const [key, why] of Object.entries(NO_WAY_ON_ALLOWED)) {
      expect(key in WAY_ON, key).toBe(false);
      expect(why?.length ?? 0, key).toBeGreaterThan(10);
    }
  });

  it('gives a reply with no button its way on, and touches nothing else', () => {
    const cancelled = withWayOn(reply({}));
    expect(cancelled.buttons.map((button) => button.inline)).toEqual(['catalog.open', 'main_menu']);
    const unknown = withWayOn(reply({ key: 'bot.unknown_command' }));
    expect(unknown.buttons.map((button) => button.inline)).toEqual(['main_menu']);
    // Already has a button: untouched.
    const own = reply({ buttons: [{ ...cancelled.buttons[0]! }] });
    expect(withWayOn(own)).toBe(own);
    // Sends nothing / a closed wizard step / the reply keyboard / a key outside the table.
    const silent = reply({ key: null });
    expect(withWayOn(silent)).toBe(silent);
    const closed = reply({ wizard: { kind: 'ORDER', step: 'CLOSED', subjectId: 'x' } });
    expect(withWayOn(closed)).toBe(closed);
    const menu = reply({ keyboard: 'MAIN_MENU' });
    expect(withWayOn(menu)).toBe(menu);
    const blocked = reply({ key: 'bot.blocked' });
    expect(withWayOn(blocked)).toBe(blocked);
  });

  it('a refused typed answer keeps only «انصراف» — the window stays open', () => {
    for (const key of [
      'bot.username.invalid',
      'bot.username.taken',
      'bot.discount.rejected',
    ] as const) {
      expect(withWayOn(reply({ key })).buttons.map((button) => button.inline)).toEqual([
        'order.input_cancel',
      ]);
    }
  });
});
