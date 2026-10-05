import { describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES,
  templateDefinition,
} from '@nexa/contracts';
import {
  contentHash,
  diffBuild,
  type BuildItem,
  type BuiltArticle,
} from '../../apps/api/src/modules/control/support-knowledge/domain/build-diff';
import {
  BUILD_TUTORIAL_KEYS,
  NexaKnowledgeSources,
} from '../../apps/api/src/modules/control/support-knowledge/infrastructure/nexa-knowledge-sources';

/**
 * TB9 — the pure parts of the knowledge build: the diff that decides ADD, UPDATE, UNCHANGED and
 * CONFLICT, the content hash, the exact source allowlist, and the source adapter's field
 * allowlist over records carrying every secret a real row can carry.
 */

const item = (overrides: Partial<BuildItem> = {}): BuildItem => ({
  sourceType: 'FAQ',
  sourceKey: 'faq-1',
  content: { title: 'سؤال', body: 'پاسخ', category: 'GENERAL', tags: [] },
  ...overrides,
});

const built = (overrides: Partial<BuiltArticle> = {}): BuiltArticle => ({
  id: 'a1',
  sourceType: 'FAQ',
  sourceKey: 'faq-1',
  state: 'APPROVED',
  revision: 1,
  builtRevision: 1,
  builtHash: contentHash(item().content),
  title: 'سؤال',
  body: 'پاسخ',
  ...overrides,
});

describe('the build diff', () => {
  it('ADD when no article holds the source', () => {
    expect(diffBuild([item()], []).map((d) => d.kind)).toEqual(['ADD']);
  });

  it('UNCHANGED when the source is as last built', () => {
    expect(diffBuild([item()], [built()]).map((d) => d.kind)).toEqual(['UNCHANGED']);
  });

  it('UPDATE when the source changed and nobody edited the article since', () => {
    const changed = item({ content: { ...item().content, body: 'پاسخ تازه' } });
    expect(diffBuild([changed], [built()]).map((d) => d.kind)).toEqual(['UPDATE']);
  });

  it('CONFLICT when the source changed AND the article was edited since the last build', () => {
    const changed = item({ content: { ...item().content, body: 'پاسخ تازه' } });
    expect(diffBuild([changed], [built({ revision: 2 })]).map((d) => d.kind)).toEqual(['CONFLICT']);
  });

  it('an edited article whose source did not change is UNCHANGED (the edit stays)', () => {
    expect(diffBuild([item()], [built({ revision: 3 })]).map((d) => d.kind)).toEqual(['UNCHANGED']);
  });

  it('a retired article is never brought back', () => {
    const changed = item({ content: { ...item().content, body: 'پاسخ تازه' } });
    expect(diffBuild([changed], [built({ state: 'RETIRED' })]).map((d) => d.kind)).toEqual([
      'UNCHANGED',
    ]);
  });

  it('matches by (source type, source key) only, never by title', () => {
    const other = built({ sourceType: 'PRODUCT', sourceKey: 'faq-1' });
    expect(diffBuild([item()], [other]).map((d) => d.kind)).toEqual(['ADD']);
  });

  it('the hash is stable and sees every field', () => {
    const base = item().content;
    expect(contentHash(base)).toBe(contentHash({ ...base, tags: [] }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, title: 'x' }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, category: 'APPS' }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, tags: ['t'] }));
  });
});

describe('the source allowlist', () => {
  it('is exactly the reviewed list', () => {
    expect([...SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES]).toEqual([
      'PRODUCT',
      'LOCATIONS',
      'CLIENT_APP',
      'TUTORIAL',
      'FAQ',
      'TERMS',
      'SUPPORT_ACCOUNTS',
      'PAYMENT_METHOD',
    ]);
  });

  it('the tutorials it reads declare no placeholder (nothing is rendered)', () => {
    expect(BUILD_TUTORIAL_KEYS).toEqual([
      'bot.tutorial.android',
      'bot.tutorial.ios',
      'bot.tutorial.windows',
      'bot.tutorial.macos',
      'bot.tutorial.linux',
    ]);
    for (const key of BUILD_TUTORIAL_KEYS) expect(templateDefinition(key).placeholders).toEqual([]);
  });
});

describe('the source adapter keeps customer-facing fields only', () => {
  const SECRETS = [
    'PANEL-SECRET-ID',
    'panel-secret.example.test',
    '987654321',
    'LOCATION-KEY-SECRET',
    'ALT-URL-SECRET',
    'GATEWAY-SECRET-RATE',
    'APP-ICON-SECRET',
    'DRAFT TERMS SECRET',
  ];
  const queries: Record<string, unknown> = {};
  const sources = new NexaKnowledgeSources({
    products: {
      list: async (_scope, search) => {
        queries['products'] = search;
        return {
          items: [
            {
              id: 'prod-1',
              title: 'پلن طلایی',
              description: 'توضیح عمومی',
              status: 'ACTIVE',
              audience: 'EVERYONE',
              sortOrder: 0,
              panelId: 'PANEL-SECRET-ID',
              categoryId: null,
              specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
              price: { amountMinor: 987654321n, currency: 'IRT' },
              display: { ...EMPTY_PRODUCT_DISPLAY, displayFeatures: ['سرعت بالا'] },
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          nextCursor: null,
        } as never;
      },
    },
    locations: {
      list: async () =>
        [
          {
            label: 'آلمان',
            enabled: true,
            locationKey: 'LOCATION-KEY-SECRET',
            panelId: 'PANEL-SECRET-ID',
            price: { amountMinor: 987654321n, currency: 'IRT' },
          },
          { label: 'مخفی', enabled: false, locationKey: 'x', panelId: 'y', price: null },
        ] as never,
    },
    clientApps: {
      list: async (_scope, options) => {
        queries['apps'] = options;
        return [
          {
            id: 'app-1',
            platform: 'ANDROID',
            name: 'v2rayNG',
            icon: 'APP-ICON-SECRET',
            description: 'برنامهٔ اندروید',
            officialUrl: 'https://github.com/2dust/v2rayNG',
            alternativeUrl: 'https://ALT-URL-SECRET.example',
            helpUrl: null,
            guide: 'نصب کنید',
            status: 'ENABLED',
          },
        ] as never;
      },
    },
    templates: {
      resolve: async (_scope, key) =>
        ({
          key,
          locale: 'fa',
          body: `راهنمای ${key}`,
          source: 'DEFAULT',
          overrideSuppressed: false,
        }) as never,
    },
    faqs: { list: async () => [{ id: 'faq-1', question: 'سؤال', answer: 'پاسخ' }] as never },
    terms: {
      current: async () => ({ title: 'قوانین', body: 'متن منتشرشده' }) as never,
    },
    settings: { valueOf: async <T>() => ['@nexa_support'] as unknown as T },
    gateways: {
      list: async () =>
        [
          {
            provider: 'CARD_TO_CARD',
            status: 'ACTIVE',
            displayName: 'کارت به کارت',
            instructions: 'رسید را بفرستید',
            minAmountMinor: 987654321n,
            providerUnitRateMinor: 'GATEWAY-SECRET-RATE',
          },
          {
            provider: 'TONPAYS',
            status: 'ACTIVE',
            displayName: 'ترون',
            instructions: 'مبلغ {amount} را بفرستید',
            minAmountMinor: 1n,
          },
          { provider: 'STARS', status: 'DISABLED', displayName: 'استارز', instructions: 'غیرفعال' },
        ] as never,
    },
  });

  it('reads active, public products and enabled apps only', async () => {
    await sources.collect({ tenantId: 't' } as never);
    expect(queries['products']).toEqual({ status: 'ACTIVE', audience: 'EVERYONE' });
    expect(queries['apps']).toEqual({ status: 'ENABLED' });
  });

  it('every item is an allowlisted type, and no secret, price or internal field appears', async () => {
    const items = await sources.collect({ tenantId: 't' } as never);
    expect(new Set(items.map((i) => i.sourceType))).toEqual(
      new Set([
        'PRODUCT',
        'LOCATIONS',
        'CLIENT_APP',
        'TUTORIAL',
        'FAQ',
        'TERMS',
        'SUPPORT_ACCOUNTS',
        'PAYMENT_METHOD',
      ]),
    );
    const text = JSON.stringify(items.map((i) => i.content));
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain('مخفی');
    expect(text).not.toContain('استارز');
    // A route whose instructions carry a placeholder is not text on its own.
    expect(text).not.toContain('{amount}');
    expect(text).toContain('پلن طلایی');
    expect(text).toContain('آلمان');
  });
});
