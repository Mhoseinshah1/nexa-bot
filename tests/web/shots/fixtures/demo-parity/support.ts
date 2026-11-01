import {
  SUPPORT_AI_DEFAULT_CONFIG,
  businessChatListResponseSchema,
  businessConnectionListResponseSchema,
  supportAiConfigResponseSchema,
  supportAiUsageResponseSchema,
  supportAnalyticsResponseSchema,
  supportFaqListSchema,
  supportKnowledgeArticleViewSchema,
  supportKnowledgeBuildViewSchema,
  supportLearningCandidateViewSchema,
  ticketCategoryListResponseSchema,
  ticketListResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type Parser, type ShotFixture } from '../../fixture.ts';

/*
 * DEMO PARITY — the support half of the customers family: tickets, FAQs, Telegram Business
 * chats, the support AI's settings, analytics, knowledge, its build and the learning queue,
 * each fed the approved demo's own sample rows (`approved-demo.html#/tickets`, `#/support`,
 * `#/business-chats`, `#/support-ai`, `#/support-analytics`, `#/support-knowledge`,
 * `#/knowledge-build`), so the side-by-sides compare like with like and every state a DIFFS
 * bullet names is drawn: a chat with a ticket, a provider set aside and one whose key was
 * rejected, a backup step in the chain, a conflicting proposal and a retired one.
 *
 * Model ids are neutral placeholders: only what the API has a field for. Every body is parsed
 * by its response schema in `tests/web/customers-parity-fixtures.test.tsx`.
 */

type Json = Record<string, unknown>;

function uid(prefix: string, index: number): string {
  return `${prefix}-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`;
}

/** A list envelope `{ [field]: item[] }`, parsed item by item — the client's own `listOf`. */
function listOf(field: string, item: Parser): Parser {
  return {
    parse(value: unknown): unknown {
      const rows = (value as Record<string, unknown> | null)?.[field];
      if (!Array.isArray(rows)) throw new Error(`no list "${field}"`);
      return { [field]: rows.map((row) => item.parse(row)) };
    },
  };
}

/** `{ build: view | null }`, as `fetchKnowledgeBuild` reads it. */
const buildEnvelope: Parser = {
  parse(value: unknown): unknown {
    const build = (value as { build?: unknown } | null)?.build;
    if (build === undefined) throw new Error('no build');
    return { build: build === null ? null : supportKnowledgeBuildViewSchema.parse(build) };
  },
};

const DAY = 60 * 24;

// --- tickets (`#/tickets`) -----------------------------------------------------------------

const CATEGORY = {
  connection: uid('019e10ab', 0),
  wallet: uid('019e10ab', 1),
  renew: uid('019e10ab', 2),
  partners: uid('019e10ab', 3),
  other: uid('019e10ab', 4),
};

const TICKET_CATEGORIES = (
  [
    [CATEGORY.connection, 'مشکل اتصال', 10, true],
    [CATEGORY.wallet, 'پرداخت و کیف پول', 20, true],
    [CATEGORY.renew, 'خرید و تمدید', 30, true],
    [CATEGORY.partners, 'همکاری و نمایندگی', 40, false],
    [CATEGORY.other, 'سایر', 90, true],
  ] as const
).map(([id, title, sortOrder, isActive]) => ({
  id,
  title,
  sortOrder,
  isActive,
  createdAt: ago(DAY * 90),
  updatedAt: ago(DAY * 90),
}));

const TITLE_OF: Record<string, string> = Object.fromEntries(
  TICKET_CATEGORIES.map((one) => [one.id, one.title]),
);

const TICKETS = (
  [
    [
      2310,
      null,
      CATEGORY.wallet,
      'OPEN',
      'HIGH',
      'پویا شریفی',
      'pooya_sh',
      '999546491',
      null,
      76,
      112,
    ],
    [
      2301,
      'سرویسم وصل نمی‌شود',
      CATEGORY.connection,
      'OPEN',
      'LOW',
      'سارا محمدی',
      'sara.mhd',
      '959498386',
      'm.hosein',
      148,
      148,
    ],
    [
      2302,
      'پرداخت کردم ولی سرویس نیامد',
      CATEGORY.wallet,
      'WAITING_FOR_SUPPORT',
      'HIGH',
      'مهدی کریمی',
      'mehdi_k',
      '504271451',
      'sara.sup',
      250,
      321,
    ],
    [
      2303,
      'چطور تمدید کنم؟',
      CATEGORY.renew,
      'OPEN',
      'NORMAL',
      'نگار احمدی',
      'negar_a',
      '495954583',
      null,
      494,
      494,
    ],
    [
      2304,
      'سرعت خیلی کم شده',
      CATEGORY.connection,
      'WAITING_FOR_SUPPORT',
      'LOW',
      'حسین موسوی',
      'hosein_m',
      '319675910',
      'sara.sup',
      618,
      667,
    ],
    [
      2305,
      'درخواست بازگشت وجه',
      CATEGORY.wallet,
      'WAITING_FOR_CUSTOMER',
      'URGENT',
      'زهرا جعفری',
      'zahra_j',
      '982530490',
      null,
      808,
      840,
    ],
    [
      2306,
      'تغییر لوکیشن به هلند',
      CATEGORY.connection,
      'WAITING_FOR_CUSTOMER',
      'NORMAL',
      'امیر حسینی',
      'amir_h',
      '767614693',
      'sara.sup',
      900,
      1013,
    ],
    [
      2307,
      'کد تخفیف کار نمی‌کند',
      CATEGORY.renew,
      'CLOSED',
      'LOW',
      'مریم صادقی',
      'maryam_s',
      '584332434',
      null,
      1133,
      1186,
    ],
    [
      2308,
      'لینک اشتراک باز نمی‌شود',
      CATEGORY.connection,
      'CLOSED',
      'NORMAL',
      'رضا نوری',
      'reza_n',
      '872170802',
      'sara.sup',
      1317,
      1359,
    ],
    [
      2309,
      'فاکتور می‌خواهم',
      CATEGORY.wallet,
      'CLOSED',
      'NORMAL',
      'فاطمه کاظمی',
      'fateme_k',
      '403962768',
      null,
      1501,
      1532,
    ],
  ] as const
).map(
  (
    [number, subject, categoryId, status, priority, name, username, telegram, admin, last, created],
    index,
  ) => ({
    id: uid('019e20ab', index),
    source: 'NEXA',
    number,
    status,
    priority,
    categoryId,
    categoryTitle: TITLE_OF[categoryId],
    subject,
    customerId: uid('019d10ab', index),
    customerTelegramUserId: telegram,
    customerUsername: username,
    customerDisplayName: name,
    assignedAdminId: admin === null ? null : uid('019e30ab', index),
    assignedAdminUsername: admin,
    serviceId: null,
    orderId: null,
    paymentId: null,
    createdAt: ago(created),
    updatedAt: ago(last),
    lastMessageAt: ago(last),
    closedAt: status === 'CLOSED' ? ago(last - 5) : null,
  }),
);

// --- FAQs (`#/support`) --------------------------------------------------------------------

const FAQS = (
  [
    [
      'چطور سرویس بخرم؟',
      'از منوی ربات «🛒 خرید سرویس» را بزنید، پلن را انتخاب و پرداخت کنید. سرویس پس از تأیید پرداخت خودکار تحویل می‌شود.',
      true,
    ],
    ['روش‌های پرداخت چیست؟', 'کارت‌به‌کارت، کیف پول، درگاه آنلاین و استارز.', true],
    ['بازگشت وجه دارید؟', 'بازگشت وجه فقط به کیف پول و طبق قوانین انجام می‌شود.', false],
    [
      'لینک اشتراک را کجا وارد کنم؟',
      'از «سرویس‌های من» لینک را کپی کنید و در برنامهٔ اتصال (v2rayNG، Streisand، Hiddify) وارد کنید.',
      true,
    ],
    [
      'چرا سرویسم وصل نمی‌شود؟',
      'یک بار لینک اشتراک را به‌روزرسانی کنید و اینترنت دیگری را امتحان کنید. اگر وصل نشد از «پشتیبانی» تیکت ثبت کنید.',
      true,
    ],
    ['حجمم تمام شد، چه کنم؟', 'از «سرویس‌های من» گزینهٔ «افزایش حجم» یا «تمدید» را بزنید.', true],
    ['چند دستگاه می‌توانم وصل کنم؟', 'به اندازهٔ تعداد دستگاهی که در پلن نوشته شده است.', true],
    ['سرویس آزمایشی دارید؟', 'بله، یک بار برای هر حساب: ۲۴ ساعت با ۱ گیگ حجم.', false],
    [
      'لوکیشن سرویس را چطور عوض کنم؟',
      'از «سرویس‌های من» ← «تغییر لوکیشن». ممکن است هزینه داشته باشد.',
      true,
    ],
  ] as const
).map(([question, answer, active], index) => ({
  id: uid('019e40ab', index),
  question,
  answer,
  status: active ? 'ACTIVE' : 'INACTIVE',
  sortOrder: (index + 1) * 10,
  version: 1,
  createdAt: ago(DAY * 40),
  updatedAt: ago(DAY * (6 - index * 0.5)),
}));

// --- Telegram Business chats (`#/business-chats`) ------------------------------------------

const CHATS = (
  [
    [
      'پویا',
      'pooya_sh',
      '999546491',
      'HANDOFF_REQUIRED',
      'HANDOFF_TOPIC',
      26,
      'پیام شما به همکاران پشتیبانی سپرده شد؛ به‌زودی پاسخ می‌دهند.',
      true,
      112,
    ],
    [
      'الهام',
      'elham_q',
      '673267723',
      'HANDOFF_REQUIRED',
      'HUMAN_REQUESTED',
      31,
      'می‌خوام با پشتیبان حرف بزنم',
      false,
      119,
    ],
    [
      'بهنام',
      'behnam_t',
      '719319299',
      'HUMAN_ACTIVE',
      'AI_UNAVAILABLE',
      15,
      'ممنون، منتظرم',
      false,
      103,
    ],
    [
      'کیان',
      'kian_f',
      '484648889',
      'AI_ACTIVE',
      null,
      null,
      'سلام! یک‌ماهه ۵۰ گیگ آلمان ۳۱۰٬۰۰۰ تومان است. برای خرید از منوی ربات «خرید سرویس» را بزنید.',
      false,
      107,
    ],
    [
      'ندا',
      'neda_r',
      '291406883',
      'AI_ACTIVE',
      null,
      null,
      'برای اندروید برنامهٔ v2rayNG یا Hiddify را نصب کنید و همان لینک اشتراک را وارد کنید.',
      false,
      110,
    ],
    [
      'لیلا',
      'leila_ak',
      '542733367',
      'AI_ACTIVE',
      null,
      null,
      'سلام! چطور می‌توانم کمک کنم؟',
      false,
      131,
    ],
  ] as const
).map(([name, username, telegram, state, reason, wait, preview, ticket, last], index) => ({
  id: uid('019e50ab', index),
  state,
  takeoverReason: state === 'HUMAN_ACTIVE' ? 'OPERATOR_TAKEOVER' : null,
  handoffReason: reason,
  peerTelegramUserId: telegram,
  customer: { id: uid('019e51ab', index), username, firstName: name },
  connectionStatus: 'ACTIVE',
  lastMessageAt: ago(last),
  lastInboundAt: ago(last + 1),
  preview,
  unansweredSince: wait === null ? null : ago(wait),
  ticketId: ticket ? uid('019e20ab', 0) : null,
}));

const CONNECTIONS = (
  [
    ['5871203344', 'ACTIVE', DAY * 43, 91, ['can_read_messages', 'can_reply']],
    ['6120098871', 'RIGHTS_INSUFFICIENT', DAY * 6, 60 * 10, ['can_read_messages']],
    ['5871203344', 'SUPERSEDED', DAY * 58, DAY * 43, ['can_read_messages', 'can_reply']],
  ] as const
).map(([owner, status, connected, confirmed, rights], index) => ({
  id: uid('019e60ab', index),
  botInstanceId: '01900000-0000-7000-8000-00000000b001',
  ownerTelegramUserId: owner,
  status,
  rights,
  connectedAt: ago(connected),
  lastConfirmedAt: ago(confirmed),
}));

// --- the support AI (`#/support-ai`) -------------------------------------------------------

const MODEL = { OPENAI: 'gpt-4.1-mini', ANTHROPIC: 'fast-v1', ZAI: 'glm-4.6' } as const;

const SUPPORT_AI_CONFIG = {
  config: {
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'AUTO_REPLY_SAFE',
    primary: { provider: 'OPENAI', model: MODEL.OPENAI },
    fallbacks: [{ provider: 'ANTHROPIC', model: MODEL.ANTHROPIC }],
    visionEnabled: true,
    settleDelaySeconds: 8,
    autoTopics: [
      'CONNECTION_TROUBLESHOOTING',
      'APP_SETUP',
      'SUBSCRIPTION_UPDATE',
      'PLAN_INFO',
      'GREETING',
    ],
    toneInstructions:
      'دوستانه، کوتاه و محترمانه؛ مشتری را «شما» خطاب کنید و از اصطلاحات فنی پرهیز کنید.',
  },
  version: 7,
  credentials: [
    {
      provider: 'OPENAI',
      configured: true,
      setAt: ago(DAY * 25),
      region: null,
      trippedUntil: null,
      lastTestOutcome: 'OK',
      lastTestFailureClass: null,
      lastTestedAt: ago(60 * 5),
      breaker: 'CLOSED',
      consecutiveFailures: 0,
      rejectedAt: null,
    },
    {
      provider: 'ANTHROPIC',
      configured: true,
      setAt: ago(DAY * 13),
      region: null,
      trippedUntil: ago(-60 * 2),
      lastTestOutcome: 'RATE_LIMITED',
      lastTestFailureClass: 'rate_limited',
      lastTestedAt: ago(60 * 1),
      breaker: 'OPEN',
      consecutiveFailures: 4,
      rejectedAt: null,
    },
    {
      provider: 'ZAI',
      configured: true,
      setAt: ago(DAY * 4),
      region: 'CHINA',
      trippedUntil: null,
      lastTestOutcome: 'AUTH_FAILED',
      lastTestFailureClass: 'auth',
      lastTestedAt: ago(60 * 3),
      breaker: 'HALF_OPEN',
      consecutiveFailures: 2,
      rejectedAt: ago(60 * 3),
    },
  ],
  capabilities: {
    OPENAI: { structuredOutput: true, vision: true },
    ANTHROPIC: { structuredOutput: true, vision: true },
    ZAI: { structuredOutput: false, vision: false },
  },
  chainUnavailable: false,
};

const USAGE = {
  since: ago(DAY * 30),
  rows: (
    [
      ['OPENAI', 'AUTO_DECISION', 1284, 12, 1912400, 208300, 1430],
      ['OPENAI', 'ASSIST_DRAFT', 212, 3, 402800, 61200, 2210],
      ['OPENAI', 'SUMMARY', 96, 0, 88100, 9400, 960],
      ['OPENAI', 'LEARNING_EXTRACT', 38, 1, 51200, 7300, 1820],
      ['OPENAI', 'CONNECTION_TEST', 6, 0, 4100, 900, 1240],
      ['ANTHROPIC', 'AUTO_DECISION', 96, 31, 140300, 15800, 1610],
      ['ANTHROPIC', 'CONNECTION_TEST', 4, 2, 2700, 400, 980],
      ['ZAI', 'CONNECTION_TEST', 3, 3, 0, 0, 410],
    ] as const
  ).map(([provider, operation, calls, failures, inputTokens, outputTokens, avgLatencyMs]) => ({
    provider,
    model: MODEL[provider],
    operation,
    calls,
    failures,
    inputTokens,
    outputTokens,
    avgLatencyMs,
  })),
};

// --- support analytics (`#/support-analytics`, «۷ روز اخیر») ------------------------------

const ANALYTICS = {
  period: { range: 'LAST_7_DAYS', start: ago(DAY * 7), end: ago(0) },
  conversationsNow: [
    { state: 'AI_ACTIVE', count: 4 },
    { state: 'HUMAN_ACTIVE', count: 2 },
    { state: 'HANDOFF_REQUIRED', count: 2 },
    { state: 'PAUSED', count: 1 },
  ],
  handoffsByReason: [
    { reason: 'HANDOFF_TOPIC', count: 38 },
    { reason: 'HUMAN_REQUESTED', count: 21 },
    { reason: 'LOW_CONFIDENCE', count: 14 },
    { reason: 'TOPIC_NOT_ALLOWED', count: 11 },
    { reason: 'AI_UNAVAILABLE', count: 6 },
    { reason: 'LOOP_GUARD', count: 4 },
    { reason: 'CLARIFYING_LIMIT', count: 2 },
  ],
  auto: {
    sent: 412,
    handedOff: 96,
    dropped: 23,
    pending: 2,
    byOutcome: [
      { outcome: 'sent', count: 341 },
      { outcome: 'sent_clarifying', count: 71 },
      { outcome: 'guard_handoff_topic', count: 38 },
      { outcome: 'guard_human_requested', count: 21 },
      { outcome: 'guard_confidence', count: 14 },
      { outcome: 'guard_topic_allowlist', count: 11 },
      { outcome: 'handoff_ai_unavailable', count: 6 },
      { outcome: 'guard_clarifying_limit', count: 4 },
      { outcome: 'guard_window', count: 2 },
      { outcome: 'dropped_epoch', count: 12 },
      { outcome: 'dropped_coalesced', count: 9 },
      { outcome: 'dropped_mode', count: 2 },
    ],
  },
  assist: { requested: 58, sent: 37, discarded: 9, superseded: 4, failed: 5, open: 3 },
  providerRuns: [
    ['OPENAI', 'OK', 1460, 1180, 3900, 2180000, 250000],
    ['OPENAI', 'RATE_LIMITED', 14, 210, 640, 0, 0],
    ['OPENAI', 'TIMEOUT', 3, 30000, 30000, 5200, 0],
    ['ANTHROPIC', 'OK', 88, 1350, 4100, 131000, 14600],
    ['ANTHROPIC', 'RATE_LIMITED', 31, 190, 520, 0, 0],
    ['ZAI', 'AUTH_FAILED', 3, 380, 450, 0, 0],
  ].map(([provider, outcome, runs, p50, p95, input, output]) => ({
    provider,
    outcome,
    runs,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    inputTokens: input,
    outputTokens: output,
  })),
  aiFailures: [
    { operation: 'AUTO_DECISION', provider: 'OPENAI', failureClass: 'rate_limited', runs: 14 },
    { operation: 'AUTO_DECISION', provider: 'ANTHROPIC', failureClass: 'rate_limited', runs: 31 },
    { operation: 'ASSIST_DRAFT', provider: 'OPENAI', failureClass: 'timeout', runs: 3 },
    { operation: 'CONNECTION_TEST', provider: 'ZAI', failureClass: 'auth', runs: 3 },
    { operation: 'AUTO_DECISION', provider: 'OPENAI', failureClass: 'schema_invalid', runs: 2 },
  ],
  learningByState: [
    { state: 'PENDING', count: 5 },
    { state: 'APPROVED', count: 1 },
    { state: 'REJECTED', count: 2 },
  ],
  knowledgeBySource: [
    { source: 'MANUAL', state: 'APPROVED', enabled: true, count: 5 },
    { source: 'MANUAL', state: 'DRAFT', enabled: true, count: 1 },
    { source: 'MANUAL', state: 'RETIRED', enabled: true, count: 1 },
    { source: 'LEARNED', state: 'APPROVED', enabled: true, count: 2 },
    { source: 'LEARNED', state: 'APPROVED', enabled: false, count: 1 },
    { source: 'NEXA_BUILD', state: 'APPROVED', enabled: true, count: 27 },
  ],
};

// --- support knowledge (`#/support-knowledge`), the first ten of the demo's 37 -------------

const ARTICLES = (
  [
    [
      'خرید عمده برای نمایندگان',
      'برای خرید بیش از ۱۰ سرویس در یک ماه، با پشتیبانی فروش هماهنگ کنید تا تخفیف عمده اعمال شود.',
      'MANUAL',
      'DRAFT',
      'PLANS',
      0,
      488,
    ],
    [
      'پلن «یک‌ماهه ۵۰ گیگ — آلمان»',
      'یک‌ماهه ۵۰ گیگ — آلمان: ۳۰ روزه، ۵۰ گیگ، ۲ دستگاه، قیمت ۳۱۰٬۰۰۰ تومان.',
      'NEXA_BUILD',
      'APPROVED',
      'PLANS',
      1,
      DAY + 660,
    ],
    [
      'پلن «یک‌ماهه نامحدود — هلند»',
      'یک‌ماهه نامحدود — هلند: ۳۰ روزه، حجم نامحدود، ۲ دستگاه، قیمت ۴۲۰٬۰۰۰ تومان.',
      'NEXA_BUILD',
      'APPROVED',
      'PLANS',
      1,
      DAY + 660,
    ],
    [
      'پلن «سه‌ماهه ۱۵۰ گیگ — آلمان»',
      'سه‌ماهه ۱۵۰ گیگ — آلمان: ۹۰ روزه، ۱۵۰ گیگ، ۳ دستگاه، قیمت ۷۸۰٬۰۰۰ تومان. این پلن برای تماشای ویدیو مناسب است.',
      'NEXA_BUILD',
      'APPROVED',
      'PLANS',
      2,
      DAY + 660,
    ],
    [
      'پلن «یک‌ماهه ۳۰ گیگ — ترکیه»',
      'یک‌ماهه ۳۰ گیگ — ترکیه: ۳۰ روزه، ۳۰ گیگ، ۱ دستگاه، قیمت ۲۵۰٬۰۰۰ تومان.',
      'NEXA_BUILD',
      'APPROVED',
      'PLANS',
      1,
      DAY + 660,
    ],
    [
      'پلن «شش‌ماهه ۳۰۰ گیگ — هلند»',
      'شش‌ماهه ۳۰۰ گیگ — هلند: ۱۸۰ روزه، ۳۰۰ گیگ، ۳ دستگاه، قیمت ۱٬۴۵۰٬۰۰۰ تومان.',
      'NEXA_BUILD',
      'APPROVED',
      'PLANS',
      1,
      DAY + 660,
    ],
    [
      'پلن «هفتگی ۱۰ گیگ — آمریکا»',
      'هفتگی ۱۰ گیگ — آمریکا: ۷ روزه، ۱۰ گیگ، ۱ دستگاه، قیمت ۹۰٬۰۰۰ تومان.',
      'NEXA_BUILD',
      'APPROVED',
      'PLANS',
      1,
      DAY + 660,
    ],
    [
      'سرور آلمان',
      'سرور 🇩🇪 آلمان فعال است و تغییر لوکیشن به آن رایگان است.',
      'NEXA_BUILD',
      'APPROVED',
      'CONNECTION',
      1,
      DAY + 660,
    ],
    [
      'سرور هلند',
      'سرور 🇳🇱 هلند فعال است و تغییر لوکیشن به آن رایگان است.',
      'NEXA_BUILD',
      'APPROVED',
      'CONNECTION',
      1,
      DAY + 660,
    ],
    [
      'سرور ترکیه',
      'سرور 🇹🇷 ترکیه فعال است و تغییر لوکیشن به آن رایگان است.',
      'NEXA_BUILD',
      'APPROVED',
      'CONNECTION',
      1,
      DAY + 660,
    ],
  ] as const
).map(([title, body, source, state, category, revision, minutes], index) => ({
  id: uid('019e70ab', index),
  source,
  state,
  enabled: true,
  title,
  body,
  category,
  tags: [],
  revision,
  version: revision + 1,
  createdAt: ago(minutes + DAY),
  updatedAt: ago(minutes),
}));

// --- the knowledge build (`#/knowledge-build`) ---------------------------------------------

const proposal = (n: number, over: Json): Json => ({
  id: uid('019e80ab', n),
  sourceType: 'PRODUCT',
  kind: 'ADD',
  state: 'PENDING',
  title: '',
  body: '',
  category: 'PLANS',
  baseTitle: null,
  baseBody: null,
  baseRevision: null,
  articleId: null,
  resolution: null,
  ...over,
});

const BUILD = {
  build: {
    id: uid('019e90ab', 0),
    state: 'OPEN',
    createdAt: ago(DAY + 300),
    counts: { add: 3, update: 2, unchanged: 23, conflict: 1, retire: 1 },
    truncated: 0,
    capped: 0,
    proposals: [
      proposal(0, {
        kind: 'UPDATE',
        title: 'پلن «یک‌ماهه نامحدود — هلند»',
        body: 'یک‌ماهه نامحدود — هلند: ۳۰ روزه، حجم نامحدود، ۲ دستگاه، قیمت ۴۵۰٬۰۰۰ تومان.',
        baseTitle: 'پلن «یک‌ماهه نامحدود — هلند»',
        baseBody: 'یک‌ماهه نامحدود — هلند: ۳۰ روزه، حجم نامحدود، ۲ دستگاه، قیمت ۴۲۰٬۰۰۰ تومان.',
        baseRevision: 1,
        articleId: (ARTICLES[2] as Json)['id'],
      }),
      proposal(1, {
        kind: 'CONFLICT',
        title: 'پلن «سه‌ماهه ۱۵۰ گیگ — آلمان»',
        body: 'سه‌ماهه ۱۵۰ گیگ — آلمان: ۹۰ روزه، ۱۵۰ گیگ، ۳ دستگاه، قیمت ۷۸۰٬۰۰۰ تومان.',
        baseTitle: 'پلن «سه‌ماهه ۱۵۰ گیگ — آلمان»',
        baseBody:
          'سه‌ماهه ۱۵۰ گیگ — آلمان: ۹۰ روزه، ۱۵۰ گیگ، ۳ دستگاه، قیمت ۷۸۰٬۰۰۰ تومان. این پلن برای تماشای ویدیو مناسب است.',
        baseRevision: 2,
        articleId: (ARTICLES[3] as Json)['id'],
      }),
      proposal(2, {
        title: 'پلن «یک‌ماهه ۱۰۰ گیگ — فنلاند»',
        body: 'یک‌ماهه ۱۰۰ گیگ — فنلاند: ۳۰ روزه، ۱۰۰ گیگ، ۲ دستگاه، قیمت ۴۲۰٬۰۰۰ تومان.',
      }),
      proposal(3, {
        sourceType: 'FAQ',
        kind: 'UPDATE',
        category: 'GENERAL',
        title: 'لینک اشتراک را کجا وارد کنم؟',
        body: 'از «سرویس‌های من» لینک را کپی کنید و در برنامهٔ اتصال (v2rayNG، Streisand، Hiddify) وارد کنید.',
        baseTitle: 'لینک اشتراک را کجا وارد کنم؟',
        baseBody: 'از «سرویس‌های من» لینک را کپی کنید و در برنامهٔ اتصال.',
        baseRevision: 1,
        articleId: uid('019e70ab', 20),
      }),
      proposal(4, {
        sourceType: 'SUPPORT_ACCOUNTS',
        category: 'GENERAL',
        title: 'راه ارتباط با پشتیبانی',
        body: 'پشتیبانی از طریق حساب ‎@nexa_support‎ در تلگرام پاسخ می‌دهد.',
      }),
      proposal(5, {
        sourceType: 'PAYMENT_METHOD',
        category: 'PAYMENTS',
        title: 'پرداخت با درگاه آنلاین تون‌پی',
        body: 'درگاه آنلاین تون‌پی یکی از روش‌های پرداخت در ربات است؛ حداقل مبلغ ۱۰٬۰۰۰ تومان.',
      }),
      proposal(6, {
        sourceType: 'LOCATIONS',
        kind: 'RETIRE',
        category: 'CONNECTION',
        title: 'سرور آمریکا',
        body: 'سرور 🇺🇸 آمریکا فعال است و تغییر لوکیشن به آن ۳۰٬۰۰۰ تومان هزینه دارد.',
        baseTitle: 'سرور آمریکا',
        baseBody: 'سرور 🇺🇸 آمریکا فعال است و تغییر لوکیشن به آن ۳۰٬۰۰۰ تومان هزینه دارد.',
        baseRevision: 1,
        articleId: uid('019e70ab', 36),
      }),
    ],
  },
};

// --- the learning queue (`/support-learning`; the demo has no page of its own) -------------

const CANDIDATES = (
  [
    [
      'اتصال در اندروید پس از به‌روزرسانی',
      'برنامه را کامل ببندید، دوباره باز کنید و اشتراک را به‌روزرسانی کنید.',
      'CONNECTION',
      'HIGH',
      2,
      'در دو گفتگو همین پاسخ مشکل را حل کرد و به حساب مشتری بستگی ندارد.',
    ],
    [
      'تفاوت حجم و مدت سرویس',
      'سرویس با تمام شدن هر کدام زودتر برسد متوقف می‌شود؛ تمدید هر دو را تازه می‌کند.',
      'PLANS',
      'MEDIUM',
      1,
      'پرسش رایج است و پاسخ از قوانین فروش می‌آید.',
    ],
    [
      'تأیید رسید کارت‌به‌کارت',
      'رسید معمولاً کمتر از ۳۰ دقیقه در ساعات کاری بررسی می‌شود.',
      'PAYMENTS',
      'HIGH',
      3,
      'سه گفتگو با همین پرسش و همین پاسخ بسته شد.',
    ],
    [
      'وصل شدن در آیفون',
      'برنامهٔ Streisand یا V2Box را نصب و لینک اشتراک را وارد کنید.',
      'APPS',
      'MEDIUM',
      2,
      'پاسخ پشتیبان در دو گفتگو یکسان بود.',
    ],
    [
      'تغییر لوکیشن رایگان است؟',
      'برای بیشتر لوکیشن‌ها رایگان است؛ برخی هزینه دارند و در ربات نوشته شده است.',
      'ACCOUNT',
      'LOW',
      1,
      'یک گفتگو؛ هزینه به لوکیشن بستگی دارد.',
    ],
  ] as const
).map(([title, body, category, confidence, sourceCount, rationale], index) => ({
  id: uid('019ea0ab', index),
  state: 'PENDING',
  title,
  body,
  category,
  tags: [],
  rationale,
  confidence,
  rejectReason: null,
  sensitiveKinds: [],
  conversationId: uid('019e50ab', index % 3),
  sourceCount,
  provider: 'OPENAI',
  model: MODEL.OPENAI,
  articleId: null,
  replacesArticleId: null,
  assisted: false,
  version: 1,
  createdAt: ago(60 * (5 + index * 7)),
  reviewedAt: null,
}));

export const DEMO_SUPPORT_FAMILY: readonly ShotFixture[] = [
  fixture('/tickets', ticketListResponseSchema, {
    tickets: TICKETS,
    nextCursor: { at: TICKETS[9]?.createdAt, id: TICKETS[9]?.id },
  }),
  fixture('/ticket-categories', ticketCategoryListResponseSchema, {
    categories: TICKET_CATEGORIES,
  }),
  fixture('/support/faqs', supportFaqListSchema, { items: FAQS }),
  fixture('/business-chats', businessChatListResponseSchema, {
    conversations: CHATS,
    nextCursor: null,
  }),
  fixture('/business-connections', businessConnectionListResponseSchema, {
    connections: CONNECTIONS,
  }),
  fixture('/support-ai/config', supportAiConfigResponseSchema, SUPPORT_AI_CONFIG),
  fixture('/support-ai/usage', supportAiUsageResponseSchema, USAGE),
  fixture('/support-ai/analytics', supportAnalyticsResponseSchema, ANALYTICS),
  fixture('/support-knowledge/articles', listOf('articles', supportKnowledgeArticleViewSchema), {
    articles: ARTICLES,
  }),
  fixture(
    '/support-knowledge/candidates',
    listOf('candidates', supportLearningCandidateViewSchema),
    { candidates: CANDIDATES },
  ),
  fixture('/support-knowledge/builds/latest', buildEnvelope, BUILD),
];
