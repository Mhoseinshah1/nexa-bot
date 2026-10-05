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
 ('TB9-05',[(BUILD,"            (p.kind === 'ADD' || p.kind === 'UPDATE') &&","            true &&"),
            (REPO,"          input.unedited\n            ? eq(supportKnowledgeArticles.builtRevision, input.baseRevision)\n            : undefined,","          undefined,")],T_I,'reviewer edited is a CONFLICT'),
 ('TB9-06',[(BUILD,"    if (build.state !== 'OPEN') {","    if (false) {")],T_I,'superseded build applies nothing'),
 ('TB9-07',[(BUILD,"        await this.deps.repository.supersedeOpenBuild(scope, now, tx);\n","")],T_I,'superseded build applies nothing'),
 ('TB9-08',[(BUILD,"    if (replay !== null) return replay.result;\n","")],T_I,'apply publishes, is idempotent'),
 ('TB9-09',[(REVIEW,"  'support_knowledge.review' satisfies PermissionKey;","  'support_knowledge.view' satisfies PermissionKey;")],T_I,'permissions: support may view'),
 # The explicit choices.
 ('TB9-10',[(REPO,"      .set({ builtHash: input.hash, updatedAt: input.now })","      .set({ updatedAt: input.now })")],T_I,'reviewer edited is a CONFLICT'),
 ('TB9-11',[(REPO,"        builtRevision: sql`${supportKnowledgeArticles.revision} + 1`,\n","")],T_I,'changed source is an UPDATE'),
 # The source allowlist: customer-facing fields only.
 ('TB9-12',[(SRC,"      { status: 'ACTIVE', audience: 'EVERYONE' },","      { status: 'ACTIVE' },")],T_I,'no secret, internal, price or reseller'),
 ('TB9-13',[(SRC,"        product.description ?? '',\n","        product.description ?? '',\n        String(product.price?.amountMinor ?? ''),\n")],T_I,'no secret, internal, price or reseller'),
 ('TB9-14',[(SRC,"          !hasPlaceholder(route.instructions),","          true,")],T_U,'no secret, price or internal field'),
 # TB3: a built FAQ entry is read once.
 ('TB9-15',[(BUILDER,"            !articles.some(\n              (article) => article.sourceType === 'FAQ' && article.sourceKey === row.id,\n            ),","            true,")],T_I,'carries a built FAQ entry once'),
 # Web: apply-all names no proposal; a conflict offers only the choices.
 ('TB9-16',[(PAGE,"                buildId: build.id,\n                proposalIds: null,","                buildId: build.id,\n                proposalIds: [],")],T_W,'apply all names no proposal'),
 ('TB9-17',[(PAGE,"{proposal.kind === 'CONFLICT' ? (","{false ? (")],T_W,'only the two explicit choices'),
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
