import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type ActorContext,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type SupportKnowledgeProposalKind,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { buildView } from '../../apps/api/src/surfaces/web/support-knowledge.controller';
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
  }) {
    const repo = new DrizzleProductRepository(ctx.container.database.db);
    const created = await repo.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: input.title,
        description: 'یک ماهه با پشتیبانی',
        audience: input.audience,
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
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
    expect(result).toEqual({ applied: first.proposals.length, conflicted: 0 });
    // The same key replays the same answer; a new key finds nothing left to apply.
    expect(await applyAll(first.build.id, applyKey)).toEqual(result);
    expect(await applyAll(first.build.id)).toEqual({ applied: 0, conflicted: 0 });
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
    const { payload } = await ctx.container.supportContext.build(tenantA, null);
    const faqEntries = payload.knowledge.filter((k) => k.question === 'چطور وصل شوم؟');
    expect(faqEntries).toEqual([
      {
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
    ).toEqual({ applied: 0, conflicted: 0 });
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
    expect(await applyAll(next.build.id)).toEqual({ applied: 0, conflicted: 1 });
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
   * TB9 × TB8 (PR #203): every article passes `assertClean`, and a URL is a HOST or URL_TOKEN
   * hit. Fail closed: the build never copies an app's links into knowledge (a fixed line points
   * to the app list), a source item the scrubber still matches is EXCLUDED from the change-set
   * (only its count and kinds are audited), and apply refuses unclean text as a backstop.
   */
  it('built knowledge carries no link: app URLs are not copied, a linked FAQ is excluded, apply refuses', async () => {
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
      answer: 'راهنما در https://help.example.com/full است.',
      sortOrder: 1,
    });
    const detail = await build();
    const stored = JSON.stringify(
      (
        await c.database.db.execute(
          sql`SELECT title, body, tags::text AS tags FROM support_knowledge_build_proposals`,
        )
      ).rows,
    );
    for (const leaked of ['example.com', 'https://', 'downloads.', 'help.example']) {
      expect(stored, leaked).not.toContain(leaked);
    }
    const app = detail.proposals.find((p) => p.sourceType === 'CLIENT_APP');
    expect(app?.content.body).toContain('فهرست برنامه‌های ربات');
    expect(detail.proposals.map((p) => p.content.title)).not.toContain('راهنمای کامل کجاست؟');
    expect(detail.proposals.map((p) => p.content.title)).toContain('چطور وصل شوم؟');
    const [audit] = (
      await c.database.db.execute(
        sql`SELECT after FROM audit_logs WHERE action = 'support_knowledge.build.run' ORDER BY occurred_at DESC LIMIT 1`,
      )
    ).rows as { after: { excluded: { count: number; kinds: string[] } } }[];
    expect(audit!.after.excluded).toEqual({ count: 1, kinds: ['HOST'] });

    // The backstop: a proposal whose text is not clean is never published, by apply-all or a choice.
    await c.database.db.execute(
      sql`UPDATE support_knowledge_build_proposals SET body = body || ' https://x.example.org'
          WHERE source_type = 'FAQ'`,
    );
    await expectCode(applyAll(detail.build.id), 'support_knowledge.sensitive_content');
    expect(await builtArticles()).toEqual([]);
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
});
