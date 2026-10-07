import { describe, expect, it } from 'vitest';
import type { SupportContextBuild } from '../../apps/api/src/modules/commerce/support-context/application/support-context.builder';
import {
  KNOWLEDGE_QUERY_MAX_TERMS,
  knowledgeScores,
  matchTerms,
  selectRelevantKnowledge,
  weightedQueryTerms,
} from '../../apps/api/src/modules/commerce/support-context/domain/knowledge-relevance';
import {
  KNOWLEDGE_QUERY_EPISODE_MESSAGES,
  KNOWLEDGE_QUERY_PRIOR_JOBS,
  KNOWLEDGE_QUERY_WEIGHTS,
  TOPIC_QUERY_TERMS,
  joinBounded,
  knowledgeQueryFor,
  troubleshootingState,
  type PriorDecisionFact,
} from '../../apps/api/src/modules/control/support-ai/domain/knowledge-query';
import type { SupportTranscriptLine } from '../../apps/api/src/modules/control/support-ai/domain/transcript';
import { TbSupportContextSource } from '../../apps/api/src/modules/control/support-ai/infrastructure/support-context-source';
import { SUPPORT_AI_SAFE_TOPICS, SUPPORT_CONTEXT_LIMITS } from '@nexa/contracts';

/**
 * A8 — knowledge retrieval without embeddings: the query is the customer's latest words PLUS
 * what NEXA already knows about the conversation (the last intent and topic, the knowledge it
 * cited, an open troubleshooting episode), each part weighted; an entry the query does not match
 * is never sent; at most eight. Deterministic and bounded.
 */

type Line = Pick<SupportTranscriptLine, 'origin' | 'text'>;
const customer = (text: string): Line => ({ origin: 'INBOUND', text });
const support = (text: string): Line => ({ origin: 'OWN_ECHO', text });

const prior = (over: Partial<PriorDecisionFact> = {}): PriorDecisionFact => ({
  decision: 'REPLY',
  topic: 'CONNECTION_TROUBLESHOOTING',
  intent: 'اتصال سرویس روی آیفون',
  knowledgeLabels: [],
  ...over,
});

/** Eight approved articles on different subjects; none mentions «نشد» or «انجام». */
const ARTICLES = [
  { title: 'تمدید سرویس', body: 'برای تمدید از منوی سرویس‌های من اقدام کنید.', tags: [] },
  { title: 'خرید سرویس جدید', body: 'از منوی خرید، پلن را انتخاب کنید.', tags: [] },
  { title: 'افزایش حجم', body: 'حجم اضافه از منوی سرویس خریداری می‌شود.', tags: [] },
  {
    title: 'وصل نمی‌شود روی آیفون',
    body: 'برنامه را ببندید، اینترنت را خاموش و روشن کنید و دوباره وصل شوید.',
    tags: ['اتصال', 'قطعی'],
  },
  { title: 'نصب روی ویندوز', body: 'برنامه را از لینک رسمی دانلود و نصب کنید.', tags: [] },
  {
    title: 'به‌روزرسانی لینک اشتراک',
    body: 'در برنامه، اشتراک را به‌روزرسانی کنید.',
    tags: ['اشتراک'],
  },
  { title: 'قوانین استفاده', body: 'استفاده هم‌زمان بیش از حد مجاز ممنوع است.', tags: [] },
  { title: 'زمان پشتیبانی', body: 'پاسخ‌گویی هر روز از ۹ تا ۲۴.', tags: [] },
] as const;

describe('A8 — the weighted query', () => {
  it('with no earlier decision, it is the customer’s latest words alone', () => {
    const parts = knowledgeQueryFor([customer('سلام'), customer('وصل نمیشه')], []);
    expect(parts).toEqual([
      { text: 'سلام\nوصل نمیشه', weight: KNOWLEDGE_QUERY_WEIGHTS.latestCustomer },
    ]);
  });

  it('adds the last intent, the knowledge it cited and the last topic, each at its weight', () => {
    const parts = knowledgeQueryFor(
      [customer('باز هم نشد')],
      [
        prior({ topic: 'APP_SETUP', decision: 'HANDOFF', knowledgeLabels: ['نصب روی ویندوز'] }),
        prior({ intent: 'older intent', knowledgeLabels: ['تمدید سرویس'] }),
        prior({ knowledgeLabels: ['third — never read'] }),
      ],
    );
    expect(parts).toEqual([
      { text: 'باز هم نشد', weight: KNOWLEDGE_QUERY_WEIGHTS.latestCustomer },
      { text: 'اتصال سرویس روی آیفون', weight: KNOWLEDGE_QUERY_WEIGHTS.intent },
      { text: 'نصب روی ویندوز\nتمدید سرویس', weight: KNOWLEDGE_QUERY_WEIGHTS.citedTitles },
      { text: TOPIC_QUERY_TERMS.APP_SETUP, weight: KNOWLEDGE_QUERY_WEIGHTS.topic },
    ]);
  });

  it('an open troubleshooting episode brings the earlier description back', () => {
    const transcript = [
      customer('سلام، روی آیفون وصل نمیشه'),
      support('برنامه را ببندید'),
      customer('بستم'),
      support('اینترنت را خاموش و روشن کنید'),
      customer('انجام دادم'),
      customer('باز هم نشد'),
      customer('هنوز'),
    ];
    const open = knowledgeQueryFor(transcript, [prior()]);
    expect(open.find((p) => p.weight === KNOWLEDGE_QUERY_WEIGHTS.troubleshooting)?.text).toBe(
      'سلام، روی آیفون وصل نمیشه\nبستم',
    );
    // Closed: the last decision handed off, or was about a topic that is not troubleshooting.
    for (const last of [prior({ decision: 'HANDOFF' }), prior({ topic: 'PLAN_INFO' })]) {
      const parts = knowledgeQueryFor(transcript, [last]);
      expect(parts.some((p) => p.text.includes('سلام، روی آیفون'))).toBe(false);
    }
  });

  it('troubleshooting is open only after a step or a question on a troubleshooting topic', () => {
    expect(troubleshootingState([])).toEqual({ open: false, topic: null });
    expect(troubleshootingState([prior()]).open).toBe(true);
    expect(troubleshootingState([prior({ decision: 'ASK_CLARIFYING_QUESTION' })]).open).toBe(true);
    expect(troubleshootingState([prior({ decision: 'NO_ACTION' })]).open).toBe(false);
    expect(troubleshootingState([prior({ topic: 'REFUND' })]).open).toBe(false);
    // Only the LATEST decision decides.
    expect(troubleshootingState([prior({ decision: 'HANDOFF' }), prior()]).open).toBe(false);
  });

  it('a purged intent and a topic with no vocabulary add nothing', () => {
    const parts = knowledgeQueryFor(
      [customer('x1')],
      [prior({ intent: null, topic: 'REFUND', decision: 'HANDOFF' })],
    );
    expect(parts).toEqual([{ text: 'x1', weight: 1 }]);
    // Every safe topic but the greeting has words; no handoff topic has any.
    for (const topic of SUPPORT_AI_SAFE_TOPICS) {
      expect(TOPIC_QUERY_TERMS[topic] !== undefined, topic).toBe(topic !== 'GREETING');
    }
  });

  it('is bounded: every part is clipped, and at most three jobs and six earlier messages are read', () => {
    const long = 'ب'.repeat(20_000);
    const transcript = Array.from({ length: 30 }, (_, i) => customer(`${long}${String(i)}`));
    const parts = knowledgeQueryFor(
      transcript,
      Array.from({ length: 10 }, () => prior({ intent: long, knowledgeLabels: [long, long] })),
    );
    const total = parts.reduce((sum, p) => sum + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(4_500 + 160 + 1_200 + 3_000 + 200);
    expect(KNOWLEDGE_QUERY_PRIOR_JOBS).toBe(3);
    expect(KNOWLEDGE_QUERY_EPISODE_MESSAGES).toBe(6);
  });
});

describe('A8 — the latest question always survives the bound (PR #236 review)', () => {
  it('three long messages never push the newest one out of the customer part', () => {
    const long = 'ب'.repeat(5_000);
    const parts = knowledgeQueryFor(
      [customer(long), customer(long), customer('آیفون وصل نمیشه')],
      [],
    );
    const latest = parts[0];
    expect(latest?.weight).toBe(KNOWLEDGE_QUERY_WEIGHTS.latestCustomer);
    expect(latest?.text.endsWith('آیفون وصل نمیشه')).toBe(true);
    expect(latest?.text.length).toBeLessThanOrEqual(4_500);
    // And it is what the selection is decided by.
    expect(selectRelevantKnowledge(ARTICLES, parts, 8)[0]?.title).toBe('وصل نمی‌شود روی آیفون');
  });

  it('every message keeps an equal share; a short one is kept whole', () => {
    expect(joinBounded(['aaaa', 'bb', 'c'], 8)).toBe('aa\nbb\nc');
    expect(joinBounded([], 10)).toBe('');
    expect(joinBounded(['x'.repeat(50)], 10)).toBe('x'.repeat(10));
  });

  it('the troubleshooting episode is bounded the same way', () => {
    const long = 'پ'.repeat(5_000);
    const transcript = [
      customer('روی ویندوز نصب کردم'),
      customer(long),
      customer('a1'),
      customer('a2'),
      customer('a3'),
    ];
    const episode = knowledgeQueryFor(transcript, [prior()]).find(
      (part) => part.weight === KNOWLEDGE_QUERY_WEIGHTS.troubleshooting,
    );
    expect(episode?.text.startsWith('روی ویندوز نصب کردم')).toBe(true);
    expect(episode?.text.length).toBeLessThanOrEqual(3_000);
  });
});

describe('A8 — scoring and selection', () => {
  it('a term counts once, at the highest weight of the parts it appears in', () => {
    // The higher weight comes FIRST, so a last-write-wins rule would lower it.
    const weights = weightedQueryTerms([
      { text: 'آیفون', weight: 1 },
      { text: 'اتصال آیفون', weight: 0.4 },
    ]);
    const term = (word: string) => [...matchTerms(word)][0] ?? '';
    expect(weights.get(term('آیفون'))).toBe(1);
    expect(weights.get(term('اتصال'))).toBe(0.4);
  });

  it('the term bound keeps the highest-priority part’s terms', () => {
    const many = Array.from({ length: 200 }, (_, i) => `واژه${String(i)}x`).join(' ');
    const weights = weightedQueryTerms([
      { text: 'آیفون', weight: 1 },
      { text: many, weight: 0.5 },
    ]);
    expect(weights.size).toBe(KNOWLEDGE_QUERY_MAX_TERMS);
    expect(weights.get([...matchTerms('آیفون')][0] ?? '')).toBe(1);
  });

  it('a weighted part scores less than the same words from the customer', () => {
    const [strong] = knowledgeScores([ARTICLES[3]], [{ text: 'آیفون', weight: 1 }]);
    const [weak] = knowledgeScores([ARTICLES[3]], [{ text: 'آیفون', weight: 0.4 }]);
    expect(strong).toBeGreaterThan(weak ?? 0);
    expect(weak).toBeGreaterThan(0);
    // A plain string is the same as one part at weight 1.
    expect(knowledgeScores(ARTICLES, 'آیفون')).toEqual(
      knowledgeScores(ARTICLES, [{ text: 'آیفون', weight: 1 }]),
    );
  });

  it('a zero or negative weight contributes nothing', () => {
    expect(weightedQueryTerms([{ text: 'آیفون', weight: 0 }]).size).toBe(0);
    expect(weightedQueryTerms([{ text: 'آیفون', weight: -1 }]).size).toBe(0);
  });

  it('REPEATED FAILURE: «باز هم نشد» alone finds nothing; with the episode it finds the article', () => {
    const transcript = [
      customer('سلام، سرویس روی آیفون وصل نمیشه'),
      support('برنامه را ببندید و دوباره باز کنید'),
      customer('بستم'),
      customer('انجام دادم'),
      customer('باز هم نشد'),
    ];
    const plain = knowledgeQueryFor(transcript, []);
    expect(selectRelevantKnowledge(ARTICLES, plain, 8)).toEqual([]);
    const withMemory = knowledgeQueryFor(transcript, [
      prior({ intent: null, knowledgeLabels: [] }),
    ]);
    expect(selectRelevantKnowledge(ARTICLES, withMemory, 8)[0]?.title).toBe(
      'وصل نمی‌شود روی آیفون',
    );
  });

  it('THE EPISODE: the earlier description, not the topic alone, picks the article', () => {
    const transcript = [
      customer('برنامه ویندوز رو نصب کردم ولی خطا میده'),
      support('برنامه را ببندید و دوباره باز کنید'),
      customer('بستم'),
      customer('انجام دادم'),
      customer('باز هم نشد'),
    ];
    const last = prior({ topic: 'KNOWN_ERROR', intent: null, knowledgeLabels: [] });
    // Without the episode only the topic's word («خطا») is left, and no article has it.
    const topicOnly = knowledgeQueryFor(transcript, [last]).filter(
      (part) => part.weight !== KNOWLEDGE_QUERY_WEIGHTS.troubleshooting,
    );
    expect(selectRelevantKnowledge(ARTICLES, topicOnly, 8)).toEqual([]);
    expect(
      selectRelevantKnowledge(ARTICLES, knowledgeQueryFor(transcript, [last]), 8)[0]?.title,
    ).toBe('نصب روی ویندوز');
  });

  it('CONTINUITY: the article cited before stays ahead when the customer only answers «yes»', () => {
    // No topic vocabulary and no intent: only the title cited before can find it.
    const query = knowledgeQueryFor(
      [customer('بله')],
      [prior({ topic: null, intent: null, knowledgeLabels: ['به‌روزرسانی لینک اشتراک'] })],
    );
    expect(selectRelevantKnowledge(ARTICLES, query, 8)[0]?.title).toBe('به‌روزرسانی لینک اشتراک');
    expect(selectRelevantKnowledge(ARTICLES, knowledgeQueryFor([customer('بله')], []), 8)).toEqual(
      [],
    );
  });

  it('the customer’s own new subject outranks the memory of the old one', () => {
    const query = knowledgeQueryFor(
      [customer('می‌خواهم سرویس را تمدید کنم')],
      [prior({ intent: null, knowledgeLabels: ['وصل نمی‌شود روی آیفون'] })],
    );
    expect(selectRelevantKnowledge(ARTICLES, query, 8)[0]?.title).toBe('تمدید سرویس');
  });

  it('never more than the limit, never an unmatched entry, and the same answer every time', () => {
    const query = knowledgeQueryFor(
      [customer('سرویس')],
      [prior({ knowledgeLabels: ['نصب روی ویندوز'] })],
    );
    const once = selectRelevantKnowledge(ARTICLES, query, SUPPORT_CONTEXT_LIMITS.knowledge);
    expect(once.length).toBeLessThanOrEqual(SUPPORT_CONTEXT_LIMITS.knowledge);
    const scores = knowledgeScores(ARTICLES, query);
    for (const entry of once) {
      expect(scores[ARTICLES.indexOf(entry)]).toBeGreaterThan(0);
    }
    expect(once.map((e) => e.title)).not.toContain('زمان پشتیبانی');
    expect(selectRelevantKnowledge(ARTICLES, query, SUPPORT_CONTEXT_LIMITS.knowledge)).toEqual(
      once,
    );
    expect(SUPPORT_CONTEXT_LIMITS.knowledge).toBe(8);
  });

  it('a greeting matches nothing and carries no knowledge', () => {
    expect(matchTerms('سلام')).toEqual(new Set());
    expect(selectRelevantKnowledge(ARTICLES, knowledgeQueryFor([customer('سلام')], []), 8)).toEqual(
      [],
    );
  });
});

describe('A8 — the context source builds the query', () => {
  const build = {
    payload: {
      services: [],
      orders: [],
      payments: [],
      knowledge: [],
      flags: { identityLinked: false },
    },
    knowledgeAvailable: 0,
    references: { services: new Map(), orders: new Map(), payments: new Map() },
  } as unknown as SupportContextBuild;
  const scope = { tenantId: 't', botInstanceId: null } as never;

  it('reads the conversation’s latest decisions and passes the weighted query on', async () => {
    const asked: unknown[] = [];
    const read: unknown[] = [];
    const source = new TbSupportContextSource(
      {
        build: async (_scope, _customer, options) => {
          asked.push(options?.query);
          return build;
        },
      },
      {
        priorDecisions: async (_scope, conversationId, limit) => {
          read.push([conversationId, limit]);
          return [prior({ intent: 'اتصال', knowledgeLabels: [] })];
        },
      },
    );
    const transcript = [
      {
        id: 'm1',
        origin: 'INBOUND',
        author: 'CUSTOMER',
        kind: 'TEXT',
        text: 'وصل نمیشه',
        sentAt: new Date(0),
      },
    ] as const;
    await source.build(scope, 'c', { conversationId: 'conv-1', transcript });
    expect(read).toEqual([['conv-1', KNOWLEDGE_QUERY_PRIOR_JOBS]]);
    expect(asked).toEqual([
      [
        { text: 'وصل نمیشه', weight: 1 },
        { text: 'اتصال', weight: KNOWLEDGE_QUERY_WEIGHTS.intent },
        { text: TOPIC_QUERY_TERMS.CONNECTION_TROUBLESHOOTING, weight: 0.4 },
      ],
    ]);
  });

  it('without a transcript it passes the plain query, and reads no decision', async () => {
    const asked: unknown[] = [];
    const source = new TbSupportContextSource(
      {
        build: async (_scope, _customer, options) => {
          asked.push(options?.query);
          return build;
        },
      },
      {
        priorDecisions: async () => {
          throw new Error('must not be read');
        },
      },
    );
    await source.build(scope, 'c', { query: 'وصل' });
    await source.build(scope, 'c');
    expect(asked).toEqual(['وصل', null]);
  });
});
