import {
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  SUPPORT_AI_DEFAULT_CONFIG,
  audiencePreviewResponseSchema,
  businessChatDetailResponseSchema,
  businessChatListResponseSchema,
  businessConnectionListResponseSchema,
  customerFinancialSummaryResponseSchema,
  customerOverviewResponseSchema,
  deliveryQrPreviewSchema,
  incidentDetailResponseSchema,
  incidentListResponseSchema,
  legacyMigrationCapabilitiesResponseSchema,
  supportAiConfigResponseSchema,
  supportAiDraftViewSchema,
  supportAiUsageResponseSchema,
  legacyMigrationImportListResponseSchema,
  supportAnalyticsResponseSchema,
  supportKnowledgeArticleViewSchema,
  supportKnowledgeBuildViewSchema,
  supportLearningCandidateViewSchema,
} from '@nexa/contracts';
import { ago, fixture, type Parser, type ShotFixture } from '../fixture.ts';
import { CUSTOMERS } from './commerce-a.ts';
import { PANELS } from './ops-a.ts';

type Json = Record<string, unknown>;

/*
 * PR #285 review, D2: answers for every request `pnpm web:sweep` reported as unfixtured, so
 * each of these routes is swept and photographed as the operator sees it — its content —
 * rather than as an error card. Each is a plain, believable state of an installation that
 * uses the feature; none of them is a failure the page exists to show.
 */

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

const H = (c: string): string => c.repeat(64);
const SWEEP_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const CUSTOMER = CUSTOMERS[0] as Json;
const CUSTOMER_ID = CUSTOMER['id'] as string;
const PANEL_B = PANELS[1] as Json;

// --- the audience count (broadcasts, mass operations) ----------------------------------------

const AUDIENCE_PREVIEW = {
  preview: {
    asOf: ago(0),
    definition: { version: 1 },
    definitionHash: H('a'),
    customers: 1284,
    reachable: 1197,
    fingerprint: 'b'.repeat(32),
    optedOut: 42,
    sample: CUSTOMERS.slice(0, 5).map((row) => ({
      id: row['id'],
      firstName: row['firstName'],
      username: row['username'],
      telegramUserId: row['telegramUserId'],
    })),
  },
};

// --- an incident: maintenance on the degraded panel ------------------------------------------

const INCIDENT: Json = {
  id: SWEEP_ID,
  kind: 'MAINTENANCE',
  severity: 'MAJOR',
  status: 'ACTIVE',
  title: 'به‌روزرسانی هستهٔ سرور فرانکفورت B',
  description:
    'به‌روزرسانی هسته و راه‌اندازی دوبارهٔ سرور؛ فروش روی این سرور تا پایان کار متوقف است.',
  customerMessage: 'سرویس‌های فرانکفورت B تا حدود یک ساعت دیگر دوباره وصل می‌شوند.',
  targets: [{ kind: 'PANEL', ref: PANEL_B['id'] }],
  stopSales: true,
  // Not on the admin banner, so every other screen is photographed as it was.
  adminBanner: false,
  scheduledStartAt: null,
  scheduledEndAt: ago(-60),
  startedAt: ago(20),
  resolvedAt: null,
  version: 3,
  createdAt: ago(30),
  effects: [
    {
      kind: 'PANEL_DRAIN',
      targetKind: 'PANEL',
      targetRef: PANEL_B['id'],
      subjectRef: PANEL_B['id'],
      state: 'APPLIED',
      errorCode: null,
      updatedAt: ago(20),
    },
  ],
};

// --- Customer 360: overview and financial summary of the first customer ----------------------

const OVERVIEW = {
  overview: {
    customerId: CUSTOMER_ID,
    channelMembershipExemptAt: null,
    phone: { number: '+989121234567', verifiedAt: ago(60 * 24 * 20) },
    locationOverride: null,
    marketingOptOutAt: null,
    personalDiscount: { percent: 0, setAt: null, enabled: false },
    terms: { available: false },
  },
};

// The wallet fixture's ledger: one top-up of 500 000, two purchases, one operator credit.
const FINANCIAL_SUMMARY = {
  summary: {
    orders: {
      purchases: [{ currency: 'IRT', count: 2, amount: '345000' }],
      discounts: [{ currency: 'IRT', count: 1, amount: '37500' }],
      refunded: [],
      awaitingPayment: 1,
      orderCount: 4,
    },
    payments: {
      confirmed: [{ currency: 'IRT', count: 1, amount: '500000' }],
      pending: 0,
      paymentCount: 1,
    },
    ledger: [
      { reason: 'TOPUP_RECEIPT', direction: 'CREDIT', currency: 'IRT', count: 1, amount: '500000' },
      { reason: 'PURCHASE', direction: 'DEBIT', currency: 'IRT', count: 2, amount: '345000' },
      { reason: 'ADMIN_CREDIT', direction: 'CREDIT', currency: 'IRT', count: 1, amount: '30000' },
    ],
    services: { byState: [{ state: 'ACTIVE', count: 2 }], serviceCount: 2 },
    denied: [],
  },
};

// --- the support AI, knowledge and analytics -------------------------------------------------

const credential = (over: Json = {}): Json => ({
  provider: 'OPENAI',
  configured: true,
  setAt: ago(60 * 24 * 10),
  region: null,
  trippedUntil: null,
  lastTestOutcome: 'OK',
  lastTestFailureClass: null,
  lastTestedAt: ago(60 * 24 * 10 - 5),
  breaker: 'CLOSED',
  consecutiveFailures: 0,
  rejectedAt: null,
  ...over,
});

const SUPPORT_AI_CONFIG = {
  config: {
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'ASSIST_ONLY',
    primary: { provider: 'OPENAI', model: 'gpt-4o-mini' },
  },
  version: 3,
  credentials: [
    credential(),
    credential({
      provider: 'ANTHROPIC',
      configured: false,
      setAt: null,
      lastTestOutcome: null,
      lastTestedAt: null,
    }),
  ],
  capabilities: {
    OPENAI: { structuredOutput: true, vision: true },
    ANTHROPIC: { structuredOutput: true, vision: true },
    ZAI: { structuredOutput: false, vision: false },
  },
  chainUnavailable: false,
};

const ANALYTICS = {
  period: { range: 'LAST_7_DAYS', start: ago(60 * 24 * 7), end: ago(0) },
  conversationsNow: [
    { state: 'AI_ACTIVE', count: 7 },
    { state: 'HUMAN_ACTIVE', count: 3 },
    { state: 'HANDOFF_REQUIRED', count: 2 },
    { state: 'PAUSED', count: 0 },
  ],
  handoffsByReason: [
    { reason: 'HANDOFF_TOPIC', count: 4 },
    { reason: 'LOW_CONFIDENCE', count: 1 },
  ],
  auto: {
    sent: 11,
    handedOff: 5,
    dropped: 2,
    pending: 1,
    byOutcome: [
      { outcome: 'sent', count: 11 },
      { outcome: 'guard_handoff_topic', count: 4 },
    ],
  },
  assist: { requested: 9, sent: 6, discarded: 2, superseded: 0, failed: 1, open: 0 },
  providerRuns: [
    {
      provider: 'OPENAI',
      outcome: 'OK',
      runs: 30,
      p50LatencyMs: 1200,
      p95LatencyMs: 4100,
      inputTokens: 81234,
      outputTokens: 9123,
    },
  ],
  learningByState: [
    { state: 'PENDING', count: 2 },
    { state: 'APPROVED', count: 1 },
    { state: 'REJECTED', count: 0 },
  ],
  knowledgeBySource: [
    { source: 'NEXA_BUILD', state: 'APPROVED', enabled: true, count: 12 },
    { source: 'LEARNED', state: 'APPROVED', enabled: true, count: 2 },
  ],
  aiFailures: [],
};

// The conversation the sweep opens at `/business-chats/:id` is the first in the inbox.
const CHAT_ID = SWEEP_ID;
const CHAT_ID_2 = '019400ab-cdef-7012-8345-6789abcdef02';

const article = (n: number, over: Json): Json => ({
  id: `019500ab-cdef-7012-8345-6789abcdef0${n}`,
  source: 'MANUAL',
  state: 'APPROVED',
  enabled: true,
  title: '',
  body: '',
  category: 'GENERAL',
  tags: [],
  revision: 1,
  version: 1,
  createdAt: ago(60 * 24 * (10 - n)),
  updatedAt: ago(60 * 24 * (10 - n)),
  ...over,
});

const ARTICLES = [
  article(1, {
    source: 'LEARNED',
    title: 'چطور لینک اشتراک را در برنامه وارد کنم؟',
    body: 'لینک را از «سرویس‌های من» کپی کنید و در برنامه گزینهٔ «افزودن از کلیپ‌بورد» را بزنید.',
    category: 'APPS',
    tags: ['v2rayNG'],
    revision: 2,
    version: 4,
  }),
  article(2, {
    source: 'NEXA_BUILD',
    title: 'پلن یک‌ماهه ۵۰ گیگ',
    body: 'مدت: ۳۰ روز — حجم: ۵۰ گیگابایت — تا دو دستگاه.',
    category: 'PLANS',
  }),
  article(3, {
    title: 'بازگشت وجه چطور انجام می‌شود؟',
    body: 'اگر سرویس تحویل نشود، مبلغ به‌طور خودکار به کیف پول برمی‌گردد.',
    category: 'POLICY',
  }),
];

const candidate = (n: number, over: Json): Json => ({
  id: `019510ab-cdef-7012-8345-6789abcdef0${n}`,
  state: 'PENDING',
  title: '',
  body: '',
  category: 'CONNECTION',
  tags: [],
  rationale: '',
  confidence: 'HIGH',
  rejectReason: null,
  sensitiveKinds: [],
  conversationId: CHAT_ID,
  sourceCount: 2,
  provider: 'OPENAI',
  model: 'gpt-4o-mini',
  articleId: null,
  replacesArticleId: null,
  assisted: false,
  version: 1,
  createdAt: ago(60 * (5 + n)),
  reviewedAt: null,
  ...over,
});

const CANDIDATES_PENDING = [
  candidate(1, {
    title: 'اتصال در اندروید پس از به‌روزرسانی',
    body: 'برنامه را کامل ببندید، دوباره باز کنید و اشتراک را به‌روزرسانی کنید.',
    tags: ['اندروید'],
    rationale: 'در دو گفتگو همین پاسخ مشکل را حل کرد و به حساب مشتری بستگی ندارد.',
  }),
  candidate(2, {
    title: 'تفاوت حجم و مدت سرویس',
    body: 'سرویس با تمام شدن هر کدام زودتر برسد متوقف می‌شود؛ تمدید هر دو را تازه می‌کند.',
    category: 'PLANS',
    confidence: 'MEDIUM',
    conversationId: CHAT_ID_2,
    sourceCount: 1,
    rationale: 'پرسش رایج است و پاسخ از قوانین فروش می‌آید.',
  }),
];

const proposal = (n: number, over: Json): Json => ({
  id: `019620ab-cdef-7012-8345-6789abcdef0${n}`,
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
    id: '019610ab-cdef-7012-8345-6789abcdef01',
    state: 'OPEN',
    createdAt: ago(60 * 3),
    counts: { add: 1, update: 1, unchanged: 1, conflict: 0, retire: 0 },
    truncated: 0,
    capped: 0,
    proposals: [
      proposal(1, { title: 'پلن سه‌ماهه نامحدود', body: 'مدت: ۹۰ روز — حجم: نامحدود.' }),
      proposal(2, {
        sourceType: 'FAQ',
        kind: 'UPDATE',
        title: 'بازگشت وجه چطور انجام می‌شود؟',
        body: 'اگر سرویس تحویل نشود، مبلغ همان لحظه به کیف پول برمی‌گردد.',
        category: 'POLICY',
        baseTitle: 'بازگشت وجه چطور انجام می‌شود؟',
        baseBody: 'اگر سرویس تحویل نشود، مبلغ به‌طور خودکار به کیف پول برمی‌گردد.',
        baseRevision: 1,
        articleId: (ARTICLES[2] as Json)['id'],
      }),
      proposal(3, {
        sourceType: 'PRODUCT',
        kind: 'UNCHANGED',
        state: 'SKIPPED',
        title: 'پلن یک‌ماهه ۵۰ گیگ',
        body: 'مدت: ۳۰ روز — حجم: ۵۰ گیگابایت — تا دو دستگاه.',
        baseTitle: 'پلن یک‌ماهه ۵۰ گیگ',
        baseBody: 'مدت: ۳۰ روز — حجم: ۵۰ گیگابایت — تا دو دستگاه.',
        baseRevision: 1,
        articleId: (ARTICLES[1] as Json)['id'],
      }),
    ],
  },
};

// --- Telegram Business conversations ---------------------------------------------------------

const conversation = (over: Json = {}): Json => ({
  id: CHAT_ID,
  state: 'HANDOFF_REQUIRED',
  takeoverReason: null,
  handoffReason: 'HANDOFF_TOPIC',
  peerTelegramUserId: CUSTOMER['telegramUserId'],
  customer: { id: CUSTOMER_ID, username: CUSTOMER['username'], firstName: CUSTOMER['firstName'] },
  connectionStatus: 'ACTIVE',
  lastMessageAt: ago(12),
  lastInboundAt: ago(12),
  preview: 'سرویس وصل نمی‌شود، می‌خواهم پولم برگردد',
  unansweredSince: ago(12),
  ticketId: null,
  ...over,
});

const message = (n: number, origin: string, text: string, minutes: number): Json => ({
  id: `019420ab-cdef-7012-8345-6789abcdef0${n}`,
  origin,
  kind: 'TEXT',
  text,
  sentAt: ago(minutes),
  edited: false,
  deleted: false,
});

const CHAT_DETAIL = {
  conversation: { ...conversation(), controlEpoch: 3, lastHumanAt: null },
  escalations: [],
  messages: [
    message(1, 'INBOUND', 'سلام، از دیشب سرویس وصل نمی‌شود.', 30),
    message(
      2,
      'OWN_ECHO',
      'سلام! لطفاً برنامه را ببندید، دوباره باز کنید و اشتراک را به‌روزرسانی کنید.',
      29,
    ),
    message(3, 'INBOUND', 'انجام دادم، باز هم وصل نمی‌شود. می‌خواهم پولم برگردد.', 12),
  ],
  outbound: [
    {
      id: '019430ab-cdef-7012-8345-6789abcdef01',
      origin: 'AUTO',
      state: 'DELIVERED',
      text: 'سلام! لطفاً برنامه را ببندید، دوباره باز کنید و اشتراک را به‌روزرسانی کنید.',
      createdAt: ago(29),
      resolvedAt: ago(29),
      failureCode: null,
    },
  ],
};

export const COVERAGE_B: readonly ShotFixture[] = [
  // Broadcasts (new and a draft) and a new mass operation count their audience.
  fixture('/audience/preview', audiencePreviewResponseSchema, AUDIENCE_PREVIEW, {
    method: 'POST',
  }),
  // /appearance: the QR preview, a real PNG of the server's sample text (no background stored).
  fixture(
    '/delivery-qr/preview',
    deliveryQrPreviewSchema,
    {
      pngBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAYgAAAGICAAAAAB+KCj6AAAE3klEQVR42u3bQXLjMAwEQP//08kTTAwgxyEat93IkojmZQrU60d9Rb20AIQCAUKBAKFAgFAgQCgQIBQIEAoECAUChAIBQoEAoUAoECAUCBAKBAgFAoR6DOIV1unv0+dX7//ud++um+oHCBAgQIAAAQIECBCbII6DyeGCT/9efZ+0EdX7T90PBAgQIECAAAECBIgNENXgNNXId5Dv7n8K0w2G1X6AAAECBAgQIECAAAGiPlhJg+Bpo6vvfwoKAgQIECBAgAABAgSIzwW6qeBVhUkPxoEAAQIECBAgQIAAAaIP0b2+OpjpBr7qdVWIqf6BAAECBAgQIECAAHEjxFQwuuXfaT9AgAABAgQIECBAgNgA0a108DI1cEqf2x1MlfsEAgQIECBAgAABAsRFENUPTaofgEwfSEsHU2kg7Q6uQIAAAQIECBAgQIDYBFF9sanAN/X37saq/j8IECBAgAABAgQIEBshqoFqegHdD1Om7tvtFwgQIECAAAECBAgQGyC6A5X0A46nYMoNam4cECBAgAABAgQIECA2QlQPXqWDpO4GmAqUaTBLoUGAAAECBAgQIECA2ADRPWDWDXpTQfP0fbrBDwQIECBAgAABAgSIjRDpAqoHtk5/X31eN5ilB+TKzwUBAgQIECBAgAAB4kKINMClC6gOkrobIF1HGuBAgAABAgQIECBAgLgZIg1q3QHSVKOnNsrUYAoECBAgQIAAAQIEiE0Q3QV0G9QNaKcDpKmgWT6gBgIECBAgQIAAAQLERRDVBnwqeJ0Gp6n3TD/IAQECBAgQIECAAAECxHmQmgp86X2616frSQ+egQABAgQIECBAgABxE0T1wemHJt0gddq40/dN7xdvbBAgQIAAAQIECBAgLoJIG9UNiFMDqukNlhYIECBAgAABAgQIEJsgqsEnbUR6n6mA+fR6QIAAAQIECBAgQIDYCFENUOlgJz14lja6GizTjQECBAgQIECAAAECxEaI9IDW1MLT+33qIFx7MAYCBAgQIECAAAECxEUQpw8+DX7pfeODW+EBsKcGUyBAgAABAgQIECBAbILoHghLBzhPNar7HuMH5ECAAAECBAgQIECAuBiiu8DpAVB3A6SDrTS4gQABAgQIECBAgACxAaJ6YKs7IJoOWt2B0XSwBAECBAgQIECAAAFiA8SnA1UKUYWpQk0PwECAAAECBAgQIECAuBkiPcCVDlzSQVU6yHnqwNnjyRoECBAgQIAAAQIEiC+GqDai2qjq4KkaBNON1A16VRgQIECAAAECBAgQIG6ESIPO9MApDkxhA7uDKBAgQIAAAQIECBAgNkNMN7Ya+KYHMtVBUjo4AwECBAgQIECAAAFiI8R0wEmDYjpI+qvflzcsCBAgQIAAAQIECBAXQqQDpPbBq2aQm3r+1wQ6ECBAgAABAgQIECD+IUT3AFga7LpQUxshDbYgQIAAAQIECBAgQICYG7xUG5wCpQOo7nO+JtCBAAECBAgQIECAAHERxFPBqgtbDaYpJAgQIECAAAECBAgQGyDS6/8qmHUDWNrwxwdDIECAAAECBAgQIED8A4g0UKWQ04ExDWzTAy0QIECAAAECBAgQIDZAqM8UCBAKBAgFAoQCAUKBAKFAgFAgQCgQIBQIEAoECAUChAKhQIBQIEAoECAUCBAqrl9QK1D9CRB13AAAAABJRU5ErkJggg==',
      width: 392,
      height: 392,
      templated: false,
      fallback: 'NO_BACKGROUND',
      moduleScale: 8,
      background: null,
    },
    { method: 'POST' },
  ),

  // /incidents and /incidents/:id.
  fixture('/incidents', incidentListResponseSchema, { incidents: [INCIDENT], nextCursor: null }),
  fixture('/incidents/:id', incidentDetailResponseSchema, {
    incident: INCIDENT,
    timeline: [
      { id: 'e1', kind: 'CREATED', actorLabel: 'owner', detail: null, occurredAt: ago(30) },
      { id: 'e2', kind: 'STARTED', actorLabel: 'owner', detail: null, occurredAt: ago(20) },
    ],
  }),

  // /users/:id: the Customer 360 overview and financial summary.
  fixture('/users/:id/overview', customerOverviewResponseSchema, OVERVIEW),
  fixture(
    '/users/:id/financial-summary',
    customerFinancialSummaryResponseSchema,
    FINANCIAL_SUMMARY,
  ),

  // /legacy-migration and /recovery: the import is available on this installation.
  fixture('/legacy-migration/capabilities', legacyMigrationCapabilitiesResponseSchema, {
    enabled: true,
    maxUploadBytes: 64 * 1024 * 1024,
    maxDecisionsBytes: 256 * 1024,
    approvalPhrase: LEGACY_MIGRATION_APPROVAL_PHRASE,
    productionLikeTarget: false,
    targetAcknowledgement: null,
  }),

  fixture('/legacy-migration/imports', legacyMigrationImportListResponseSchema, {
    imports: [],
    nextCursor: null,
  }),

  // Telegram Business conversations.
  fixture('/business-connections', businessConnectionListResponseSchema, {
    connections: [
      {
        id: '019440ab-cdef-7012-8345-6789abcdef01',
        botInstanceId: '01900000-0000-7000-8000-00000000b001',
        ownerTelegramUserId: '777001',
        status: 'ACTIVE',
        rights: ['can_read_messages', 'can_reply'],
        connectedAt: ago(60 * 24 * 30),
        lastConfirmedAt: ago(60),
      },
    ],
  }),
  fixture('/business-chats', businessChatListResponseSchema, {
    conversations: [
      conversation(),
      conversation({
        id: CHAT_ID_2,
        state: 'AI_ACTIVE',
        handoffReason: null,
        customer: {
          id: (CUSTOMERS[1] as Json)['id'],
          username: (CUSTOMERS[1] as Json)['username'],
          firstName: (CUSTOMERS[1] as Json)['firstName'],
        },
        peerTelegramUserId: (CUSTOMERS[1] as Json)['telegramUserId'],
        lastMessageAt: ago(45),
        lastInboundAt: ago(46),
        preview: 'حجم سرویسم چقدر مانده؟',
        unansweredSince: null,
      }),
    ],
    nextCursor: null,
  }),
  fixture('/business-chats/:id', businessChatDetailResponseSchema, CHAT_DETAIL),

  // The support AI: configured for drafts, its analytics, knowledge, learning and build.
  fixture('/support-ai/config', supportAiConfigResponseSchema, SUPPORT_AI_CONFIG),
  fixture('/support-ai/usage', supportAiUsageResponseSchema, {
    since: ago(60 * 24 * 7),
    rows: [
      {
        provider: 'OPENAI',
        model: 'gpt-4o-mini',
        operation: 'ASSIST_DRAFT',
        calls: 12,
        failures: 1,
        inputTokens: 3400,
        outputTokens: 900,
        avgLatencyMs: 1800,
      },
    ],
  }),
  fixture('/business-chats/:id/drafts', listOf('drafts', supportAiDraftViewSchema), {
    drafts: [
      {
        id: '019460ab-cdef-7012-8345-6789abcdef01',
        state: 'READY',
        createdAt: ago(11),
        readyAt: ago(11),
        failureCode: null,
        decision: 'REPLY',
        topic: 'CONNECTION_TROUBLESHOOTING',
        confidence: 'MEDIUM',
        summary: 'مشتری از دیشب وصل نمی‌شود و بازگشت وجه می‌خواهد.',
        intent: 'رفع مشکل اتصال یا بازگشت وجه',
        suggestedReply:
          'متأسفیم! سرور شما در حال به‌روزرسانی است و تا یک ساعت دیگر وصل می‌شود. اگر باز هم مشکل بود، همکارم بررسی می‌کند.',
        ticketAction: 'NONE',
        factLabels: ['سرویس فعال', 'سرور در حال نگهداری'],
        knowledgeLabels: [],
        provider: 'OPENAI',
        model: 'gpt-4o-mini',
        imagesSeen: 0,
        imagesUnseen: 0,
        unseenImageHandoff: null,
        failure: null,
        replyOverLimit: false,
      },
    ],
  }),
  fixture('/support-ai/analytics', supportAnalyticsResponseSchema, ANALYTICS),
  fixture('/support-knowledge/articles', listOf('articles', supportKnowledgeArticleViewSchema), {
    articles: ARTICLES,
  }),
  fixture(
    '/support-knowledge/candidates',
    listOf('candidates', supportLearningCandidateViewSchema),
    { candidates: CANDIDATES_PENDING },
  ),
  fixture('/support-knowledge/builds/latest', buildEnvelope, BUILD),
];
