"""TB9 (the one-click knowledge build) mutation driver (docs/support-agent/tb9-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
Most mutants need the integration database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-tb9.py [TB9-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

K='apps/api/src/modules/control/support-knowledge/'
DIFF=K+'domain/build-diff.ts'
REPO=K+'infrastructure/drizzle-support-knowledge.repository.ts'
SRC=K+'infrastructure/nexa-knowledge-sources.ts'
BUILD=K+'application/support-knowledge-build.service.ts'
REVIEW=K+'application/support-knowledge.service.ts'
BUILDER='apps/api/src/modules/commerce/support-context/application/support-context.builder.ts'
PAGE='apps/web/src/pages/knowledge-build.tsx'
PRODUCTS='apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository.ts'
PRODUCT_SVC='apps/api/src/modules/commerce/catalog/application/product.service.ts'
T_I=('integration','tests/integration/support-knowledge-build.test.ts')
T_U=('unit','tests/unit/support-knowledge-build.test.ts')
T_W=('web','tests/web/knowledge-build.test.tsx')

M=[
 # The diff: what is a conflict, what is unchanged.
 ('TB9-01',[(DIFF,"  if (article.builtRevision !== null && article.revision === article.builtRevision) return 'UPDATE';\n  return 'CONFLICT';","  return 'UPDATE';")],T_U,'CONFLICT when the source changed'),
 ('TB9-02',[(DIFF,"  if (article.builtHash === hash) return 'UNCHANGED';\n","")],T_I,'all UNCHANGED'),
 ('TB9-03',[(DIFF,"  if (article.state === 'RETIRED') return 'UNCHANGED';\n","")],T_U,'retired article is never brought back'),
 # Apply: conditional on the base; a conflict never applies; superseded builds; idempotency.
 ('TB9-04',[(REPO,"          eq(supportKnowledgeArticles.state, 'APPROVED'),\n          eq(supportKnowledgeArticles.revision, input.baseRevision),\n          input.unedited","          eq(supportKnowledgeArticles.state, 'APPROVED'),\n          input.unedited")],T_I,'edited AFTER the build'),
 ('TB9-05',[(BUILD,"            (p.kind === 'ADD' || p.kind === 'UPDATE' || (p.kind === 'RETIRE' && wanted !== null)) &&","            p.kind !== 'RETIRE' &&"),
            (REPO,"          input.unedited\n            ? eq(supportKnowledgeArticles.builtRevision, input.baseRevision)\n            : undefined,","          undefined,")],T_I,'reviewer edited is a CONFLICT'),
 ('TB9-06',[(BUILD,"    if (build.state !== 'OPEN') {","    if (false) {")],T_I,'superseded build applies nothing'),
 ('TB9-07',[(BUILD,"        await this.deps.repository.supersedeOpenBuild(scope, now, tx);\n","")],T_I,'superseded build applies nothing'),
 ('TB9-08',[(BUILD,"    if (replay !== null) return replay.result;\n","")],T_I,'apply publishes, is idempotent'),
 ('TB9-09',[(REVIEW,"  'support_knowledge.review' satisfies PermissionKey;","  'support_knowledge.view' satisfies PermissionKey;")],T_I,'permissions: support may view'),
 # The explicit choices.
 ('TB9-10',[(REPO,"      .set({ builtHash: input.hash, updatedAt: input.now })","      .set({ updatedAt: input.now })")],T_I,'reviewer edited is a CONFLICT'),
 ('TB9-11',[(REPO,"        builtRevision: sql`${supportKnowledgeArticles.revision} + 1`,\n","")],T_I,'changed source is an UPDATE'),
 # The source allowlist: customer-facing fields only.
 ('TB9-12',[(PRODUCT_SVC,"      Math.max(limit, 1),\n      view.panelIds,\n      view.audience,","      Math.max(limit, 1),\n      view.panelIds,\n      { kind: 'RESELLER', productIds: 'ALL', categoryIds: 'ALL' },")],T_I,'no secret, internal, price or reseller'),
 ('TB9-13',[(SRC,"        product.description ?? '',\n","        product.description ?? '',\n        String(product.price?.amountMinor ?? ''),\n")],T_I,'no secret, internal, price or reseller'),
 ('TB9-14',[(SRC,"          !hasPlaceholder(route.instructions),","          true,")],T_U,'no secret, price or internal field'),
 # TB3: a built FAQ entry is read once.
 ('TB9-15',[(BUILDER,"            !articles.some(\n              (article) => article.sourceType === 'FAQ' && article.sourceKey === row.id,\n            ),","            true,")],T_I,'carries a built FAQ entry once'),
 # Web: apply-all names no proposal; a conflict offers only the choices.
 ('TB9-16',[(PAGE,"                buildId: build.id,\n                proposalIds: null,","                buildId: build.id,\n                proposalIds: [],")],T_W,'apply all names no proposal'),
 ('TB9-17',[(PAGE,"{proposal.kind === 'CONFLICT' ? (","{false ? (")],T_W,'only the two explicit choices'),
 # TB9 × TB8 (PR #203): built knowledge carries no link, fail closed.
 ('TB9-18',[(BUILD,"      return kinds.length === 0;\n","      return true;\n")],T_I,'carries no link'),
 ('TB9-19',[(SRC,"        BUILD_LABELS.appLinks,\n","        `${app.officialUrl}`,\n")],T_I,'carries no link'),
 ('TB9-20',[(BUILD,"    if (!claimed) return 'NONE';\n    // The backstop: no write path puts unclean text in an article, the build's included.\n    assertClean(target.content);\n","    if (!claimed) return 'NONE';\n")],T_I,'carries no link'),
 # Substitute review of PR #204.
 # B1: the customer catalogue's own predicate, each dimension.
 ('TB9-21',[(PRODUCTS,"      eq(productCategories.status, 'ACTIVE'),\n      eq(productCategories.visibility, 'VISIBLE'),\n    ) as SQL;","      eq(productCategories.status, 'ACTIVE'),\n    ) as SQL;")],T_I,'B1:'),
 ('TB9-22',[(PRODUCTS,"      eq(productCategories.status, 'ACTIVE'),\n      eq(productCategories.visibility, 'VISIBLE'),\n    ) as SQL;","      eq(productCategories.visibility, 'VISIBLE'),\n    ) as SQL;")],T_I,'B1:'),
 ('TB9-23',[(PRODUCTS,"      .innerJoin(\n        productCategories,\n        and(\n          eq(productCategories.id, products.categoryId),\n          eq(productCategories.tenantId, products.tenantId),\n        ),\n      )\n      .where(this.customerVisibleProduct(tenantId, eligiblePanelIds, audience))","      .leftJoin(\n        productCategories,\n        and(\n          eq(productCategories.id, products.categoryId),\n          eq(productCategories.tenantId, products.tenantId),\n        ),\n      )\n      .where(sql`(${this.customerVisibleProduct(tenantId, eligiblePanelIds, audience)} OR (${products.categoryId} IS NULL AND ${products.tenantId} = ${tenantId} AND ${products.status} = 'ACTIVE' AND ${products.audience} = 'EVERYONE'))`)")],T_I,'B1:'),
 ('TB9-24',[(PRODUCTS,"      eq(products.status, 'ACTIVE'),\n      sql`${products.panelId} = ANY(${sql.param([...eligiblePanelIds])}::uuid[])`,\n      audienceClause(audience),","      eq(products.status, 'ACTIVE'),\n      audienceClause(audience),")],T_I,'B1:'),
 # S1: an apply-time conflict carries the article as it is now.
 ('TB9-25',[(REPO,"        kind: 'CONFLICT',\n        baseRevision: base.revision,\n        baseTitle: base.title,\n        baseBody: base.body,\n","        kind: 'CONFLICT',\n")],T_I,'S1:'),
 # N3: the counts follow the kinds.
 ('TB9-26',[(BUILD,"          await this.deps.repository.recountBuild(scope, buildId, now, tx);\n","")],T_I,'S1: an UPDATE that meets'),
 # S2: RETIRE.
 ('TB9-27',[(DIFF,"    if (present.has(sourceRef(article.sourceType, article.sourceKey))) continue;","    continue;")],T_I,'S2: a product made reseller-only'),
 ('TB9-28',[(BUILD,"(p.kind === 'RETIRE' && wanted !== null)","p.kind === 'RETIRE'")],T_I,'S2: a product made reseller-only'),
 ('TB9-29',[(BUILD,"      before.revision !== target.baseRevision\n","      false\n")],T_I,'S2: a RETIRE never forces'),
 ('TB9-30',[(DIFF,"    if (incomplete.has(article.sourceType)) continue;\n","")],T_U,'no RETIRE for a retired article'),
 ('TB9-31',[(DIFF,"    if (article.state === 'RETIRED') continue;\n","")],T_I,'S2: a product made reseller-only'),
 # S3: rules that had no test.
 ('TB9-32',[(BUILD,"        if (command.choice === 'TAKE_BUILD') {\n          assertClean(proposal.content);\n","        if (command.choice === 'TAKE_BUILD') {\n")],T_I,'S3: TAKE_BUILD refuses'),
 ('TB9-33',[(BUILD,"        await this.assertScopeActive(scope, tx);\n        const now = this.deps.clock.now();\n        const built =","        const now = this.deps.clock.now();\n        const built =")],T_I,'S3: a stopped tenant'),
 ('TB9-34',[(BUILD,"        await this.assertScopeActive(scope, tx);\n        const now = this.deps.clock.now();\n        await this.requireOpenBuild(scope, buildId, tx);","        const now = this.deps.clock.now();\n        await this.requireOpenBuild(scope, buildId, tx);")],T_I,'S3: a stopped tenant'),
 ('TB9-35',[(BUILD,"        await this.assertScopeActive(scope, tx);\n        const now = this.deps.clock.now();\n        const proposal =","        const now = this.deps.clock.now();\n        const proposal =")],T_I,'S3: a stopped tenant'),
 ('TB9-36',[(BUILD,"      buildId,\n      proposalIds: command.proposalIds,\n    });","      buildId,\n    });")],T_I,'payload mismatch'),
 ('TB9-37',[(REPO,"          eq(supportKnowledgeArticles.state, 'APPROVED'),\n          eq(supportKnowledgeArticles.revision, input.baseRevision),\n          input.unedited","          eq(supportKnowledgeArticles.state, 'APPROVED'),\n          input.unedited")],T_I,'commits before the apply writes'),
 ('TB9-38',[(REPO,"        builtHash: input.hash,\n        version: sql`${supportKnowledgeArticles.version} + 1`,\n","        builtHash: input.hash,\n")],T_I,'after the apply wrote it'),
 ('TB9-39',[(BUILD,"    if (existing !== undefined) return this.skip(scope, actor, target, now, tx);\n","")],T_I,'appeared for an ADD'),
 # S4: a proposal that cannot apply is closed, not left PENDING.
 ('TB9-40',[(BUILD,"    if (existing !== undefined) return this.skip(scope, actor, target, now, tx);","    if (existing !== undefined) return 'SKIPPED';")],T_I,'appeared for an ADD'),
 ('TB9-41',[(BUILD,"      if (current === null || current.state !== 'APPROVED') {","      if (current === null) {")],T_I,'S4: an UPDATE whose article'),
 # N1, N2.
 ('TB9-42',[(BUILD,"          if (isUniqueViolation(error, 'support_knowledge_builds_open_key')) {","          if (false) {")],T_I,'N1:'),
 ('TB9-43',[(SRC,"        if (draft.truncated) truncated += 1;\n","")],T_I,'N2:'),
 ('TB9-44',[(SRC,"      const dropped = drafts.length - kept.length + (group.more ? 1 : 0);","      const dropped = 0;")],T_I,'N2:'),
 ('TB9-45',[(BUILD,"            after: { ...counts, excluded, truncated, capped },","            after: { ...counts, excluded },")],T_I,'N2:'),
 # Web: RETIRE has its own label and its own button.
 ('TB9-46',[(PAGE,"  RETIRE: 'web.kb_kind_retire',","  RETIRE: 'web.kb_kind_update',")],T_W,'S2: a RETIRE has its own label'),
 ('TB9-47',[(PAGE,"proposal.kind === 'RETIRE' ? 'web.kb_retire_one' : 'web.kb_apply_one'","'web.kb_apply_one'")],T_W,'S2: a RETIRE has its own label'),
]

only=sys.argv[1:]
killed=0; ran=0
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  originals={}; ok=True
  for f,a,b in edits:
    s=originals.get(f) or open(f).read()
    originals.setdefault(f,s)
    cur=open(f).read()
    if cur.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,cur.count(a),flush=True); ok=False; break
    open(f,'w').write(cur.replace(a,b))
  if ok:
    ran+=1
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    if r.returncode!=0: killed+=1
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:2],flush=True)
  for f,s in originals.items(): open(f,'w').write(s)
print(f'{killed} of {ran} killed',flush=True)
