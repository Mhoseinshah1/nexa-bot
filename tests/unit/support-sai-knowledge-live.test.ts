import { describe, expect, it } from 'vitest';
import { SUPPORT_CONTEXT_FALLBACK_KNOWLEDGE, type SupportContextPayload } from '@nexa/contracts';
import {
  selectRelevantKnowledge,
  stem,
} from '../../apps/api/src/modules/commerce/support-context/domain/knowledge-relevance';
import {
  builtArticleTags,
  expandQueryText,
  normalizePersian,
} from '../../apps/api/src/modules/commerce/support-context/domain/persian-text';
import {
  accountFacts,
  fitPayload,
  payloadBytes,
  usageAgeText,
} from '../../apps/api/src/modules/commerce/support-context/domain/support-context-payload';
import { selectKnowledge } from '../../apps/api/src/modules/commerce/support-context/application/support-context.builder';
import { normalizeTitle } from '../../apps/api/src/modules/control/support-knowledge/domain/dedupe';
import {
  LEARNING_PLACEHOLDERS,
  detectSensitive,
  scrubSensitive,
} from '../../apps/api/src/modules/control/support-knowledge/domain/scrubber';
import { learningUserMessage } from '../../apps/api/src/modules/control/support-knowledge/domain/learning-prompt';
import {
  checkOutputPolicy,
  outputPolicyAllowanceFromContext,
} from '../../apps/api/src/modules/control/support-ai/domain/output-policy';
import {
  amountForms,
  livePriceFamily,
} from '../../apps/api/src/modules/control/support-ai/domain/price-family';
import {
  SUPPORT_KNOWLEDGE_REFRESH_DEBOUNCE_MS,
  refreshDecision,
} from '../../apps/api/src/modules/control/support-knowledge/application/support-knowledge-refresh';
import { buildSignature } from '../../apps/api/src/modules/control/support-knowledge/application/support-knowledge-build.service';
import {
  isResolvedAcknowledgement,
  resolvingReply,
} from '../../apps/api/src/modules/control/support-knowledge/application/support-learning.service';
import { parseBusinessMessage } from '../../apps/api/src/modules/commerce/business-chats/domain/telegram-business';

/**
 * Phase 4 PR-2 — live knowledge: retrieval (one normaliser, Finglish, synonyms, protected words,
 * the general fallback), the scrubber's business allowlist and learning placeholders, the live
 * price family the output validator reads, the precomputed account facts, the guides-first byte
 * budget, the refresh debounce, the resolving reply, and images sent as documents.
 */

const NOW = new Date('2026-11-01T12:00:00.000Z');

const CARD_ARTICLE = {
  title: 'پرداخت کارت به کارت',
  body: 'مبلغ را به کارت فروشگاه واریز کنید و رسید را در ربات بفرستید.',
  tags: [] as string[],
};
const CONNECTION_ARTICLE = {
  title: 'سرویس وصل نمی‌شود',
  body: 'برنامه را ببندید، اینترنت را خاموش و روشن کنید و اشتراک را به‌روزرسانی کنید.',
  tags: [] as string[],
};
const IOS_ARTICLE = {
  title: 'راهنمای نصب برنامه',
  body: 'برنامه را از فروشگاه نصب و لینک اشتراک را وارد کنید.',
  tags: builtArticleTags('CLIENT_APP', 'IOS'),
};
const RENEW_ARTICLE = { title: 'تمدید سرویس', body: 'از منوی سرویس‌های من.', tags: [] };

describe('retrieval — «کار نمی‌کنه», Finglish, synonyms, protected words', () => {
  it('«کار نمی‌کنه» does not match the card-payment article (کارت ≠ کار), and meets connection', () => {
    for (const query of ['کار نمی‌کنه', 'کار نمیکنه', 'سرویسم کار نمی‌کنه']) {
      const chosen = selectRelevantKnowledge([CARD_ARTICLE, CONNECTION_ARTICLE], query, 8);
      expect(chosen).not.toContain(CARD_ARTICLE);
      expect(chosen[0]).toBe(CONNECTION_ARTICLE);
    }
  });

  it('protected words are never stemmed into another word', () => {
    expect(stem(normalizePersian('کارت'))).toBe('کارت');
    expect(stem(normalizePersian('کارتم'))).toBe('کارت');
    expect(stem(normalizePersian('سرعت'))).toBe('سرعت');
    expect(stem(normalizePersian('قیمت'))).toBe('قیمت');
    // An ordinary inflection still is.
    expect(stem(normalizePersian('سرویسم'))).toBe('سرویس');
  });

  it('Finglish «vasl nemishe» meets the connection article', () => {
    const chosen = selectRelevantKnowledge(
      [CARD_ARTICLE, RENEW_ARTICLE, CONNECTION_ARTICLE],
      'vasl nemishe',
      8,
    );
    expect(chosen[0]).toBe(CONNECTION_ARTICLE);
    expect(expandQueryText('vasl nemishe')).toContain('وصل');
  });

  it('the VPN synonyms: «قطعه» and «iphone» find the articles that say it otherwise', () => {
    expect(selectRelevantKnowledge([CARD_ARTICLE, CONNECTION_ARTICLE], 'قطعه', 8)[0]).toBe(
      CONNECTION_ARTICLE,
    );
    expect(selectRelevantKnowledge([RENEW_ARTICLE, IOS_ARTICLE], 'روی iphone چطوری', 8)[0]).toBe(
      IOS_ARTICLE,
    );
    expect(selectRelevantKnowledge([RENEW_ARTICLE, IOS_ARTICLE], 'آیفون', 8)[0]).toBe(IOS_ARTICLE);
  });

  it('one normaliser for retrieval and dedupe: ۀ ؤ ي ك ئ, ZWNJ, diacritics, digits', () => {
    expect(normalizePersian('خانۀ مؤسسه‌ي كوچك ۱۲')).toBe('خانه موسسهی کوچک 12');
    expect(normalizeTitle('خانۀ مؤسسه')).toBe(normalizeTitle('خانه موسسه'));
    expect(normalizeTitle('نمی‌شود')).toBe(normalizeTitle('نمیشود'));
  });

  it('nothing scores: the first general entries go; a greeting still carries none', () => {
    const articles = [
      { title: 'الف', body: 'متن یک', tags: [], sourceType: null, sourceKey: null },
      { title: 'ب', body: 'متن دو', tags: [], sourceType: 'CLIENT_APP', sourceKey: 'app' },
      { title: 'پ', body: 'متن سه', tags: [], sourceType: null, sourceKey: null },
      { title: 'ت', body: 'متن چهار', tags: [], sourceType: null, sourceKey: null },
      { title: 'ث', body: 'متن پنج', tags: [], sourceType: null, sourceKey: null },
    ] as never;
    const fallback = selectKnowledge(articles, [], 'گزینه زرافه');
    expect(fallback.entries.map((entry) => entry.question)).toEqual(['الف', 'پ', 'ت']);
    expect(fallback.entries).toHaveLength(SUPPORT_CONTEXT_FALLBACK_KNOWLEDGE);
    expect(selectKnowledge(articles, [], 'سلام وقت بخیر').entries).toEqual([]);
  });
});

describe('scrubber — the business allowlist', () => {
  const tutorial =
    'برنامه را از https://play.google.com/store/apps/details?id=com.v2ray.ang نصب کنید. هزینه پلن 150,000 تومان است.';
  const payment = 'مبلغ را به کارت 6037-9975-1234-5678 به نام فروشگاه واریز کنید.';

  it('a published tutorial keeps its link and its price; the strict scrub still refuses both', () => {
    expect(detectSensitive(tutorial)).toEqual(expect.arrayContaining(['URL_TOKEN', 'AMOUNT']));
    expect(detectSensitive(tutorial, { business: 'TUTORIAL' })).toEqual([]);
    expect(scrubSensitive(tutorial, { business: 'TUTORIAL' }).text).toContain(
      'https://play.google.com/store/apps/details?id=com.v2ray.ang',
    );
  });

  it('a card number only from a payment route’s published instructions', () => {
    expect(detectSensitive(payment, { business: 'PAYMENT_METHOD' })).toEqual([]);
    expect(detectSensitive(payment, { business: 'TUTORIAL' })).toEqual(['CARD']);
    expect(detectSensitive(payment, { business: 'FAQ' })).toEqual(['CARD']);
    expect(detectSensitive(payment)).toEqual(['CARD']);
  });

  it('never: a subscription link, a credential in a URL, a phone, an e-mail, a stranger’s handle', () => {
    for (const text of [
      'لینک https://panel.example.com/sub/abcDEF123',
      'vless://uuid@1.2.3.4:443',
      'https://admin:hunter2@panel.example.com/',
      'تماس: 09121234567',
      'ایمیل a@b.co',
      'پیام به @some_admin_name',
    ]) {
      expect(detectSensitive(text, { business: 'PAYMENT_METHOD' }).length).toBeGreaterThan(0);
    }
  });

  it('learning from a chat: amounts and public links become placeholders, still reported', () => {
    const message = learningUserMessage({
      transcript: [{ side: 'customer', text: 'قیمت چنده؟' }],
      reply: 'پلن یک‌ماهه ۲۵۰ هزار تومان است؛ برنامه از https://example.com/app دانلود شود.',
    });
    expect(message.text).toContain(LEARNING_PLACEHOLDERS.AMOUNT);
    expect(message.text).toContain(LEARNING_PLACEHOLDERS.LINK);
    expect(message.text).not.toMatch(/250|۲۵۰|example\.com/u);
    expect(message.scrubbedKinds).toEqual(expect.arrayContaining(['AMOUNT', 'HOST']));
    // A placeholder in a model's lesson is clean.
    expect(detectSensitive(`قیمت ${LEARNING_PLACEHOLDERS.AMOUNT} است`)).toEqual([]);
  });
});

function pricedPayload(over: Partial<SupportContextPayload> = {}): SupportContextPayload {
  return {
    generatedAt: NOW.toISOString(),
    customer: null,
    services: [],
    orders: [],
    payments: [],
    clientApps: [],
    incidents: [],
    knowledge: [],
    catalogue: [
      {
        alias: 'C1',
        title: 'یک‌ماهه ۵۰ گیگ',
        duration: '30 روز',
        traffic: '50 گیگابایت',
        deviceLimit: 2,
        locations: null,
        price: { amountMinor: '150000', currency: 'IRT', formatted: '150,000 تومان' },
        renewalPrice: { amountMinor: '140000', currency: 'IRT', formatted: '140,000 تومان' },
        personalDiscountPercent: null,
      },
    ],
    addons: [],
    supportAccounts: [],
    flags: {
      hasUnderReviewPayment: false,
      hasUnreconciledService: false,
      identityLinked: false,
      customerBlocked: false,
    },
    ...over,
  };
}

describe('the live price family in the output validator', () => {
  it('admits each amount in its own forms, and nothing else', () => {
    expect(amountForms('150000', 'IRT')).toEqual(['150000', '1500000', '150', '1500']);
    const family = livePriceFamily(pricedPayload());
    expect(family.has('150000')).toBe(true);
    expect(family.has('1500000')).toBe(true);
    expect(family.has('140000')).toBe(true);
    expect(family.has('160000')).toBe(false);
  });

  it('a quoted price passes, the same price in rials passes through the family, an invented one fails', () => {
    const payload = pricedPayload();
    const json = JSON.stringify(payload);
    const withFamily = outputPolicyAllowanceFromContext(json, {
      priceFamily: livePriceFamily(payload),
    });
    const ok = (text: string) => checkOutputPolicy(text, withFamily, NOW);
    expect(ok('قیمت پلن یک‌ماهه 150,000 تومان است.')).toEqual({ ok: true });
    expect(ok('قیمت پلن یک‌ماهه ۱۵۰٬۰۰۰ تومان است.')).toEqual({ ok: true });
    expect(ok('تمدید آن 140,000 تومان است.')).toEqual({ ok: true });
    // The same amount in rials is in the context only through the price family.
    expect(ok('معادل 1,500,000 ریال.')).toEqual({ ok: true });
    expect(
      checkOutputPolicy('معادل 1,500,000 ریال.', outputPolicyAllowanceFromContext(json), NOW),
    ).toEqual({ ok: false, violation: 'number' });
    // An invented price never passes.
    expect(ok('قیمت پلن یک‌ماهه 160,000 تومان است.')).toEqual({ ok: false, violation: 'number' });
    expect(ok('فقط 99,000 تومان!')).toEqual({ ok: false, violation: 'number' });
  });

  it('the customer’s own amounts are members too', () => {
    const family = livePriceFamily(
      pricedPayload({
        catalogue: [],
        orders: [
          {
            alias: 'O1',
            state: 'PAID',
            purpose: 'NEW_SERVICE',
            title: 'x',
            total: { amountMinor: '275000', currency: 'IRT', formatted: '275,000 تومان' },
            createdAt: NOW.toISOString(),
            settledAt: null,
            expiresAt: null,
          },
        ],
      }),
    );
    expect(family.has('275000')).toBe(true);
    expect(family.has('150000')).toBe(false);
  });
});

describe('precomputed account facts', () => {
  const presentation = { timezone: 'Asia/Tehran', calendar: 'jalali' } as const;

  it('GB left, whole days left (rounded up), the Jalali expiry and the usage age', () => {
    const facts = accountFacts(
      {
        trafficLimitBytes: 50n * 1024n ** 3n,
        trafficUsedBytes: 12n * 1024n ** 3n + 512n * 1024n ** 2n,
        usageSyncedAt: new Date(NOW.getTime() - 5 * 60_000),
        expiresAt: new Date(NOW.getTime() + 2 * 86_400_000 + 3_600_000),
      },
      NOW,
      presentation,
    );
    expect(facts).toEqual({
      remainingTraffic: '37.5 گیگابایت',
      daysLeft: 3,
      expiresOn: '1405/08/12',
      usageAge: 'به‌روزشده 5 دقیقه پیش',
    });
  });

  it('unknown stays unknown, a past expiry is zero days', () => {
    const facts = accountFacts(
      {
        trafficLimitBytes: 0n,
        trafficUsedBytes: 0n,
        usageSyncedAt: null,
        expiresAt: new Date(NOW.getTime() - 1000),
      },
      NOW,
      presentation,
    );
    expect(facts.remainingTraffic).toBeNull();
    expect(facts.usageAge).toBeNull();
    expect(facts.daysLeft).toBe(0);
    expect(usageAgeText(new Date(NOW.getTime() - 3 * 3_600_000), NOW)).toBe('به‌روزشده 3 ساعت پیش');
  });
});

describe('the byte budget: an app’s guide goes before its links', () => {
  it('guides are emptied first; every app keeps its official and help link', () => {
    const app = (i: number) => ({
      platform: 'ANDROID' as const,
      name: `App ${String(i)}`,
      description: 'd',
      guide: 'ر'.repeat(1500),
      helpUrl: `https://help.example.com/${String(i)}`,
      officialUrl: `https://example.com/app${String(i)}`,
    });
    const payload = pricedPayload({
      clientApps: [1, 2, 3, 4, 5, 6].map(app),
      knowledge: Array.from({ length: 8 }, (_, i) => ({
        alias: `K${String(i + 1)}`,
        source: 'KNOWLEDGE' as const,
        question: `q${String(i)}`,
        answer: 'ا'.repeat(2400),
      })),
    });
    const fitted = fitPayload(payload, 40 * 1024);
    expect(payloadBytes(fitted)).toBeLessThanOrEqual(40 * 1024);
    expect(fitted.clientApps.length).toBe(6);
    expect(fitted.clientApps.every((entry) => entry.officialUrl !== null)).toBe(true);
    expect(fitted.clientApps.some((entry) => entry.guide === '')).toBe(true);
    // At least five knowledge answers of the clipped length fit beside them.
    expect(fitted.knowledge.length).toBeGreaterThanOrEqual(5);
  });
});

describe('the automatic refresh — debounce and signature', () => {
  it('waits for the same change to be stable for two minutes; the nightly pass does not wait', () => {
    expect(refreshDecision({ signature: null, seen: null, now: 0, nightly: true })).toBe('IDLE');
    expect(refreshDecision({ signature: 'a', seen: null, now: 0, nightly: false })).toBe('WAIT');
    const seen = { signature: 'a', since: 0 };
    expect(
      refreshDecision({
        signature: 'a',
        seen,
        now: SUPPORT_KNOWLEDGE_REFRESH_DEBOUNCE_MS - 1,
        nightly: false,
      }),
    ).toBe('WAIT');
    expect(
      refreshDecision({
        signature: 'a',
        seen,
        now: SUPPORT_KNOWLEDGE_REFRESH_DEBOUNCE_MS,
        nightly: false,
      }),
    ).toBe('REFRESH');
    // Still editing: a new signature restarts the wait.
    expect(refreshDecision({ signature: 'b', seen, now: 10 * 60_000, nightly: false })).toBe(
      'WAIT',
    );
    expect(refreshDecision({ signature: 'b', seen, now: 1, nightly: true })).toBe('REFRESH');
  });

  it('the signature ignores UNCHANGED and moves with the article revision', () => {
    const item = {
      sourceType: 'FAQ' as const,
      sourceKey: 'f1',
      content: { title: 't', body: 'b', category: 'GENERAL' as const, tags: [] },
    };
    expect(buildSignature([{ item, kind: 'UNCHANGED', hash: 'h', article: null }])).toBeNull();
    const first = buildSignature([
      { item, kind: 'UPDATE', hash: 'h', article: { id: 'a1', revision: 1 } },
    ]);
    const again = buildSignature([
      { item, kind: 'UPDATE', hash: 'h', article: { id: 'a1', revision: 3 } },
    ]);
    expect(first).not.toBeNull();
    expect(again).not.toBe(first);
  });
});

describe('learning — the reply that resolved the conversation', () => {
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

  it('the person’s reply before the customer’s «مرسی درست شد», never the «خواهش می‌کنم» after', () => {
    const replies = [
      { id: 'r1', createdAt: at(1) },
      { id: 'r2', createdAt: at(5) },
      { id: 'r3', createdAt: at(9) },
    ];
    const lines = [
      { origin: 'INBOUND', text: 'وصل نمیشه', sentAt: at(0) },
      { origin: 'INBOUND', text: 'مرسی درست شد', sentAt: at(7) },
    ];
    expect(resolvingReply(replies, lines)?.id).toBe('r2');
    // No acknowledgement: the latest reply.
    expect(resolvingReply(replies, lines.slice(0, 1))?.id).toBe('r3');
    expect(resolvingReply([], lines)).toBeNull();
  });

  it('acknowledgements in Persian, Finglish and English', () => {
    for (const text of [
      'ممنون حل شد',
      'مرسي',
      'mersi dorost shod',
      'thanks, works now',
      'وصل شد',
    ]) {
      expect(isResolvedAcknowledgement(text)).toBe(true);
    }
    for (const text of ['هنوز وصل نمیشه', 'قیمت چنده؟', null]) {
      expect(isResolvedAcknowledgement(text)).toBe(false);
    }
  });
});

describe('vision — an image sent as a document counts', () => {
  const base = {
    message_id: 7,
    business_connection_id: 'bc',
    chat: { id: 42, type: 'private' },
    from: { id: 42 },
    date: 1_760_000_000,
  };

  it('a jpg/png/webp document is a PHOTO with its file reference; a PDF is not', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      const parsed = parseBusinessMessage({
        ...base,
        caption: 'این خطا را می‌دهد',
        document: { file_id: 'F1', file_unique_id: 'U1', file_size: 1234, mime_type: mime },
      });
      expect(parsed?.kind).toBe('PHOTO');
      expect(parsed?.photo).toEqual({ fileId: 'F1', fileUniqueId: 'U1', fileSize: 1234 });
      expect(parsed?.text).toBe('این خطا را می‌دهد');
    }
    const pdf = parseBusinessMessage({
      ...base,
      document: { file_id: 'F2', file_unique_id: 'U2', mime_type: 'application/pdf' },
    });
    expect(pdf?.kind).toBe('OTHER');
    expect(pdf?.photo).toBeNull();
  });
});
