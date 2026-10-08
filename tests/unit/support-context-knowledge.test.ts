import { describe, expect, it } from 'vitest';
import {
  SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES,
  SUPPORT_CONTEXT_MAX_BYTES,
  type Clock,
  type SupportContextPayload,
  type TenantContext,
} from '@nexa/contracts';
import {
  fitPayload,
  payloadBytes,
} from '../../apps/api/src/modules/commerce/support-context/domain/support-context-payload';
import {
  foldForMatching,
  matchTerms,
  selectRelevantKnowledge,
} from '../../apps/api/src/modules/commerce/support-context/domain/knowledge-relevance';
import {
  SupportContextBuilder,
  type SupportContextBuilderDeps,
} from '../../apps/api/src/modules/commerce/support-context/application/support-context.builder';
import type { ClientAppRecord } from '../../apps/api/src/modules/control/client-apps/application/ports';
import type { CustomerRecord } from '../../apps/api/src/modules/commerce/customers/application/ports';
import { latestCustomerWords } from '../../apps/api/src/modules/control/support-ai/domain/transcript';

/**
 * D2 — approved knowledge reaches the model: chosen by relevance to the customer's latest
 * words, protected by its own share of the byte budget, never sent twice as an app guide.
 * The sizes are REALISTIC (Persian articles of 1–4 thousand characters, six apps with long
 * guides), so the budget cut actually happens in these tests — the TB8 tests used short
 * articles and never reached it.
 */

const NOW = new Date('2026-10-06T12:00:00.000Z');
const scope = { tenantId: 'tenant-a', botInstanceId: null } as unknown as TenantContext;
const ZWNJ = String.fromCharCode(0x200c);

/** A long Persian paragraph about `topic`, `chars` characters long. */
function persian(topic: string, chars: number): string {
  const filler =
    ' این متن راهنما برای مشتریان نوشته شده است و مراحل را یکی‌یکی توضیح می‌دهد تا کار ساده شود.';
  let out = topic;
  while (out.length < chars) out += filler;
  return out.slice(0, chars);
}

interface ArticleRow {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly sourceType: string | null;
  readonly sourceKey: string | null;
}

function article(title: string, chars: number, over: Partial<ArticleRow> = {}): ArticleRow {
  return {
    title,
    body: persian(title, chars),
    tags: [],
    sourceType: null,
    sourceKey: null,
    ...over,
  };
}

/** Twenty approved articles, newest first; the connection one is the OLDEST. */
function realisticArticles(): ArticleRow[] {
  const topics = [
    'تمدید سرویس',
    'خرید سرویس جدید',
    'افزایش حجم',
    'تغییر لوکیشن',
    'دعوت از دوستان',
    'قوانین استفاده',
    'زمان پشتیبانی',
    'کیف پول و شارژ',
    'نمایندگی فروش',
    'هدیه و تخفیف',
    'پلن‌های ماهانه',
    'پلن‌های سه‌ماهه',
    'دستگاه‌های مجاز',
    'سرعت سرویس',
    'نصب روی تلویزیون',
    'نصب روی ویندوز',
    'نصب روی آیفون',
    'نصب روی مک',
    'حریم خصوصی',
  ];
  return [
    ...topics.map((topic) => article(topic, 1500)),
    article('وصل نمی‌شود: سرویس متصل نمی‌شود چه کنم', 1500, { tags: ['اتصال', 'قطعی'] }),
  ];
}

function apps(count: number): ClientAppRecord[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `app-${String(i + 1)}`,
        platform: 'ANDROID',
        name: `App ${String(i + 1)}`,
        icon: null,
        description: persian('برنامه', 300),
        officialUrl: `https://example.com/app${String(i + 1)}`,
        alternativeUrl: null,
        helpUrl: null,
        guide: persian('راهنمای نصب برنامه', 1500),
        deliveryKinds: [],
        protocols: [],
        providerTypes: [],
        status: 'ENABLED',
      }) as unknown as ClientAppRecord,
  );
}

const clock: Clock = { now: () => NOW };

function deps(over: {
  articles?: ArticleRow[];
  apps?: ClientAppRecord[];
  faqs?: { id: string; question: string; answer: string }[];
}): SupportContextBuilderDeps {
  return {
    customers: { findById: async () => null as unknown as CustomerRecord },
    services: { supportServicesForCustomer: async () => [] },
    reader: {
      recentOrders: async () => [],
      recentPayments: async () => ({ items: [], anyUnderReview: false }),
      activeIncidentNotices: async () => [],
      anyUnreconciledService: async () => false,
      serviceCardFacts: async () => [],
    },
    clientApps: { list: async () => over.apps ?? [] },
    serviceFacts: { factsOf: async () => [] },
    faqs: { list: async () => (over.faqs ?? []) as never },
    knowledge: {
      activeForContext: async (_scope, limit) => (over.articles ?? []).slice(0, limit),
    },
    settings: { valueOf: async <T>() => ['@support'] as unknown as T },
    clock,
  } as SupportContextBuilderDeps;
}

describe('D2 — relevance', () => {
  it('folds Persian spelling variants to one form', () => {
    expect(foldForMatching(`نمی${ZWNJ}شود`)).toBe('نمیشود');
    expect(foldForMatching('كيف')).toBe(foldForMatching('کیف'));
    expect(foldForMatching('۱۲۳')).toBe('123');
    expect(matchTerms('سلام، سرویس من وصل نمیشه')).toEqual(new Set(['سرویس', 'وصل']));
  });

  it('the connection article ranks first for a connection question, though it is the oldest', () => {
    const ranked = selectRelevantKnowledge(realisticArticles(), 'سلام، سرویس من وصل نمیشه', 20);
    expect(ranked[0]?.title).toMatch(/^وصل نمی/u);
  });

  it('a tag counts: «قطعی» finds the article tagged with it', () => {
    const ranked = selectRelevantKnowledge(realisticArticles(), 'قطعی دارم', 3);
    expect(ranked[0]?.title).toMatch(/^وصل نمی/u);
  });

  it('A8: no match, or no query, selects nothing — a zero score is never sent', () => {
    const rows = realisticArticles();
    expect(selectRelevantKnowledge(rows, '', 20)).toEqual([]);
    expect(selectRelevantKnowledge(rows, 'zzz qqq', 5)).toEqual([]);
    expect(selectRelevantKnowledge(rows, [], 5)).toEqual([]);
  });

  it('A8: a weak match is kept and an unmatched entry is not, however few match', () => {
    const rows = realisticArticles();
    // «نصب» matches the four installation articles only; the other sixteen score zero.
    const ranked = selectRelevantKnowledge(rows, 'نصب', 20).map((r) => r.title);
    expect(ranked).toEqual(['نصب روی تلویزیون', 'نصب روی ویندوز', 'نصب روی آیفون', 'نصب روی مک']);
  });

  it('equal scores keep the given order (deterministic)', () => {
    const rows = realisticArticles();
    const once = selectRelevantKnowledge(rows, 'نصب روی', 20).map((r) => r.title);
    expect(selectRelevantKnowledge(rows, 'نصب روی', 20).map((r) => r.title)).toEqual(once);
    expect(once.slice(0, 2)).toEqual(['نصب روی تلویزیون', 'نصب روی ویندوز']);
  });

  it('the query is the customer’s latest messages, oldest first', () => {
    expect(
      latestCustomerWords([
        { origin: 'INBOUND', text: 'a' },
        { origin: 'OWN_ECHO', text: 'reply' },
        { origin: 'INBOUND', text: 'b' },
        { origin: 'INBOUND', text: null },
        { origin: 'INBOUND', text: 'c' },
        { origin: 'INBOUND', text: 'd' },
      ]),
    ).toBe('b\nc\nd');
  });
});

describe('D2 — the knowledge reserve in the byte budget', () => {
  function bigPayload(): SupportContextPayload {
    return {
      generatedAt: NOW.toISOString(),
      customer: null,
      services: [],
      orders: Array.from({ length: 5 }, (_, i) => ({
        alias: `O${String(i + 1)}`,
        state: 'PAID' as const,
        purpose: 'NEW_SERVICE' as const,
        title: 'ب'.repeat(256),
        total: { amountMinor: '250000', currency: 'IRT' as const },
        createdAt: NOW.toISOString(),
        settledAt: null,
        expiresAt: null,
      })),
      payments: [],
      clientApps: [],
      incidents: [],
      knowledge: Array.from({ length: 8 }, (_, i) => ({
        alias: `K${String(i + 1)}`,
        source: 'KNOWLEDGE' as const,
        question: `k${String(i)}`,
        answer: persian('متن', 2500),
      })),
      supportAccounts: [],
      flags: {
        hasUnderReviewPayment: false,
        hasUnreconciledService: false,
        identityLinked: false,
        customerBlocked: false,
      },
    };
  }

  it('knowledge is cut only down to its reserve before account facts give way', () => {
    const big = bigPayload();
    expect(payloadBytes(big)).toBeGreaterThan(SUPPORT_CONTEXT_MAX_BYTES);
    const fitted = fitPayload(big);
    expect(payloadBytes(fitted)).toBeLessThanOrEqual(SUPPORT_CONTEXT_MAX_BYTES);
    // The orders are small enough to stay beside the reserve; knowledge keeps its share.
    expect(fitted.orders).toEqual(big.orders);
    const knowledgeBytes = new TextEncoder().encode(JSON.stringify(fitted.knowledge)).length;
    expect(knowledgeBytes).toBeGreaterThan(SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES / 2);
    expect(fitted.knowledge[0]?.question).toBe('k0');
  });

  it('under a budget that holds only the reserve, every other family goes first', () => {
    const big = bigPayload();
    const fitted = fitPayload(big, 10 * 1024);
    expect(payloadBytes(fitted)).toBeLessThanOrEqual(10 * 1024);
    // The orders gave way, and knowledge stopped at its reserve: the largest prefix within it.
    expect(fitted.orders.length).toBeLessThan(big.orders.length);
    const bytes = (n: number) =>
      new TextEncoder().encode(JSON.stringify(big.knowledge.slice(0, n))).length;
    const kept = fitted.knowledge.length;
    expect(fitted.knowledge).toEqual(big.knowledge.slice(0, kept));
    expect(bytes(kept)).toBeLessThanOrEqual(SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES);
    expect(bytes(kept + 1)).toBeGreaterThan(SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES);
  });

  it('the first entry survives even when it alone is larger than the reserve', () => {
    const big = {
      ...bigPayload(),
      knowledge: [
        {
          alias: 'K1',
          source: 'KNOWLEDGE' as const,
          question: 'first',
          answer: persian('اول', 4000),
        },
        {
          alias: 'K2',
          source: 'KNOWLEDGE' as const,
          question: 'second',
          answer: persian('دوم', 4000),
        },
      ],
    };
    const fitted = fitPayload(big, 12 * 1024);
    expect(fitted.knowledge.map((k) => k.question)).toEqual(['first']);
  });

  it('the reserve itself gives way last, so the result always fits', () => {
    const fitted = fitPayload(bigPayload(), 1024);
    expect(payloadBytes(fitted)).toBeLessThanOrEqual(1024);
    expect(fitted.knowledge).toEqual([]);
  });
});

describe('D2 — the builder over realistic sizes', () => {
  it('the relevant, OLDEST of twenty long articles reaches the model beside six long app guides', async () => {
    const builder = new SupportContextBuilder(
      deps({ articles: realisticArticles(), apps: apps(6) }),
    );
    // Before D2: no query, newest first, knowledge cut first — the article never arrived.
    const built = await builder.build(scope, null, { query: 'سلام، سرویس من وصل نمیشه' });
    expect(payloadBytes(built.payload)).toBeLessThanOrEqual(SUPPORT_CONTEXT_MAX_BYTES);
    expect(built.payload.knowledge[0]?.question).toMatch(/^وصل نمی/u);
    expect(built.payload.knowledge.length).toBeGreaterThanOrEqual(2);
    expect(built.knowledgeAvailable).toBe(20);
  });

  it('the budget was really under pressure: the uncut candidates do not fit', async () => {
    const all = realisticArticles();
    const raw = new TextEncoder().encode(JSON.stringify(all)).length;
    expect(raw).toBeGreaterThan(SUPPORT_CONTEXT_MAX_BYTES * 2);
  });

  it('a client app whose guide a selected article carries is sent without its guide', async () => {
    const articles = [
      article('راهنمای App 1', 1200, { sourceType: 'CLIENT_APP', sourceKey: 'app-1' }),
      article('وصل نمی‌شود', 800),
    ];
    const built = await new SupportContextBuilder(deps({ articles, apps: apps(2) })).build(
      scope,
      null,
      { query: 'App 1 نصب' },
    );
    const byName = new Map(built.payload.clientApps.map((app) => [app.name, app]));
    expect(byName.get('App 1')?.guide).toBe('');
    expect(byName.get('App 2')?.guide.length).toBeGreaterThan(0);
    expect(built.payload.knowledge.some((k) => k.question === 'راهنمای App 1')).toBe(true);
  });

  it('a built FAQ article is read once, and the live FAQ joins the ranking', async () => {
    const built = await new SupportContextBuilder(
      deps({
        articles: [article('سؤال یک', 200, { sourceType: 'FAQ', sourceKey: 'faq-1' })],
        faqs: [
          { id: 'faq-1', question: 'سؤال یک', answer: 'پاسخ' },
          { id: 'faq-2', question: 'چطور اشتراک را به‌روز کنم', answer: 'از منوی سرویس' },
        ],
      }),
    ).build(scope, null, { query: 'سؤال درباره اشتراک به‌روز' });
    expect(built.knowledgeAvailable).toBe(2);
    expect(built.payload.knowledge.map((k) => [k.source, k.question])).toEqual([
      ['FAQ', 'چطور اشتراک را به‌روز کنم'],
      ['KNOWLEDGE', 'سؤال یک'],
    ]);
  });
});
