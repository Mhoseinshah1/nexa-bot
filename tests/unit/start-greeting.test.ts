import { describe, expect, it } from 'vitest';
import {
  UNTRUSTED_VALUE_MAX_LENGTH,
  money,
  templateDefinition,
  type ScopeContext,
  type TemplateDefinition,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA, closeGaps, renderTemplateBody, sanitizeUntrustedText } from '@nexa/i18n';
import { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import { I18nTemplateCatalogue } from '../../apps/api/src/modules/control/templates/infrastructure/i18n-template-catalogue';
import type { TemplateRepository } from '../../apps/api/src/modules/control/templates/application/ports';
import type { FeatureFlagResolver } from '../../apps/api/src/modules/control/features/application/feature-flags.service';
import {
  daysUntil,
  startGreetingValues,
  tehranDateParts,
  type StartGreetingFacts,
} from '../../apps/api/src/modules/commerce/messaging/application/start-greeting';

/**
 * R6 item 3: `/start`'s two greetings take the receiving customer's own data. Every rule
 * below is a way the MirzaBot incident (a name that belonged to somebody else, frozen into a
 * stored text) or a plain rendering slip (`سلام  عزیز`) reaches a customer.
 */
const WELCOME = templateDefinition('bot.start.welcome');
const BACK = templateDefinition('bot.start.welcome_back');
const WELCOME_BODY = CATALOGUE_FA['bot.start.welcome'];
const BACK_BODY = CATALOGUE_FA['bot.start.welcome_back'];
const NOW = new Date('2026-10-24T15:00:00Z'); // 2 آبان ۱۴۰۵, Saturday, 18:30 in Tehran

const facts = (over: Partial<StartGreetingFacts> = {}): StartGreetingFacts => ({
  telegramUserId: '100200300',
  username: 'ali_user',
  firstName: 'علی',
  balance: money(150_000n, 'IRT'),
  activeServices: 2,
  nearestExpiresAt: new Date(NOW.getTime() + 4.2 * 86_400_000),
  now: NOW,
  ...over,
});

const render = (definition: TemplateDefinition, body: string, f: StartGreetingFacts) =>
  renderTemplateBody(definition, body, startGreetingValues(f));

describe('the /start greeting is filled from the receiving customer', () => {
  it('two customers each get their own name and their own figures, in either order', () => {
    const ali = facts({ firstName: 'علی', activeServices: 2 });
    const sara = facts({
      firstName: 'سارا',
      telegramUserId: '555',
      activeServices: 7,
      nearestExpiresAt: new Date(NOW.getTime() + 1 * 86_400_000),
    });
    const first = render(BACK, BACK_BODY, ali);
    const second = render(BACK, BACK_BODY, sara);
    const again = render(BACK, BACK_BODY, ali);
    expect(first).toContain('سلام علی،');
    expect(first).toContain('۲ سرویس فعال');
    expect(first).toContain('۵ روز');
    expect(second).toContain('سلام سارا،');
    expect(second).toContain('۷ سرویس فعال');
    expect(second).toContain('۱ روز');
    expect(second).not.toContain('علی');
    expect(again).toBe(first);
  });

  it('the new default welcome greets by name and keeps the owner’s lines', () => {
    const text = render(WELCOME, WELCOME_BODY, facts());
    expect(text.split('\n')[0]).toBe('ZED PROXY');
    expect(text).toContain('علی عزیز، خوش آمدید.');
    expect(text).toContain('«🛒 خرید اشتراک» یا «🧪 سرویس تست»');
  });

  it('the rendered greeting is never stored: only the raw template is read, for any customer', async () => {
    const reads: string[] = [];
    // A repository that offers ONE method. Any attempt to persist a rendered text (a set,
    // save, upsert, revision) reaches a property that does not exist and fails the render.
    const repository = new Proxy(
      {
        findOverride: async (_scope: unknown, key: TemplateKey) => {
          reads.push(key);
          return null;
        },
      },
      {
        get(target, property, receiver) {
          if (property in target) return Reflect.get(target, property, receiver);
          throw new Error(`the greeting touched the template store: ${String(property)}`);
        },
      },
    ) as unknown as TemplateRepository;
    const resolver = new TemplateResolver(
      repository,
      { isEnabled: async () => true } as unknown as FeatureFlagResolver,
      new I18nTemplateCatalogue(),
      { presentationFor: async () => ({ timezone: 'Asia/Tehran', calendar: 'jalali' }) as never },
    );
    const scope = { tenantId: 't-1', botInstanceId: null } as unknown as ScopeContext;
    const a = await resolver.render(
      scope,
      'bot.start.welcome_back',
      startGreetingValues(facts({ firstName: 'علی' })),
    );
    const b = await resolver.render(
      scope,
      'bot.start.welcome_back',
      startGreetingValues(facts({ firstName: 'سارا' })),
    );
    expect(a).toContain('علی');
    expect(b).toContain('سارا');
    expect(b).not.toContain('علی');
    expect(reads.every((key) => key === 'bot.start.welcome_back')).toBe(true);
    // The default body in the catalogue is still the raw template, with its placeholders.
    expect(CATALOGUE_FA['bot.start.welcome_back']).toContain('{firstName}');
  });
});

describe('a name is neutralised', () => {
  const ATTACK = '<b>x</b> <a href="http://evil.example">go</a> [t](https://evil.example) @admin';

  it('markup, mentions and links in a name are inert in a plain greeting', () => {
    const text = render(WELCOME, WELCOME_BODY, facts({ firstName: ATTACK }));
    const line = text.split('\n')[2] ?? '';
    expect(line).not.toMatch(/[<>]/u);
    expect(line).not.toContain('@');
    expect(line).not.toContain('://');
  });

  it('and is HTML-escaped where the key is HTML — the same renderer, the key’s own escape', () => {
    const html = { ...WELCOME, format: 'TELEGRAM_HTML' } as TemplateDefinition;
    const text = renderTemplateBody(html, '{firstName} & {firstName}', {
      firstName: 'a&b "q" \'s\'',
    });
    expect(text).toBe('a&amp;b &quot;q&quot; &#39;s&#39; & a&amp;b &quot;q&quot; &#39;s&#39;');
    // A name that carries tags never reaches the HTML parser as one: the tags are removed
    // before the key's own escape runs, and what is left is escaped.
    const tagged = renderTemplateBody(html, '{firstName}', { firstName: '<b>x</b>&' });
    expect(tagged).toBe('bx/b&amp;');
  });

  it('control and bidi-override characters are stripped, the ZWNJ of Persian spelling is kept', () => {
    const dirty = 'ع‮لی​\u0007⁦⁩﻿\n\t رضا‌نژاد';
    expect(sanitizeUntrustedText(dirty)).toBe('علی رضا‌نژاد');
    const text = render(WELCOME, WELCOME_BODY, facts({ firstName: dirty }));
    // eslint-disable-next-line no-control-regex -- the point is to assert none of these remain
    expect(text).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B\uFEFF\u0007]/u);
  });

  it('the length is capped, never inside a surrogate pair', () => {
    const long = '😀'.repeat(200);
    const out = sanitizeUntrustedText(long);
    expect(Array.from(out).length).toBe(UNTRUSTED_VALUE_MAX_LENGTH);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(sanitizeUntrustedText('x'.repeat(5000)).length).toBe(UNTRUSTED_VALUE_MAX_LENGTH);
  });

  it('a name cannot inject a placeholder or a forged instant mark', () => {
    const text = render(BACK, BACK_BODY, facts({ firstName: '{walletBalance}' }));
    expect(text).toContain('سلام {walletBalance}،');
    expect(text).not.toContain('');
  });
});

describe('an empty value never leaves a gap', () => {
  it('an empty name gives no double spaces or stray punctuation, whatever the wording', () => {
    for (const firstName of [null, '', '   ', '​‮']) {
      const f = facts({ firstName });
      const welcome = render(WELCOME, WELCOME_BODY, f);
      expect(welcome).toContain('\nعزیز، خوش آمدید.\n');
      expect(welcome).not.toMatch(/ {2}|\n[ ،]/u);
      expect(render(BACK, BACK_BODY, f)).toContain('👋 سلام، خوش برگشتی');
    }
    expect(renderTemplateBody(BACK, 'سلام {firstName} عزیز', {})).toBe('سلام عزیز');
    expect(renderTemplateBody(BACK, 'سلام {firstName}، خوش آمدی', {})).toBe('سلام، خوش آمدی');
    expect(renderTemplateBody(BACK, 'سلام {firstName}', {})).toBe('سلام');
    expect(renderTemplateBody(BACK, '{firstName}', {})).toBe('');
  });

  it('closeGaps only touches the line it is asked to, and closes spaces and punctuation', () => {
    expect(closeGaps('سلام  ، خوش')).toBe('سلام، خوش');
    expect(closeGaps('، خوش آمدید')).toBe('خوش آمدید');
    expect(closeGaps('a ،، b')).toBe('a، b');
    const untouched = 'یک  دو';
    expect(renderTemplateBody(BACK, untouched, { firstName: 'x' })).toBe(untouched);
  });

  it('no active services removes the expiry line (and its blank-line spacing)', () => {
    const none = facts({ activeServices: 0, nearestExpiresAt: null });
    const text = render(BACK, BACK_BODY, none);
    expect(text).not.toContain('نزدیک‌ترین انقضا');
    expect(text).not.toContain('{nearestExpiry}');
    expect(text).toContain('📱 ۰ سرویس فعال داری\n\nاگه سرویست');
    // An expired-only customer has no deadline to name either.
    const past = facts({ nearestExpiresAt: new Date(NOW.getTime() - 1) });
    expect(render(BACK, BACK_BODY, past)).not.toContain('نزدیک‌ترین انقضا');
    expect(daysUntil(new Date(NOW.getTime() - 1), NOW)).toBeNull();
  });

  it('a line holding only an absent @username is dropped', () => {
    const body = 'سلام\nیوزرنیم: {username}\nپایان';
    expect(renderTemplateBody(BACK, body, startGreetingValues(facts({ username: null })))).toBe(
      'سلام\nپایان',
    );
    expect(
      renderTemplateBody(BACK, body, startGreetingValues(facts({ username: 'ali_user' }))),
    ).toBe('سلام\nیوزرنیم: @ali_user\nپایان');
    // A username that is not a Telegram username is not passed on at all.
    expect(startGreetingValues(facts({ username: 'a b<script>' }))).not.toHaveProperty('username');
  });
});

describe('the figures', () => {
  it('a negative balance reads as a debt, a positive one as money', () => {
    const body = 'موجودی: {walletBalance}';
    const debt = renderTemplateBody(
      BACK,
      body,
      startGreetingValues(facts({ balance: money(-12_000n, 'IRT') })),
    );
    expect(debt).toMatch(/^موجودی: ۱۲[,٬]۰۰۰ تومان بدهی$/u);
    expect(debt).not.toContain('-');
    const ok = renderTemplateBody(
      BACK,
      body,
      startGreetingValues(facts({ balance: money(150_000n, 'IRT') })),
    );
    expect(ok).toMatch(/^موجودی: ۱۵۰[,٬]۰۰۰ تومان$/u);
    expect(ok).not.toContain('بدهی');
    expect(
      renderTemplateBody(BACK, body, startGreetingValues(facts({ balance: money(0n, 'IRT') }))),
    ).toMatch(/^موجودی: ۰ تومان$/u);
  });

  it('date, weekday and time are Tehran’s, from the injected clock', () => {
    expect(tehranDateParts(NOW)).toEqual({ date: '۲ آبان ۱۴۰۵', weekday: 'شنبه', time: '۱۸:۳۰' });
    // 21:00 UTC on the 23rd is already past midnight in Tehran: the next day.
    const late = tehranDateParts(new Date('2026-10-23T21:00:00Z'));
    expect(late.date).toBe('۲ آبان ۱۴۰۵');
    expect(late.time).toBe('۰۰:۳۰');
    const text = renderTemplateBody(BACK, '{weekday} {date} {time} {telegramId}', {
      ...startGreetingValues(facts()),
    });
    expect(text).toBe('شنبه ۲ آبان ۱۴۰۵ ۱۸:۳۰ 100200300');
  });

  it('the nearest expiry is whole days rounded up, at least one', () => {
    expect(daysUntil(new Date(NOW.getTime() + 3_600_000), NOW)).toBe(1);
    expect(daysUntil(new Date(NOW.getTime() + 4 * 86_400_000), NOW)).toBe(4);
    expect(daysUntil(new Date(NOW.getTime() + 4 * 86_400_000 + 1), NOW)).toBe(5);
  });
});
