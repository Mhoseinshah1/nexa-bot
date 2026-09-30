import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_SLOTS,
  APPEARANCE_SLOT_FALLBACKS,
  CUSTOM_EMOJI_ID_PATTERN,
  appearanceMarker,
  appearanceMarkersIn,
  money,
  templateDefinition,
  validateTemplateBody,
  type AppearanceSlot,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import {
  NO_DECORATION,
  appearanceFallbackText,
  decorateAppearance,
  entitiesWithin,
  maskAppearanceMarkers,
  undoHtmlDecoration,
} from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import { splitMessageBody } from '../../apps/api/src/modules/commerce/messaging/application/message-split';

/**
 * Premium UI: the ONE renderer that turns `{icon:…}` into what Telegram draws
 * (`docs/premium-ui-audit.md` §4). Offsets are UTF-16 code units, as the Bot API counts.
 */

const ID = '5368324170671202286';
const decoration = (slots: Partial<Record<AppearanceSlot, string>>) => ({
  customEmoji: new Map(Object.entries(slots) as [AppearanceSlot, string][]),
});

describe('the slot catalogue', () => {
  it('gives every slot one emoji as its fallback, and a marker the placeholder syntax cannot read', () => {
    for (const slot of APPEARANCE_SLOTS) {
      const fallback = APPEARANCE_SLOT_FALLBACKS[slot];
      // One grapheme: the entity that covers it covers exactly one emoji.
      expect([
        ...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(fallback),
      ]).toHaveLength(1);
      expect(fallback).not.toMatch(/[<>&"']/);
      expect(appearanceMarker(slot)).toBe(`{icon:${slot}}`);
    }
    // Rendering leaves a marker literal: it is not a declared placeholder and cannot be one.
    const rendered = renderTemplateBody(
      templateDefinition('bot.wallet.balance'),
      '{icon:wallet} موجودی: {balance}',
      { balance: money(1000n, 'IRT') },
    );
    expect(rendered.startsWith('{icon:wallet} ')).toBe(true);
    expect(CUSTOM_EMOJI_ID_PATTERN.test(ID)).toBe(true);
    expect(CUSTOM_EMOJI_ID_PATTERN.test('<b>')).toBe(false);
  });

  it('refuses a body whose marker names no slot, and accepts every declared one', () => {
    const definition = templateDefinition('bot.order.settled');
    expect(
      validateTemplateBody(definition, 'x {icon:paymnt} y').map((issue) => issue.kind),
    ).toEqual(['UNKNOWN_ICON']);
    expect(
      validateTemplateBody(definition, APPEARANCE_SLOTS.map(appearanceMarker).join(' ')),
    ).toEqual([]);
    expect(appearanceMarkersIn('{icon:a} {b} {icon:success}')).toEqual(['a', 'success']);
  });

  it('sees a malformed marker — wrong case, a digit, a space — and refuses it rather than passing it to a customer', () => {
    const definition = templateDefinition('bot.order.settled');
    for (const bad of ['{icon:success1}', '{icon:Payment}', '{icon: payment}', '{icon:}']) {
      expect(
        validateTemplateBody(definition, `x ${bad} y`).map((issue) => issue.kind),
        bad,
      ).toEqual(['UNKNOWN_ICON']);
      // And the renderer leaves it literal: it names no slot.
      expect(decorateAppearance(`x ${bad} y`, 'PLAIN_TEXT', decoration({ payment: ID })).text).toBe(
        `x ${bad} y`,
      );
    }
  });

  it('is what every system-owned default body names — no marker in the catalogue is unknown', () => {
    const marked = Object.entries(CATALOGUE_FA).filter(
      ([, body]) => appearanceMarkersIn(body).length > 0,
    );
    expect(marked.length).toBeGreaterThanOrEqual(30);
    for (const [key, body] of marked) {
      expect(
        validateTemplateBody(templateDefinition(key as never), body),
        `${key} carries an unknown icon`,
      ).toEqual([]);
    }
    // The ones the brief names, at least.
    for (const key of [
      'bot.order.settled',
      'bot.payment.rejected',
      'bot.wallet.topup_credited',
      'bot.service.provisioning',
      'bot.service.expired',
      'bot.trial.issued',
      'bot.referral.invite',
      'bot.service.renewed',
      'bot.support.contact',
      'bot.ticket.created',
      'bot.service.action_failed',
      'bot.service.delivered',
    ] as const) {
      expect(appearanceMarkersIn(CATALOGUE_FA[key]).length, key).toBeGreaterThan(0);
    }
  });
});

describe('decorateAppearance, plain text', () => {
  it('places a custom_emoji entity in UTF-16 units after Persian text and an astral emoji', () => {
    const out = decorateAppearance(
      'پرداخت 🧪 {icon:payment} تمام',
      'PLAIN_TEXT',
      decoration({ payment: ID }),
    );
    expect(out.text).toBe('پرداخت 🧪 💳 تمام');
    // 'پرداخت' is 6 units, a space, '🧪' is a surrogate pair (2), a space: the emoji starts at 10.
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: 10, length: 2, custom_emoji_id: ID },
    ]);
    expect(out.decorated).toBe(1);
    expect(out.text.slice(10, 12)).toBe('💳');
  });

  it('covers a two-code-point fallback whole, and places several markers in order', () => {
    const out = decorateAppearance(
      '{icon:warning}a{icon:success}b{icon:info}',
      'PLAIN_TEXT',
      decoration({ warning: '1', success: '2', info: '3' }),
    );
    expect(out.text).toBe('⚠️a✅b‼️'.replace('‼️', 'ℹ️'));
    expect(out.entities).toEqual([
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '1' },
      { type: 'custom_emoji', offset: 3, length: 1, custom_emoji_id: '2' },
      { type: 'custom_emoji', offset: 5, length: 2, custom_emoji_id: '3' },
    ]);
    for (const entity of out.entities) {
      expect(out.text.slice(entity.offset, entity.offset + entity.length)).toBe(
        APPEARANCE_SLOT_FALLBACKS[
          entity.custom_emoji_id === '1'
            ? 'warning'
            : entity.custom_emoji_id === '2'
              ? 'success'
              : 'info'
        ],
      );
    }
  });

  it('falls back — the emoji, no entity — for a slot with no custom id, and with no decoration at all', () => {
    const body = '{icon:payment} پرداخت {icon:success}';
    expect(decorateAppearance(body, 'PLAIN_TEXT', decoration({ success: ID }))).toEqual({
      text: '💳 پرداخت ✅',
      entities: [{ type: 'custom_emoji', offset: 10, length: 1, custom_emoji_id: ID }],
      decorated: 1,
    });
    expect(decorateAppearance(body, 'PLAIN_TEXT', NO_DECORATION)).toEqual({
      text: '💳 پرداخت ✅',
      entities: [],
      decorated: 0,
    });
    expect(appearanceFallbackText(body)).toBe('💳 پرداخت ✅');
  });

  it('leaves an unknown marker literal and a body without markers byte for byte', () => {
    const out = decorateAppearance(
      'a {icon:nope} {other} b',
      'PLAIN_TEXT',
      decoration({ payment: ID }),
    );
    expect(out).toEqual({ text: 'a {icon:nope} {other} b', entities: [], decorated: 0 });
    const plain = 'سلام <b>x</b> & y';
    expect(decorateAppearance(plain, 'PLAIN_TEXT', decoration({ payment: ID })).text).toBe(plain);
  });
});

describe('decorateAppearance, HTML', () => {
  it('writes the Bot API tg-emoji tag with the fallback as its content, and no entities', () => {
    const out = decorateAppearance(
      '{icon:success} سرویس\n<code>{x}</code> {icon:link}',
      'TELEGRAM_HTML',
      decoration({ success: ID }),
    );
    expect(out.text).toBe(`<tg-emoji emoji-id="${ID}">✅</tg-emoji> سرویس\n<code>{x}</code> 🔗`);
    expect(out.entities).toEqual([]);
    expect(out.decorated).toBe(1);
    // The one retry a refused decorated send is allowed: the same text, minus the tag.
    expect(undoHtmlDecoration(out.text)).toBe('✅ سرویس\n<code>{x}</code> 🔗');
    expect(undoHtmlDecoration('<tg-emoji emoji-id="x">✅</tg-emoji>')).toBe(
      '<tg-emoji emoji-id="x">✅</tg-emoji>',
    );
  });
});

describe('entities across a split body', () => {
  it('re-bases each entity on its part and drops one a cut runs through, never clipping it', () => {
    const entities = [
      { type: 'custom_emoji' as const, offset: 0, length: 2, custom_emoji_id: '1' },
      { type: 'custom_emoji' as const, offset: 9, length: 2, custom_emoji_id: '2' },
      { type: 'custom_emoji' as const, offset: 20, length: 1, custom_emoji_id: '3' },
    ];
    expect(entitiesWithin(entities, 0, 10)).toEqual([entities[0]]);
    expect(entitiesWithin(entities, 5, 30)).toEqual([
      { ...entities[1], offset: 4 },
      { ...entities[2], offset: 15 },
    ]);
  });

  it('masks every marker as one atomic stand-in the splitter cannot cut, and restores it per part', () => {
    const line = `{icon:payment} ${'x'.repeat(30)} {icon:success}`;
    const body = Array.from({ length: 6 }, () => line).join('\n\n');
    const { masked, restore } = maskAppearanceMarkers(body);
    expect(masked).not.toContain('{icon:');
    // A stand-in is a surrogate pair: never wider than the fallback it stands for.
    expect(masked.length).toBe(
      body.length - 6 * ('{icon:payment}'.length + '{icon:success}'.length) + 6 * 4,
    );
    const parts = splitMessageBody(masked, 40);
    expect(parts.length).toBeGreaterThan(1);
    let seen = 0;
    for (const part of parts) {
      const restored = restore(part);
      expect(restored).not.toMatch(/\{icon:[a-z]*$|^[a-z]*\}/);
      const out = decorateAppearance(restored, 'PLAIN_TEXT', decoration({ payment: ID }));
      for (const entity of out.entities) {
        expect(out.text.slice(entity.offset, entity.offset + entity.length)).toBe('💳');
        seen += 1;
      }
    }
    expect(seen).toBe(6);
    // A malformed marker is masked too, so a cut never leaves half of one behind.
    expect(
      maskAppearanceMarkers('a {icon:Payment} b').restore(
        maskAppearanceMarkers('a {icon:Payment} b').masked,
      ),
    ).toBe('a {icon:Payment} b');
  });
});
