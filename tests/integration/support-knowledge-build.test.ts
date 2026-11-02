import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type SupportKnowledgeProposalKind,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  SupportKnowledgeBuildService,
  type SupportKnowledgeBuildServiceDeps,
} from '../../apps/api/src/modules/control/support-knowledge/application/support-knowledge-build.service';
import { DrizzleSupportKnowledgeRepository } from '../../apps/api/src/modules/control/support-knowledge/infrastructure/drizzle-support-knowledge.repository';
import { buildView } from '../../apps/api/src/surfaces/web/support-knowledge.controller';
import {
  SUPPORT_KNOWLEDGE_REFRESH_JOB,
  SupportKnowledgeRefreshLoop,
} from '../../apps/api/src/modules/control/support-knowledge/application/support-knowledge-refresh';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * TB9 — the one-click knowledge build against a real database (program §30, §39; ADR-0035 §5).
 *
 * Pinned here: a run changes no article; a build with no changes is all UNCHANGED; apply
 * publishes, is idempotent, and is audited; a changed source is an UPDATE and a new revision;
 * an article a reviewer edited is a CONFLICT and «apply all» never touches it, only an explicit
 * choice does; an article that moved after the build is never overwritten; a superseded build
 * applies nothing; no secret, internal or reseller field appears in any proposal; the review
 * permission; tenant isolation; the TB3 context reads a built FAQ entry once.
 */

const PANEL_NAME = 'SECRET-PANEL-NAME-77';
const PANEL_HOST = 'secret-panel-host.example.test';

describe('the knowledge build (TB9)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let support: ActorContext;
  let ownerB: ActorContext;
  let panelId: string;
  let productId: string;
  let faqId: string;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;

  async function expectCode(promise: Promise<unknown>, code: string) {
    try {
      await promise;
    } catch (error) {
      expect(isNexaError(error) ? error.code : error).toBe(code);
      return;
    }
    throw new Error(`expected ${code}, nothing was thrown`);
  }

  async function product(input: {
    title: string;
    audience: 'EVERYONE' | 'RESELLERS_ONLY' | 'HIDDEN';
    active: boolean;
    categoryId?: string | null;
    panel?: string;
  }) {
    const repo = new DrizzleProductRepository(ctx.container.database.db);
    const created = await repo.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: input.title,
        description: 'یک ماهه با پشتیبانی',
        audience: input.audience,
        sortOrder: 10,
        panelId: (input.panel ?? panelId) as PanelId,
        categoryId: (input.categoryId === undefined
          ? SEED_IDS.categoryA
          : input.categoryId) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(987_654_321n, 'IRT'),
        display: { ...EMPTY_PRODUCT_DISPLAY, displayFeatures: ['سرعت بالا'] },
      },
      now: ctx.container.clock.now(),
    });
    if (input.active) {
      await repo.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    }
    return created.id;
  }

  async function build(actor = owner, scope: never = tenantA as never) {
    return ctx.container.supportKnowledgeBuild.run(scope, actor, { idempotencyKey: key('run') });
  }

  const kinds = (detail: Awaited<ReturnType<typeof build>>) =>
    Object.fromEntries(
      detail.proposals.map((p) => [`${p.sourceType}:${p.content.title}`, p.kind]),
    ) as Record<string, SupportKnowledgeProposalKind>;

  async function applyAll(buildId: string, idempotencyKey = key('apply')) {
    return ctx.container.supportKnowledgeBuild.apply(tenantA, owner, buildId, {
      idempotencyKey,
      proposalIds: null,
    });
  }

  async function builtArticles() {
    return ctx.container.supportKnowledge.listArticles(tenantA, owner, { source: 'NEXA_BUILD' });
  }

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const c = ctx.container;
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    support = adminActorFor(
      await createAdmin(c, tenantA, { username: 'support1', roleKeys: ['support'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(c, tenantB, { username: 'ownerb', roleKeys: ['owner'] }),
    );
    panelId = c.ids.uuid();
    await c.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, ${PANEL_NAME}, 'sanaei', ${`https://${PANEL_HOST}`}, 'ACTIVE')`);
    await makePanelSellable(c, tenantA, panelId);
    productId = await product({ title: 'پلن عمومی', audience: 'EVERYONE', active: true });
    await product({ title: 'پلن نماینده', audience: 'RESELLERS_ONLY', active: true });
    await product({ title: 'پلن غیرفعال', audience: 'EVERYONE', active: false });
    const faq = await c.supportFaqs.create(tenantA, owner, {
      idempotencyKey: key('faq'),
      question: 'چطور وصل شوم؟',
      answer: 'برنامه را باز کنید و لینک را وارد کنید.',
      sortOrder: 0,
    });
    faqId = faq.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('a run proposes and changes no article; the first run ADDs every source item', async () => {
    const first = await build();
    expect(first.build.state).toBe('OPEN');
    expect(kinds(first)).toMatchObject({ 'FAQ:چطور وصل شوم؟': 'ADD', 'PRODUCT:پلن عمومی': 'ADD' });
    expect(first.proposals.every((p) => p.kind === 'ADD')).toBe(true);
    expect(await builtArticles()).toEqual([]);
  });

  it('apply publishes, is idempotent and audited; a build with no changes is all UNCHANGED', async () => {
    const first = await build();
    const applyKey = key('apply');
    const result = await applyAll(first.build.id, applyKey);
    expect(result).toEqual({ applied: first.proposals.length, conflicted: 0, skipped: 0 });
    // The same key replays the same answer; a new key finds nothing left to apply.
    expect(await applyAll(first.build.id, applyKey)).toEqual(result);
    expect(await applyAll(first.build.id)).toEqual({ applied: 0, conflicted: 0, skipped: 0 });
    const articles = await builtArticles();
    expect(articles).toHaveLength(first.proposals.length);
    expect(articles.every((a) => a.state === 'APPROVED' && a.revision === 1)).toBe(true);
    const audits = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'support_knowledge.build.apply'`,
    );
    expect((audits.rows[0] as { n: number }).n).toBe(1);

    const second = await build();
    expect(second.proposals.length).toBe(first.proposals.length);
    expect(second.proposals.every((p) => p.kind === 'UNCHANGED' && p.state === 'SKIPPED')).toBe(
      true,
    );
    expect(second.build.counts).toMatchObject({ add: 0, update: 0, conflict: 0 });
  });

  it('the TB3 context carries a built FAQ entry once, as knowledge', async () => {
    await applyAll((await build()).build.id);
    // A8: the context carries only knowledge the query matches, so the probe asks with the
    // entry's own words; its state, not a missing word, decides whether it is there.
    const { payload } = await ctx.container.supportContext.build(tenantA, null, {
      query: 'چطور وصل شوم؟',
    });
    const faqEntries = payload.knowledge.filter((k) => k.question === 'چطور وصل شوم؟');
    expect(faqEntries).toEqual([
      {
        alias: expect.stringMatching(/^K[1-9]/u),
        source: 'KNOWLEDGE',
        question: 'چطور وصل شوم؟',
        answer: 'برنامه را باز کنید و لینک را وارد کنید.',
      },
    ]);
  });

  it('a changed source is an UPDATE and a new revision', async () => {
    await applyAll((await build()).build.id);
    await ctx.container.supportFaqs.update(tenantA, owner, {
      idempotencyKey: key('faq-up'),
      id: faqId,
      expectedVersion: 1,
      question: 'چطور وصل شوم؟',
      answer: 'پاسخ تازه.',
      sortOrder: 0,
    });
    const next = await build();
    expect(kinds(next)['FAQ:چطور وصل شوم؟']).toBe('UPDATE');
    await applyAll(next.build.id);
    const faqArticle = (await builtArticles()).find((a) => a.title === 'چطور وصل شوم؟')!;
    expect(faqArticle).toMatchObject({ body: 'پاسخ تازه.', revision: 2 });
    const revisions = await ctx.container.supportKnowledge.revisions(tenantA, owner, faqArticle.id);
    expect(revisions.map((r) => [r.revision, r.origin])).toEqual([
      [2, 'BUILD'],
      [1, 'BUILD'],
    ]);
    // The applied revision is the built revision: the next source change is an UPDATE again.
    await ctx.container.supportFaqs.update(tenantA, owner, {
      idempotencyKey: key('faq-up'),
      id: faqId,
      expectedVersion: 2,
      question: 'چطور وصل شوم؟',
      answer: 'پاسخ سوم.',
      sortOrder: 0,
    });
    expect(kinds(await build())['FAQ:چطور وصل شوم؟']).toBe('UPDATE');
  });

  it('an article a reviewer edited is a CONFLICT: apply-all never overwrites it, only a choice does', async () => {
    await applyAll((await build()).build.id);
    const faqArticle = (await builtArticles()).find((a) => a.title === 'چطور وصل شوم؟')!;
    await ctx.container.supportKnowledge.updateArticle(tenantA, owner, faqArticle.id, {
      idempotencyKey: key('edit'),
      expectedVersion: faqArticle.version,
      content: { title: 'چطور وصل شوم؟', body: 'متن دستی اپراتور.', category: 'GENERAL', tags: [] },
    });
    await ctx.container.supportFaqs.update(tenantA, owner, {
      idempotencyKey: key('faq-up'),
      id: faqId,
      expectedVersion: 1,
      question: 'چطور وصل شوم؟',
      answer: 'پاسخ تازهٔ منبع.',
      sortOrder: 0,
    });
    const next = await build();
    const conflict = next.proposals.find((p) => p.sourceType === 'FAQ')!;
    expect(conflict).toMatchObject({
      kind: 'CONFLICT',
      baseBody: 'متن دستی اپراتور.',
      baseRevision: 2,
    });
    // Named explicitly or not, apply never applies a conflict.
    expect(
      await ctx.container.supportKnowledgeBuild.apply(tenantA, owner, next.build.id, {
        idempotencyKey: key('apply'),
        proposalIds: [conflict.id],
      }),
    ).toEqual({ applied: 0, conflicted: 0, skipped: 0 });
    await applyAll(next.build.id);
    let current = (await builtArticles()).find((a) => a.id === faqArticle.id)!;
    expect(current.body).toBe('متن دستی اپراتور.');

    // KEEP_CURRENT: the edit stays, and the same source text is UNCHANGED next time.
    await ctx.container.supportKnowledgeBuild.resolve(tenantA, owner, conflict.id, {
      idempotencyKey: key('keep'),
      choice: 'KEEP_CURRENT',
    });
    current = (await builtArticles()).find((a) => a.id === faqArticle.id)!;
    expect(current).toMatchObject({ body: 'متن دستی اپراتور.', revision: 2 });
    expect(kinds(await build())['FAQ:چطور وصل شوم؟']).toBe('UNCHANGED');

    // The source changes again: a CONFLICT again, and TAKE_BUILD is a new revision.
    await ctx.container.supportFaqs.update(tenantA, owner, {
      idempotencyKey: key('faq-up'),
      id: faqId,
      expectedVersion: 2,
      question: 'چطور وصل شوم؟',
      answer: 'نسخهٔ سوم منبع.',
      sortOrder: 0,
    });
    const third = await build();
    const again = third.proposals.find((p) => p.sourceType === 'FAQ')!;
    expect(again.kind).toBe('CONFLICT');
    const taken = await ctx.container.supportKnowledgeBuild.resolve(tenantA, owner, again.id, {
      idempotencyKey: key('take'),
      choice: 'TAKE_BUILD',
    });
    expect(taken).toMatchObject({ state: 'APPLIED', resolution: 'TAKE_BUILD' });
    current = (await builtArticles()).find((a) => a.id === faqArticle.id)!;
    expect(current).toMatchObject({ body: 'نسخهٔ سوم منبع.', revision: 3 });
    // Built again: not edited since, so the next change would be a plain UPDATE.
    expect(kinds(await build())['FAQ:چطور وصل شوم؟']).toBe('UNCHANGED');
  });

  it('an article edited AFTER the build is never overwritten: its UPDATE becomes a CONFLICT', async () => {
    await applyAll((await build()).build.id);
    await ctx.container.supportFaqs.update(tenantA, owner, {
      idempotencyKey: key('faq-up'),
      id: faqId,
      expectedVersion: 1,
      question: 'چطور وصل شوم؟',
      answer: 'پاسخ تازه.',
      sortOrder: 0,
    });
    const next = await build();
    const update = next.proposals.find((p) => p.sourceType === 'FAQ')!;
    expect(update.kind).toBe('UPDATE');
    const faqArticle = (await builtArticles()).find((a) => a.title === 'چطور وصل شوم؟')!;
    await ctx.container.supportKnowledge.updateArticle(tenantA, owner, faqArticle.id, {
      idempotencyKey: key('edit'),
      expectedVersion: faqArticle.version,
      content: {
        title: 'چطور وصل شوم؟',
        body: 'ویرایش پس از ساخت.',
        category: 'GENERAL',
        tags: [],
      },
    });
    expect(await applyAll(next.build.id)).toEqual({ applied: 0, conflicted: 1, skipped: 0 });
    const after = (await builtArticles()).find((a) => a.id === faqArticle.id)!;
    expect(after.body).toBe('ویرایش پس از ساخت.');
    const latest = await ctx.container.supportKnowledgeBuild.latest(tenantA, owner);
    expect(latest?.proposals.find((p) => p.id === update.id)?.kind).toBe('CONFLICT');
  });

  it('a superseded build applies nothing', async () => {
    const first = await build();
    await build();
    await expectCode(applyAll(first.build.id), 'support_knowledge.build_superseded');
    expect(await builtArticles()).toEqual([]);
  });

  it('no secret, internal, price or reseller field appears in any proposal', async () => {
    const detail = await build();
    const views = JSON.stringify(buildView(detail));
    const raw = await ctx.container.database.db.execute(
      sql`SELECT title, body, base_title, base_body, tags::text AS tags FROM support_knowledge_build_proposals`,
    );
    const stored = JSON.stringify(raw.rows);
    const secrets = [
      PANEL_NAME,
      PANEL_HOST,
      panelId,
      productId,
      faqId,
      '987654321',
      '987,654,321',
      'پلن نماینده',
      'پلن غیرفعال',
    ];
    for (const secret of secrets) {
      expect(views, secret).not.toContain(secret);
      expect(stored, secret).not.toContain(secret);
    }
    expect(views).toContain('پلن عمومی');
  });

  /*
   * Phase 4 PR-2 (item 3) — the scrubber's BUSINESS ALLOWLIST. The tenant's own published content
   * keeps what it shows customers: an app's official and help links are copied into its article,
   * a FAQ with a link is proposed and applied, a payment route's instructions keep the card number
   * customers pay to. What is never published anywhere still excludes the item (a phone, a
   * subscription link, a card number outside a payment route), and apply still refuses unclean
   * text as the backstop. (TB9 × TB8 built knowledge with no link at all.)
   */
  it('PR-2: published links, prices and a payment route’s card are kept; a phone or stray card is not', async () => {
    const c = ctx.container;
    await c.clientApps.create(tenantA, owner, {
      idempotencyKey: key('app'),
      platform: 'ANDROID',
      name: 'برنامهٔ نمونه',
      icon: null,
      description: 'سازگار با لینک اشتراک',
      officialUrl: 'https://downloads.example.com/app.apk',
      alternativeUrl: null,
      helpUrl: 'https://help.example.com/guide',
      guide: '1. برنامه را نصب کنید',
      deliveryKinds: [],
      protocols: [],
      providerTypes: [],
      sortOrder: 10,
    });
    await c.supportFaqs.create(tenantA, owner, {
      idempotencyKey: key('faq'),
      question: 'راهنمای کامل کجاست؟',
      answer: 'راهنما در https://help.example.com/full است. هزینه پلن پایه 150,000 تومان است.',
      sortOrder: 1,
    });
    await c.supportFaqs.create(tenantA, owner, {
      idempotencyKey: key('faq'),
      question: 'شماره کارت چیست؟',
      answer: 'به کارت 6037-9975-1234-5678 واریز کنید.',
      sortOrder: 2,
    });
    await c.supportFaqs.create(tenantA, owner, {
      idempotencyKey: key('faq'),
      question: 'تلفن پشتیبانی؟',
      answer: 'با 09121234567 تماس بگیرید.',
      sortOrder: 3,
    });
    await c.database.db.execute(sql`
      UPDATE payment_gateways SET status = 'ACTIVE', display_name = 'کارت به کارت',
             instructions = 'مبلغ را به کارت 6037-9975-1234-5678 به نام فروشگاه واریز کنید.'
       WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`);
    const detail = await build();
    const titles = detail.proposals.map((p) => p.content.title);
    const app = detail.proposals.find((p) => p.sourceType === 'CLIENT_APP');
    expect(app?.content.body).toContain('https://downloads.example.com/app.apk');
    expect(app?.content.body).toContain('https://help.example.com/guide');
    expect(app?.content.tags).toEqual(expect.arrayContaining(['اندروید', 'android']));
    expect(titles).toContain('راهنمای کامل کجاست؟');
    expect(titles).toContain('چطور وصل شوم؟');
    // A card number is published only by a payment route; a FAQ carrying one, or a phone, is not.
    expect(titles).not.toContain('شماره کارت چیست؟');
    expect(titles).not.toContain('تلفن پشتیبانی؟');
    const route = detail.proposals.find((p) => p.sourceType === 'PAYMENT_METHOD');
    expect(route?.content.body).toContain('6037-9975-1234-5678');
    expect(route?.content.tags).toEqual(expect.arrayContaining(['پرداخت']));
    const [audit] = (
      await c.database.db.execute(
        sql`SELECT after FROM audit_logs WHERE action = 'support_knowledge.build.run' ORDER BY occurred_at DESC LIMIT 1`,
      )
    ).rows as { after: { excluded: { count: number; kinds: string[] } } }[];
    expect(audit!.after.excluded).toEqual({ count: 2, kinds: ['CARD', 'PHONE'] });

    // The backstop: a proposal whose text is not clean is never published, by apply-all or a choice.
    await c.database.db.execute(
      sql`UPDATE support_knowledge_build_proposals SET body = body || ' 09121234567'
          WHERE build_id = ${detail.build.id} AND title = 'راهنمای کامل کجاست؟'`,
    );
    await expectCode(applyAll(detail.build.id), 'support_knowledge.sensitive_content');
    expect(await builtArticles()).toEqual([]);
    await c.database.db.execute(
      sql`UPDATE support_knowledge_build_proposals SET body = replace(body, ' 09121234567', '')
          WHERE build_id = ${detail.build.id} AND title = 'راهنمای کامل کجاست؟'`,
    );
    await applyAll(detail.build.id);
    const bodies = (await builtArticles()).map((a) => a.body).join('\n');
    expect(bodies).toContain('https://help.example.com/full');
    expect(bodies).toContain('150,000 تومان');
    expect(bodies).toContain('https://downloads.example.com/app.apk');
  });

  it('L3: the support-accounts source is proposed and applied; any other handle is still excluded', async () => {
    const c = ctx.container;
    await c.settingsService.set(tenantA, owner, {
      idempotencyKey: key('accounts'),
      key: 'support.accounts',
      value: ['@Nexa_Support'],
      expectedVersion: null,
    });
    // A FAQ naming somebody's personal handle: still personal data, still excluded.
    await c.supportFaqs.create(tenantA, owner, {
      idempotencyKey: key('faq'),
      question: 'با چه کسی صحبت کنم؟',
      answer: 'به @ali_customer_99 پیام بدهید.',
      sortOrder: 2,
    });
    const detail = await build();
    const accounts = detail.proposals.find((p) => p.sourceType === 'SUPPORT_ACCOUNTS');
    expect(accounts?.content.body).toContain('@Nexa_Support');
    expect(detail.proposals.map((p) => p.content.title)).not.toContain('با چه کسی صحبت کنم؟');
    const [audit] = (
      await c.database.db.execute(
        sql`SELECT after FROM audit_logs WHERE action = 'support_knowledge.build.run' ORDER BY occurred_at DESC LIMIT 1`,
      )
    ).rows as { after: { excluded: { count: number; kinds: string[] } } }[];
    expect(audit!.after.excluded).toEqual({ count: 1, kinds: ['USERNAME'] });
    await applyAll(detail.build.id);
    expect((await builtArticles()).map((a) => a.body).join('\n')).toContain('@Nexa_Support');
  });

  it('permissions: support may view the build but not run or apply it; the denial is audited', async () => {
    const detail = await build();
    expect((await ctx.container.supportKnowledgeBuild.latest(tenantA, support))?.build.id).toBe(
      detail.build.id,
    );
    await expectCode(build(support), 'platform.permission_denied');
    await expectCode(
      ctx.container.supportKnowledgeBuild.apply(tenantA, support, detail.build.id, {
        idempotencyKey: key('apply'),
        proposalIds: null,
      }),
      'platform.permission_denied',
    );
    const denied = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'support_knowledge.build.%' AND result = 'DENIED'`,
    );
    expect((denied.rows[0] as { n: number }).n).toBe(2);
    expect(await builtArticles()).toEqual([]);
  });

  it('tenant isolation: tenant B builds from its own sources and cannot apply A’s build', async () => {
    const detailA = await build();
    const detailB = await build(ownerB, tenantB as never);
    expect(detailB.proposals.some((p) => p.content.title === 'چطور وصل شوم؟')).toBe(false);
    expect(detailB.proposals.some((p) => p.content.title === 'پلن عمومی')).toBe(false);
    await expectCode(
      ctx.container.supportKnowledgeBuild.apply(tenantB, ownerB, detailA.build.id, {
        idempotencyKey: key('apply'),
        proposalIds: null,
      }),
      'support_knowledge.build_not_found',
    );
    // Each tenant has its own open build: B's run did not supersede A's.
    await applyAll(detailA.build.id);
    expect((await builtArticles()).length).toBeGreaterThan(0);
  });

  // --- Substitute review of PR #204 ------------------------------------------------------

  async function category(status: 'ACTIVE' | 'INACTIVE', visibility: 'VISIBLE' | 'HIDDEN') {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO product_categories (id, tenant_id, name, status, visibility, sort_order)
      VALUES (${id}, ${tenantA.tenantId}, ${`cat-${id.slice(0, 8)}`}, ${status}, ${visibility}, 5)`);
    return id;
  }

  async function editFaqSource(answer: string, expectedVersion: number) {
    await ctx.container.supportFaqs.update(tenantA, owner, {
      idempotencyKey: key('faq-up'),
      id: faqId,
      expectedVersion,
      question: 'چطور وصل شوم؟',
      answer,
      sortOrder: 0,
    });
  }

  async function faqArticle() {
    return (await builtArticles()).find((a) => a.sourceType === 'FAQ')!;
  }

  async function editArticle(body: string) {
    const article = await faqArticle();
    return ctx.container.supportKnowledge.updateArticle(tenantA, owner, article.id, {
      idempotencyKey: key('edit'),
      expectedVersion: article.version,
      content: { title: 'چطور وصل شوم؟', body, category: 'GENERAL', tags: [] },
    });
  }

  /** The service over a repository a test can slow down at one step. */
  function serviceWith(repository: DrizzleSupportKnowledgeRepository) {
    const deps = (
      ctx.container.supportKnowledgeBuild as unknown as {
        deps: SupportKnowledgeBuildServiceDeps;
      }
    ).deps;
    return new SupportKnowledgeBuildService({ ...deps, repository });
  }

  /** A barrier: `arrive` resolves once `n` callers arrived, or after `ms` regardless. */
  function barrier(n: number, ms: number) {
    let arrived = 0;
    let open!: () => void;
    const all = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      arrive: async () => {
        arrived += 1;
        if (arrived >= n) open();
        await Promise.race([all, new Promise((resolve) => setTimeout(resolve, ms))]);
      },
    };
  }

  /** An UPDATE proposal for the FAQ, with the FAQ article built and its source changed. */
  async function pendingFaqUpdate() {
    await applyAll((await build()).build.id);
    await editFaqSource('پاسخ تازهٔ منبع.', 1);
    const next = await build();
    const update = next.proposals.find((p) => p.sourceType === 'FAQ')!;
    expect(update.kind).toBe('UPDATE');
    return { next, update };
  }

  /** A CONFLICT proposal for the FAQ, built normally: edited article, then the source changed. */
  async function pendingFaqConflict() {
    await applyAll((await build()).build.id);
    await editArticle('متن دستی اپراتور.');
    await editFaqSource('پاسخ تازهٔ منبع.', 1);
    const next = await build();
    const conflict = next.proposals.find((p) => p.sourceType === 'FAQ')!;
    expect(conflict.kind).toBe('CONFLICT');
    return { next, conflict };
  }

  it('B1: a product the customer catalogue does not list never becomes a proposal', async () => {
    const hidden = await category('ACTIVE', 'HIDDEN');
    const inactive = await category('INACTIVE', 'VISIBLE');
    const otherPanel = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${otherPanel}, ${tenantA.tenantId}, 'unsellable', 'sanaei', 'https://unsellable.example.test', 'ACTIVE')`);
    await product({
      title: 'پلن فروش خصوصی',
      audience: 'EVERYONE',
      active: true,
      categoryId: hidden,
    });
    await product({
      title: 'پلن دسته‌ی متوقف',
      audience: 'EVERYONE',
      active: true,
      categoryId: inactive,
    });
    await product({ title: 'پلن بی‌دسته', audience: 'EVERYONE', active: true, categoryId: null });
    await product({ title: 'پلن بی‌پنل', audience: 'EVERYONE', active: true, panel: otherPanel });
    const titles = (await build()).proposals
      .filter((p) => p.sourceType === 'PRODUCT')
      .map((p) => p.content.title);
    expect(titles).toEqual(['پلن عمومی']);
  });

  it('S1: an UPDATE that meets an edit during apply is a CONFLICT on the current text; TAKE_BUILD works', async () => {
    const { next, update } = await pendingFaqUpdate();
    const edited = await editArticle('ویرایش پس از ساخت.');
    expect(await applyAll(next.build.id)).toEqual({ applied: 0, conflicted: 1, skipped: 0 });
    const latest = (await ctx.container.supportKnowledgeBuild.latest(tenantA, owner))!;
    expect(latest.proposals.find((p) => p.id === update.id)).toMatchObject({
      kind: 'CONFLICT',
      baseRevision: edited.revision,
      baseBody: 'ویرایش پس از ساخت.',
    });
    // N3: the counts follow the kinds.
    expect(latest.build.counts).toMatchObject({ update: 0, conflict: 1 });
    expect(buildView(latest).counts).toMatchObject({ update: 0, conflict: 1 });
    await ctx.container.supportKnowledgeBuild.resolve(tenantA, owner, update.id, {
      idempotencyKey: key('take'),
      choice: 'TAKE_BUILD',
    });
    expect(await faqArticle()).toMatchObject({
      body: 'پاسخ تازهٔ منبع.',
      revision: edited.revision + 1,
    });
  });

  it('S4: an UPDATE whose article a reviewer retired meanwhile is SKIPPED, never a conflict', async () => {
    const { next, update } = await pendingFaqUpdate();
    const article = await faqArticle();
    await ctx.container.supportKnowledge.retireArticle(tenantA, owner, article.id, {
      idempotencyKey: key('retire'),
      expectedVersion: article.version,
    });
    expect(await applyAll(next.build.id)).toEqual({ applied: 0, conflicted: 0, skipped: 1 });
    const latest = (await ctx.container.supportKnowledgeBuild.latest(tenantA, owner))!;
    expect(latest.proposals.find((p) => p.id === update.id)).toMatchObject({
      kind: 'UPDATE',
      state: 'SKIPPED',
    });
    expect(await faqArticle()).toMatchObject({ state: 'RETIRED', body: article.body });
  });

  it('S1: … and KEEP_CURRENT works, keeping the edit', async () => {
    const { next, update } = await pendingFaqUpdate();
    await editArticle('ویرایش پس از ساخت.');
    await applyAll(next.build.id);
    await ctx.container.supportKnowledgeBuild.resolve(tenantA, owner, update.id, {
      idempotencyKey: key('keep'),
      choice: 'KEEP_CURRENT',
    });
    expect((await faqArticle()).body).toBe('ویرایش پس از ساخت.');
    expect(kinds(await build())['FAQ:چطور وصل شوم؟']).toBe('UNCHANGED');
  });

  it('S2: a product made reseller-only is proposed for RETIRE; only a named apply retires it', async () => {
    await applyAll((await build()).build.id);
    const inContext = async () =>
      (
        await ctx.container.supportContext.build(tenantA, null, { query: 'پلن عمومی' })
      ).payload.knowledge.map((k) => k.question);
    expect(await inContext()).toContain('پلن عمومی');
    await ctx.container.database.db.execute(
      sql`UPDATE products SET audience = 'RESELLERS_ONLY' WHERE id = ${productId}`,
    );
    const next = await build();
    const retire = next.proposals.find((p) => p.kind === 'RETIRE')!;
    expect(retire).toMatchObject({ sourceType: 'PRODUCT', state: 'PENDING' });
    expect(retire.content.title).toBe('پلن عمومی');
    expect(next.build.counts.retire).toBe(1);
    // «Apply all» never retires.
    expect(await applyAll(next.build.id)).toEqual({ applied: 0, conflicted: 0, skipped: 0 });
    expect(await inContext()).toContain('پلن عمومی');
    expect(
      await ctx.container.supportKnowledgeBuild.apply(tenantA, owner, next.build.id, {
        idempotencyKey: key('retire'),
        proposalIds: [retire.id],
      }),
    ).toEqual({ applied: 1, conflicted: 0, skipped: 0 });
    const article = (await builtArticles()).find((a) => a.sourceType === 'PRODUCT')!;
    expect(article.state).toBe('RETIRED');
    expect(await inContext()).not.toContain('پلن عمومی');
    // Retired is final for the build: the next run proposes nothing for it.
    expect((await build()).proposals.filter((p) => p.sourceType === 'PRODUCT')).toEqual([]);
  });

  it('S2: a RETIRE never forces over an article edited after the build', async () => {
    await applyAll((await build()).build.id);
    await ctx.container.database.db.execute(
      sql`UPDATE support_faqs SET status = 'INACTIVE' WHERE id = ${faqId}`,
    );
    const next = await build();
    const retire = next.proposals.find((p) => p.kind === 'RETIRE')!;
    expect(retire.sourceType).toBe('FAQ');
    await editArticle('ویرایش پس از ساخت.');
    expect(
      await ctx.container.supportKnowledgeBuild.apply(tenantA, owner, next.build.id, {
        idempotencyKey: key('retire'),
        proposalIds: [retire.id],
      }),
    ).toEqual({ applied: 0, conflicted: 0, skipped: 1 });
    expect(await faqArticle()).toMatchObject({ state: 'APPROVED', body: 'ویرایش پس از ساخت.' });
    // Proposed again against the edited text: still only a proposal.
    const again = (await build()).proposals.find((p) => p.kind === 'RETIRE')!;
    expect(again.baseBody).toBe('ویرایش پس از ساخت.');
  });

  it('S3: TAKE_BUILD refuses a conflict whose text is not clean (the assertClean backstop)', async () => {
    const { conflict } = await pendingFaqConflict();
    await ctx.container.database.db.execute(
      sql`UPDATE support_knowledge_build_proposals SET body = 'با ۰۹۱۲۱۲۳۴۵۶۷ تماس بگیرید' WHERE id = ${conflict.id}`,
    );
    await expectCode(
      ctx.container.supportKnowledgeBuild.resolve(tenantA, owner, conflict.id, {
        idempotencyKey: key('take'),
        choice: 'TAKE_BUILD',
      }),
      'support_knowledge.sensitive_content',
    );
    expect((await faqArticle()).body).toBe('متن دستی اپراتور.');
  });

  it('S3: a stopped tenant: no run, no apply, no resolve', async () => {
    const { next, conflict } = await pendingFaqConflict();
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    try {
      await expectCode(build(), 'support_knowledge.scope_stopped');
      await expectCode(applyAll(next.build.id), 'support_knowledge.scope_stopped');
      await expectCode(
        ctx.container.supportKnowledgeBuild.resolve(tenantA, owner, conflict.id, {
          idempotencyKey: key('keep'),
          choice: 'KEEP_CURRENT',
        }),
        'support_knowledge.scope_stopped',
      );
    } finally {
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
      );
    }
    const latest = (await ctx.container.supportKnowledgeBuild.latest(tenantA, owner))!;
    expect(latest.build.id).toBe(next.build.id);
    expect(latest.proposals.every((p) => p.state !== 'APPLIED')).toBe(true);
    expect(latest.proposals.find((p) => p.id === conflict.id)?.state).toBe('PENDING');
  });

  it('S3: the same apply key with different proposals is a payload mismatch', async () => {
    const first = await build();
    const [a, b] = first.proposals;
    const applyKey = key('apply');
    await ctx.container.supportKnowledgeBuild.apply(tenantA, owner, first.build.id, {
      idempotencyKey: applyKey,
      proposalIds: [a!.id],
    });
    await expectCode(
      ctx.container.supportKnowledgeBuild.apply(tenantA, owner, first.build.id, {
        idempotencyKey: applyKey,
        proposalIds: [b!.id],
      }),
      'platform.idempotency_payload_mismatch',
    );
    expect(await builtArticles()).toHaveLength(1);
  });

  it('S3: a manual edit that commits before the apply writes turns the UPDATE into a CONFLICT', async () => {
    const { next, update } = await pendingFaqUpdate();
    let hook: (() => Promise<unknown>) | null = () => editArticle('ویرایش هم‌زمان.');
    class EditFirst extends DrizzleSupportKnowledgeRepository {
      override async rewriteBuilt(
        ...args: Parameters<DrizzleSupportKnowledgeRepository['rewriteBuilt']>
      ) {
        const run = hook;
        hook = null;
        if (run !== null) await run();
        return super.rewriteBuilt(...args);
      }
    }
    const racing = serviceWith(new EditFirst(ctx.container.database.db));
    expect(
      await racing.apply(tenantA, owner, next.build.id, {
        idempotencyKey: key('apply'),
        proposalIds: null,
      }),
    ).toEqual({ applied: 0, conflicted: 1, skipped: 0 });
    expect((await faqArticle()).body).toBe('ویرایش هم‌زمان.');
    const latest = (await ctx.container.supportKnowledgeBuild.latest(tenantA, owner))!;
    expect(latest.proposals.find((p) => p.id === update.id)?.kind).toBe('CONFLICT');
  });

  it('S3: a manual edit that reaches the article after the apply wrote it is refused, not lost', async () => {
    const { next } = await pendingFaqUpdate();
    const before = await faqArticle();
    let edit: Promise<unknown> | null = null;
    class ApplyFirst extends DrizzleSupportKnowledgeRepository {
      override async rewriteBuilt(
        ...args: Parameters<DrizzleSupportKnowledgeRepository['rewriteBuilt']>
      ) {
        const written = await super.rewriteBuilt(...args);
        // The edit read the article before this write and now waits on its row lock.
        edit = ctx.container.supportKnowledge
          .updateArticle(tenantA, owner, before.id, {
            idempotencyKey: key('edit'),
            expectedVersion: before.version,
            content: { title: 'چطور وصل شوم؟', body: 'ویرایش دیر.', category: 'GENERAL', tags: [] },
          })
          .then(
            () => 'committed',
            (error: unknown) => (isNexaError(error) ? error.code : error),
          );
        await new Promise((resolve) => setTimeout(resolve, 400));
        return written;
      }
    }
    const racing = serviceWith(new ApplyFirst(ctx.container.database.db));
    expect(
      await racing.apply(tenantA, owner, next.build.id, {
        idempotencyKey: key('apply'),
        proposalIds: null,
      }),
    ).toMatchObject({ applied: 1, conflicted: 0 });
    expect(await edit).toBe('support_knowledge.version_conflict');
    expect((await faqArticle()).body).toBe('پاسخ تازهٔ منبع.');
  });

  it('S3/S4: an article that appeared for an ADD meanwhile is never doubled; the ADD is SKIPPED', async () => {
    const first = await build();
    const add = first.proposals.find((p) => p.sourceType === 'FAQ')!;
    await new DrizzleSupportKnowledgeRepository(ctx.container.database.db).insertArticle(
      tenantA,
      {
        id: ctx.container.ids.uuid(),
        source: 'NEXA_BUILD',
        state: 'APPROVED',
        content: add.content,
        revision: 1,
        candidateId: null,
        createdByAdminId: null,
        built: { sourceType: 'FAQ', sourceKey: faqId, hash: add.hash },
        now: ctx.container.clock.now(),
      },
      undefined,
    );
    const result = await applyAll(first.build.id);
    expect(result).toEqual({ applied: first.proposals.length - 1, conflicted: 0, skipped: 1 });
    expect((await builtArticles()).filter((a) => a.sourceType === 'FAQ')).toHaveLength(1);
    const latest = (await ctx.container.supportKnowledgeBuild.latest(tenantA, owner))!;
    expect(latest.proposals.find((p) => p.id === add.id)?.state).toBe('SKIPPED');
    const [audit] = (
      await ctx.container.database.db.execute(
        sql`SELECT after FROM audit_logs WHERE action = 'support_knowledge.build.apply' ORDER BY occurred_at DESC LIMIT 1`,
      )
    ).rows as { after: { skipped: string[] } }[];
    expect(audit!.after.skipped).toEqual([add.id]);
  });

  it('N1: two runs at once with different keys: one build, and the other is a clean conflict', async () => {
    const gate = barrier(2, 1500);
    class Racing extends DrizzleSupportKnowledgeRepository {
      override async supersedeOpenBuild(
        ...args: Parameters<DrizzleSupportKnowledgeRepository['supersedeOpenBuild']>
      ) {
        await super.supersedeOpenBuild(...args);
        await gate.arrive();
      }
    }
    const racing = serviceWith(new Racing(ctx.container.database.db));
    const results = await Promise.allSettled([
      racing.run(tenantA, owner, { idempotencyKey: key('run') }),
      racing.run(tenantA, owner, { idempotencyKey: key('run') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isNexaError(refused.reason) ? refused.reason.code : refused.reason).toBe(
      'support_knowledge.build_running',
    );
    const open = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM support_knowledge_builds WHERE state = 'OPEN'`,
    );
    expect((open.rows[0] as { n: number }).n).toBe(1);
  });

  it('N2: clipped and capped items are counted in the audit row and shown on the build', async () => {
    await ctx.container.database.db.execute(sql`
      INSERT INTO support_faqs (id, tenant_id, question, answer, status, sort_order)
      SELECT gen_random_uuid(), ${tenantA.tenantId}, 'سؤال انبوه ' || g, 'پاسخ', 'ACTIVE', 50
      FROM generate_series(1, 101) AS g`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO support_faqs (id, tenant_id, question, answer, status, sort_order)
      VALUES (gen_random_uuid(), ${tenantA.tenantId}, ${'س'.repeat(250)}, 'پاسخ بلند', 'ACTIVE', 0)`);
    const detail = await build();
    // 103 active FAQ entries, 100 kept: three capped; the long question is clipped.
    expect(detail.proposals.filter((p) => p.sourceType === 'FAQ')).toHaveLength(100);
    const view = buildView(detail);
    expect([view.truncated, view.capped]).toEqual([1, 3]);
    const [audit] = (
      await ctx.container.database.db.execute(
        sql`SELECT after FROM audit_logs WHERE action = 'support_knowledge.build.run' ORDER BY occurred_at DESC LIMIT 1`,
      )
    ).rows as { after: { truncated: number; capped: number } }[];
    expect([audit!.after.truncated, audit!.after.capped]).toEqual([1, 3]);
  });
  // --- Phase 4 PR-2 item 4: the automatic refresh ------------------------------------------

  const job = () => systemJobActor(SUPPORT_KNOWLEDGE_REFRESH_JOB, key('corr') as CorrelationId);

  /** Turns `support.knowledge.auto_refresh` on (once per case: the database is reset). */
  async function autoRefreshOn() {
    await ctx.container.settingsService.set(tenantA, owner, {
      idempotencyKey: key('auto'),
      key: 'support.knowledge.auto_refresh',
      value: true,
      expectedVersion: null,
    });
  }

  it('PR-2 auto refresh: off by default; on, it builds AND applies as SYSTEM_JOB, audited, idempotent', async () => {
    const service = ctx.container.supportKnowledgeBuild;
    expect(await service.autoRefresh(tenantA, job())).toEqual({ outcome: 'OFF' });
    expect(await service.pendingRefreshSignature(tenantA)).toBeNull();
    expect(await builtArticles()).toEqual([]);

    await autoRefreshOn();
    const signature = await service.pendingRefreshSignature(tenantA);
    expect(signature).not.toBeNull();
    const result = await service.autoRefresh(tenantA, job());
    expect(result).toMatchObject({ outcome: 'REFRESHED', conflicted: 0, skipped: 0 });
    const articles = await builtArticles();
    expect(articles.map((a) => a.title)).toEqual(
      expect.arrayContaining(['چطور وصل شوم؟', 'پلن عمومی']),
    );
    expect(articles.every((a) => a.state === 'APPROVED')).toBe(true);
    // No admin is named for a job; the audit row names the job.
    const builds = await ctx.container.database.db.execute(
      sql`SELECT created_by_admin_id FROM support_knowledge_builds WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect(builds.rows).toEqual([{ created_by_admin_id: null }]);
    const audits = await ctx.container.database.db.execute(
      sql`SELECT actor_type FROM audit_logs WHERE action = 'support_knowledge.build.auto_refresh'`,
    );
    expect(audits.rows).toEqual([{ actor_type: 'SYSTEM_JOB' }]);
    // Nothing left to change: nothing is written.
    expect(await service.pendingRefreshSignature(tenantA)).toBeNull();
    expect(await service.autoRefresh(tenantA, job())).toEqual({ outcome: 'UNCHANGED' });
    const count = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM support_knowledge_builds`,
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it('PR-2 auto refresh: a changed source updates; a reviewer-edited article stays a CONFLICT', async () => {
    await autoRefreshOn();
    const service = ctx.container.supportKnowledgeBuild;
    await service.autoRefresh(tenantA, job());
    // The owner changes the FAQ: applied by itself.
    await editFaqSource('پاسخ تازه.', 1);
    expect(await service.autoRefresh(tenantA, job())).toMatchObject({
      outcome: 'REFRESHED',
      applied: 1,
    });
    expect((await faqArticle()).body).toBe('پاسخ تازه.');
    // A reviewer edits the article, then the source changes again: never overwritten.
    await editArticle('متن دستی اپراتور.');
    await editFaqSource('باز هم تازه.', 2);
    const result = await service.autoRefresh(tenantA, job());
    expect(result).toMatchObject({ outcome: 'REFRESHED', applied: 0, conflicted: 1 });
    expect((await faqArticle()).body).toBe('متن دستی اپراتور.');
    const latest = (await service.latest(tenantA, owner))!;
    expect(latest.proposals.find((p) => p.sourceType === 'FAQ')).toMatchObject({
      kind: 'CONFLICT',
      state: 'PENDING',
    });
    // The same pending conflict is not rewritten pass after pass.
    expect(await service.autoRefresh(tenantA, job())).toEqual(result);
  });

  it('PR-2 auto refresh: a withdrawn source is retired automatically', async () => {
    await autoRefreshOn();
    const service = ctx.container.supportKnowledgeBuild;
    await service.autoRefresh(tenantA, job());
    await ctx.container.database.db.execute(
      sql`UPDATE products SET audience = 'RESELLERS_ONLY' WHERE id = ${productId}`,
    );
    expect(await service.autoRefresh(tenantA, job())).toMatchObject({ outcome: 'REFRESHED' });
    const retired = await ctx.container.supportKnowledge.listArticles(tenantA, owner, {
      source: 'NEXA_BUILD',
      state: 'RETIRED',
    });
    expect(retired.map((a) => a.title)).toContain('پلن عمومی');
  });

  it('PR-2 auto refresh: a stopped tenant is left alone; a job without maintenance.run is refused', async () => {
    await autoRefreshOn();
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    try {
      expect(await ctx.container.supportKnowledgeBuild.autoRefresh(tenantA, job())).toEqual({
        outcome: 'INACTIVE',
      });
    } finally {
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
      );
    }
    expect(await builtArticles()).toEqual([]);
    // A customer-type actor holds no maintenance.run: denied by default, audited.
    await expectCode(
      ctx.container.supportKnowledgeBuild.autoRefresh(tenantA, {
        type: 'CUSTOMER',
        id: 'c1',
        label: 'customer',
        surface: 'TELEGRAM',
        correlationId: key('c') as CorrelationId,
      }),
      'platform.permission_denied',
    );
    expect(await builtArticles()).toEqual([]);
  });

  it('PR-2 the refresh loop: waits two minutes after the last change, then applies; nightly at once', async () => {
    await autoRefreshOn();
    let now = new Date('2026-11-01T10:00:00.000Z');
    const logs: string[] = [];
    const loop = new SupportKnowledgeRefreshLoop(ctx.container.supportKnowledgeBuild, {
      scope: () => tenantA,
      intervalMs: 60_000,
      now: () => now,
      correlationId: () => key('loop'),
      logger: { info: (_c, m) => logs.push(m), error: (_c, m) => logs.push(m) },
    });
    expect(await loop.tick()).toMatchObject({ action: 'WAITING' });
    now = new Date(now.getTime() + 60_000);
    expect(await loop.tick()).toMatchObject({ action: 'WAITING' });
    expect(await builtArticles()).toEqual([]);
    now = new Date(now.getTime() + 60_000);
    expect(await loop.tick()).toMatchObject({
      action: 'REFRESHED',
      result: { outcome: 'REFRESHED' },
    });
    expect((await builtArticles()).length).toBeGreaterThan(0);
    expect(await loop.tick()).toEqual({ action: 'IDLE' });
    // Nightly: a change is applied on the first tick of the nightly hour, without waiting.
    await editFaqSource('شبانه.', 1);
    now = new Date('2026-11-01T23:00:30.000Z');
    expect(await loop.tick()).toMatchObject({ action: 'REFRESHED' });
    expect((await faqArticle()).body).toBe('شبانه.');
    expect(logs).not.toContain('support knowledge refresh pass failed');
  });
  it('review of PR #367: an automatically retired source that returns is reinstated; a reviewer’s retirement is not', async () => {
    await autoRefreshOn();
    const service = ctx.container.supportKnowledgeBuild;
    await service.autoRefresh(tenantA, job());
    const productArticle = async () =>
      (await builtArticles()).find((a) => a.sourceType === 'PRODUCT' && a.title === 'پلن عمومی')!;
    // The product leaves the public catalogue: retired by the refresh.
    await ctx.container.database.db.execute(
      sql`UPDATE products SET audience = 'RESELLERS_ONLY' WHERE id = ${productId}`,
    );
    await service.autoRefresh(tenantA, job());
    expect((await productArticle()).state).toBe('RETIRED');
    // It comes back: the next refresh reinstates it, as the next revision.
    await ctx.container.database.db.execute(
      sql`UPDATE products SET audience = 'EVERYONE' WHERE id = ${productId}`,
    );
    expect(await service.pendingRefreshSignature(tenantA)).not.toBeNull();
    expect(await service.autoRefresh(tenantA, job())).toMatchObject({
      outcome: 'REFRESHED',
      reinstated: 1,
    });
    const back = await productArticle();
    expect(back.state).toBe('APPROVED');
    expect(back.revision).toBe(2);
    expect(await service.pendingRefreshSignature(tenantA)).toBeNull();
    // A reviewer's own retirement, with the source still present, is never undone.
    await ctx.container.supportKnowledge.retireArticle(tenantA, owner, back.id, {
      idempotencyKey: key('retire'),
      expectedVersion: back.version,
    });
    expect(await service.pendingRefreshSignature(tenantA)).toBeNull();
    expect(await service.autoRefresh(tenantA, job())).toEqual({ outcome: 'UNCHANGED' });
    expect((await productArticle()).state).toBe('RETIRED');
  });
});
