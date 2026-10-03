import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INLINE_BUTTONS, TEMPLATES } from '@nexa/contracts';

/**
 * Owner spec §6: every customer inline button is drawn from the registry — its label through
 * `inlineLabel` / `inlineDataLabel`, never a template key typed at the call site — so a label
 * or style an operator sets reaches every screen, and a new button cannot be added beside
 * the registry by accident.
 *
 * A SOURCE scan, because the property it guards is about how code is written: a `label:`
 * object literal in the Telegram surface is allowed only on an administrator screen.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const FILES = [
  'apps/api/src/surfaces/telegram/bot-runtime.ts',
  'apps/api/src/modules/commerce/provisioning/application/delivery.service.ts',
];

/** What marks an administrator button: its own vocabulary, never a customer's. */
const ADMIN_MARKERS = /bot\.admin\.|ADMIN_|REMINDER_SETTING_BUTTONS|ask\.confirm|button\.prefix/;

function labelLiterals(file: string): string[] {
  const lines = readFileSync(resolve(ROOT, file), 'utf8').split('\n');
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (/^\s*(\*|\/\/)/.test(line)) return;
    if (!/\blabel:\s*(\{|$)/.test(line) && !/\blabel:\s*\n/.test(line)) return;
    const window = lines.slice(index, index + 8).join('\n');
    if (ADMIN_MARKERS.test(window)) return;
    found.push(`${file}:${index + 1}: ${line.trim()}`);
  });
  return found;
}

describe('customer inline buttons go through the registry', () => {
  it('leaves no hand-built label on a customer button', () => {
    expect(FILES.flatMap(labelLiterals)).toEqual([]);
  });

  it('routes every customer button template the catalogue declares through one entry', () => {
    // A `bot.*` button template that no registry entry names would be a label nobody can
    // find in the Web Admin section.
    const named = new Set(INLINE_BUTTONS.map((entry) => entry.label));
    const used = new Set<string>();
    for (const file of FILES) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      for (const match of source.matchAll(/inlineLabel\('([a-z_.]+)'/g)) used.add(match[1]!);
    }
    const registered = new Set<string>(INLINE_BUTTONS.map((entry) => entry.key));
    for (const key of used) expect(registered.has(key), key).toBe(true);
    const unrouted = TEMPLATES.map((entry) => entry.key).filter(
      (key) =>
        /^bot\.(service|payment|wallet|catalog|order|ticket|support|referral|apps|channels|username|discount|marketing|trial)\..*_button$/.test(
          key,
        ) && !named.has(key),
    );
    // Declared templates that no screen draws any more (kept so stored overrides parse).
    // No screen in this release draws these; a package that starts drawing one must route
    // it through the registry, and this list then shrinks.
    expect(unrouted.sort()).toEqual([
      'bot.order.confirm_button',
      'bot.payment.gateway_button',
      'bot.service.action_confirm_button',
      'bot.service.add_time_button',
      'bot.service.resend_button',
      'bot.service.terminate_button',
      'bot.service.terminate_confirm_button',
    ]);
  });
});
