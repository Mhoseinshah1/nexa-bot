import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INLINE_BUTTONS, termsDraftInputSchema, TERMS_BODY_MAX_LENGTH } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  TERMS_ACCEPT_CALLBACK_PREFIX,
  intentOf,
} from '../../apps/api/src/surfaces/telegram/bot-runtime.js';

/**
 * Program §6 — the terms gate's shape, without a database (the behaviour is
 * `tests/integration/terms.test.ts`).
 */

const VERSION = '01900000-0000-7000-8000-0000000000e1';
const tap = (data: string) => ({ callback_query: { id: 'q', data } });

describe('the accept callback', () => {
  it('names the version, and nothing that is not a version parses', () => {
    expect(intentOf(tap(`${TERMS_ACCEPT_CALLBACK_PREFIX}${VERSION}`))).toEqual({
      intent: 'TERMS_ACCEPT',
      targetId: VERSION,
      callbackQueryId: 'q',
    });
    for (const data of ['ac:', 'ac:not-a-uuid', `ac:${VERSION}x`, `ac:${VERSION}.1`]) {
      expect(intentOf(tap(data)).intent).toBe('UNSUPPORTED');
    }
    // Within Telegram's 64-byte callback limit.
    expect(Buffer.byteLength(`${TERMS_ACCEPT_CALLBACK_PREFIX}${VERSION}`)).toBeLessThanOrEqual(64);
  });

  it('takes its label from the inline-button registry, never from the callback', () => {
    const entry = INLINE_BUTTONS.find((button) => button.key === 'terms.accept');
    expect(entry).toMatchObject({ label: 'bot.terms.accept_button', action: 'CALLBACK' });
    expect(CATALOGUE_FA['bot.terms.accept_button']).not.toContain(VERSION);
  });
});

describe('the one central gate', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../apps/api/src/surfaces/telegram/bot-runtime.ts'),
    'utf8',
  );

  /** The method each `this.act(` call sits in, by the nearest method declared above it. */
  function callersOf(call: string): string[] {
    const methods = [...source.matchAll(/^ {2}(?:private |public )?async (\w+)\(/gmu)].map(
      (match) => ({ name: match[1] as string, at: match.index }),
    );
    return [...source.matchAll(new RegExp(call.replace(/[.()]/gu, '\\$&'), 'gu'))].map(
      (match) => methods.filter((method) => method.at < match.index).at(-1)?.name ?? '<top level>',
    );
  }

  it('reaches `act` only through the terms gate, which only the membership gate reaches', () => {
    // A handler that called `act` directly would be a customer action behind no gate.
    expect(new Set(callersOf('this.act('))).toEqual(new Set(['termsGatedAct', 'acceptTerms']));
    expect(new Set(callersOf('this.termsGatedAct('))).toEqual(new Set(['guardedAct']));
    expect(new Set(callersOf('this.guardedAct('))).toEqual(new Set(['handle']));
  });

  it('keeps the frame of the customer message to Appearance markers and the two placeholders', () => {
    for (const key of ['bot.terms.required', 'bot.terms.updated'] as const) {
      expect(CATALOGUE_FA[key]).toContain('{title}');
      expect(CATALOGUE_FA[key]).toContain('{body}');
      expect(CATALOGUE_FA[key]).toMatch(/^\{icon:[a-z]+\}/u);
    }
  });
});

describe('a draft', () => {
  it('is trimmed and bounded so the message, the frame and the button fit Telegram', () => {
    expect(termsDraftInputSchema.safeParse({ title: '  ', body: 'x' }).success).toBe(false);
    expect(
      termsDraftInputSchema.safeParse({ title: 't', body: 'x'.repeat(TERMS_BODY_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(TERMS_BODY_MAX_LENGTH + CATALOGUE_FA['bot.terms.required'].length + 120).toBeLessThan(
      4096,
    );
  });
});
