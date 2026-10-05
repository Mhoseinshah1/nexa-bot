"""TB8 (controlled learning) mutation driver (docs/support-agent/tb8-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
Most mutants need the integration database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-tb8.py [TB8-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

K='apps/api/src/modules/control/support-knowledge/'
REPO=K+'infrastructure/drizzle-support-knowledge.repository.ts'
REVIEW=K+'application/support-knowledge.service.ts'
LEARN=K+'application/support-learning.service.ts'
PROMPT=K+'domain/learning-prompt.ts'
DEDUPE=K+'domain/dedupe.ts'
SCRUB=K+'domain/scrubber.ts'
BUILDER='apps/api/src/modules/commerce/support-context/application/support-context.builder.ts'
CONV='apps/api/src/modules/commerce/business-chats/application/business-conversation.service.ts'
LOOP='apps/api/src/modules/control/support-ai/application/assistant-loop.ts'
PAGE='apps/web/src/pages/support-knowledge.tsx'
T_I=('integration','tests/integration/support-learning.test.ts')
T_U=('unit','tests/unit/support-learning-scrubber.test.ts')
T_W=('web','tests/web/support-knowledge.test.tsx')
T_L=('unit','tests/unit/assistant-loop.test.ts')

M=[
 # Only APPROVED and enabled knowledge reaches the agent, in SQL.
 ('TB8-01',[(REPO,"          eq(supportKnowledgeArticles.state, 'APPROVED'),\n          eq(supportKnowledgeArticles.enabled, true),","          eq(supportKnowledgeArticles.enabled, true),")],T_I,'a draft, a disabled and a retired'),
 ('TB8-02',[(REPO,"          eq(supportKnowledgeArticles.state, 'APPROVED'),\n          eq(supportKnowledgeArticles.enabled, true),","          eq(supportKnowledgeArticles.state, 'APPROVED'),")],T_I,'a draft, a disabled and a retired'),
 ('TB8-03',[(BUILDER,"      this.deps.knowledge.activeForContext(scope, SUPPORT_CONTEXT_LIMITS.knowledge),","      Promise.resolve([] as readonly { title: string; body: string }[]),")],T_I,'approve publishes ONE article'),
 # A decision is PENDING-only, versioned, idempotent and scoped.
 ('TB8-04',[(REVIEW,"        if (before.state !== 'PENDING') throw notInState(before.state);\n        assertVersion(before.version, command.expectedVersion);\n        const after = await this.deps.repository.rejectCandidate(","        assertVersion(before.version, command.expectedVersion);\n        const after = await this.deps.repository.rejectCandidate("),
            (REPO,"        rejectReason: 'REVIEWER',\n        reviewedByAdminId: input.reviewerAdminId,\n        reviewedAt: input.now,\n        version: sql`${supportLearningCandidates.version} + 1`,\n        updatedAt: input.now,\n      })\n      .where(\n        and(\n          eq(supportLearningCandidates.tenantId, tenantId),\n          eq(supportLearningCandidates.id, id),\n          eq(supportLearningCandidates.state, 'PENDING'),\n","        rejectReason: 'REVIEWER',\n        reviewedByAdminId: input.reviewerAdminId,\n        reviewedAt: input.now,\n        version: sql`${supportLearningCandidates.version} + 1`,\n        updatedAt: input.now,\n      })\n      .where(\n        and(\n          eq(supportLearningCandidates.tenantId, tenantId),\n          eq(supportLearningCandidates.id, id),\n")],T_I,'approve publishes ONE article'),
 ('TB8-05',[(REVIEW,"        if (before.state !== 'PENDING') throw notInState(before.state);\n        assertVersion(before.version, command.expectedVersion);\n        const content = command.edit ?? asProposed(before);","        if (before.state !== 'PENDING') throw notInState(before.state);\n        const content = command.edit ?? asProposed(before);"),
            (REPO,"          eq(supportLearningCandidates.state, 'PENDING'),\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /** PENDING → REJECTED","          eq(supportLearningCandidates.state, 'PENDING'),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /** PENDING → REJECTED")],T_I,'a stale version is refused'),
 ('TB8-06',[(REVIEW,"    if (found !== null) {\n      const replayed","    if (found !== null && false) {\n      const replayed")],T_I,'approve publishes ONE article'),
 ('TB8-07',[(REVIEW,"  'support_knowledge.review' satisfies PermissionKey;","  'support_knowledge.view' satisfies PermissionKey;")],T_I,'permissions: support views'),
 ('TB8-08',[(REPO,"      .where(\n        and(eq(supportLearningCandidates.tenantId, tenantId), eq(supportLearningCandidates.id, id)),\n      )\n      .limit(1);\n    return row === undefined ? null : candidate(row);","      .where(eq(supportLearningCandidates.id, id))\n      .limit(1);\n    return row === undefined ? null : candidate(row);")],T_I,'tenant isolation'),
 ('TB8-09',[(REVIEW,"        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {","        if (false) {")],T_I,'a stopped tenant'),
 # What is approved is scrubbed again; an approved edit is a new revision.
 ('TB8-10',[(REVIEW,"  if (kinds.length > 0) {\n    throw errors.conflict(","  if (false) {\n    throw errors.conflict(")],T_I,'still holds personal data'),
 ('TB8-11',[(REVIEW,"        const publish = before.state === 'APPROVED';","        const publish = false;")],T_I,'a draft, a disabled and a retired'),
 # Learning: scrub before and after the provider; AI OFF learns nothing.
 ('TB8-12',[(PROMPT,"    const result = scrubSensitive(value.slice(0, max));","    const result = { text: value.slice(0, max), kinds: [] as string[] };")],T_I,'never reads the customer'),
 ('TB8-13',[(LEARN,"        const rejected = kinds.length > 0;","        const rejected = false;")],T_I,'rejected automatically'),
 ('TB8-14',[(LEARN,"    if (config.mode === 'OFF') return;\n","")],T_I,'AI OFF'),
 ('TB8-15',[(LEARN,"    if (config.mode === 'OFF') return this.finish(scope, job.id, 'DONE', 'dropped_mode');\n","")],T_I,'AI OFF'),
 # Volume: the reply's key, the 24-hour window, duplicates.
 ('TB8-16',[(LEARN,"      return 'CONVERSATION';\n","")],T_I,'24-hour window'),
 ('TB8-17',[(LEARN,"    const duplicate = findDuplicate(normalizedTitle, recent);","    const duplicate = null as { id: string } | null;\n    void findDuplicate;\n    void recent;")],T_I,'NEAR duplicate'),
 ('TB8-18',[(DEDUPE,"    .replace(/[يى]/gu, 'ی')\n","")],T_U,'normalises Arabic letters'),
 # Which replies may teach: delivered, a person's, in that conversation.
 ('TB8-19',[(LEARN,"    row.state === 'DELIVERED' &&\n","")],T_I,'only a DELIVERED reply'),
 ('TB8-20',[(CONV,"        await this.deps.learning?.onHandBack(scope, { conversation: moved, now }, tx);\n","")],T_I,'a handback learns a PENDING candidate'),
 ('TB8-21',[(LOOP,"      if (learning !== undefined) {\n        for (let pass = 0;","      if (learning !== undefined && false) {\n        for (let pass = 0;")],T_I,'a handback learns a PENDING candidate'),
 # Retention: only what was never approved, and only once due.
 ('TB8-22',[(REPO,"          lt(supportLearningCandidates.createdAt, cutoff),\n","")],T_I,'retention purges'),
 # The scrubber's own shapes.
 ('TB8-23',[(SCRUB,"  return text.replace(/[۰-۹٠-٩]/gu, (digit) => {","  return text.replace(/[٠-٩]/gu, (digit) => {")],T_U,'Persian digits'),
 ('TB8-24',[(SCRUB,"  { kind: 'CARD', regex:","  { kind: 'LONG_NUMBER', regex:")],T_U,'card'),
 # Web: the edited text is what is approved; reject is never an approve; gating.
 ('TB8-25',[(PAGE,"run(editing, 'approve', editContent)","run(editing, 'approve', null)")],T_W,'EDITED text'),
 ('TB8-26',[(PAGE,"      command.decision === 'approve'\n        ? approveLearningCandidate(","      command.decision !== 'never'\n        ? approveLearningCandidate(")],T_W,'reject sends no edit'),
 ('TB8-27',[(PAGE,"        actions={mayReview ? newButton : undefined}","        actions={newButton}")],T_W,'no write control'),
 # On the reviewed TB5 (PR #200, finding 4): one learning job per claim, leased from its claim.
 ('TB8-28',[(LOOP,"            limit: 1,\n","            limit: ASSISTANT_LEARNING_BATCH,\n")],T_L,'ONE per claim'),
 # Refusing is not ending (docs/conventions.md): a stopped tenant's learning is left untouched.
 ('TB8-29',[(LEARN,"      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return [];\n","")],T_I,'no learning job claimed'),
 ('TB8-30',[(LEARN,"      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;\n","")],T_I,'purges nothing'),
 ('TB8-31',[(LEARN,"    if (!active) return 'inactive';\n","")],T_I,'no learning job claimed'),
 # PR #203 substitute review, finding 1: the scrubber gaps, one rule at a time.
 ('TB8-32',[(SCRUB,"]{0,3}';\nconst d =","]?';\nconst d =")],T_U,'a card with double spaces'),
 ('TB8-33',[(SCRUB,"    kind: 'HOST',\n    regex: new RegExp(`(?<![\\\\w@.-])${DOMAIN}","    kind: 'HOST',\n    regex: new RegExp(`(?!)(?<![\\\\w@.-])${DOMAIN}")],T_U,'a server by name'),
 ('TB8-34',[(SCRUB,'    kind: urlKind,\n    regex: /\\b(?:https?|','    kind: urlKind,\n    regex: /(?!)\\b(?:https?|')],T_U,'short unlisted parameter'),
 ('TB8-35',[(SCRUB,"  if (authority.includes('@') || /[?#]/u.test(tail)) return 'URL_TOKEN';\n",'')],T_U,'one-letter parameter'),
 ('TB8-36',[(SCRUB,'      /(?<![A-Za-z])(?:password|passwd|passcode','      /(?!)(?<![A-Za-z])(?:password|passwd|passcode')],T_U,'in prose'),
 ('TB8-37',[(SCRUB,"    kind: 'USERNAME',\n    regex: /(?:https?:","    kind: 'USERNAME',\n    regex: /(?!)(?:https?:")],T_U,'t.me profile'),
 ('TB8-38',[(SCRUB,"\\\\d[\\\\d,٬٫.'\\\\s]*","\\\\d[\\\\d,٬.'\\\\s]*")],T_U,'no figure of an amount'),
 ('TB8-39',[(SCRUB,'      /(?<![\\w.])\\d+(?:','      /(?!)(?<![\\w.])\\d+(?:')],T_U,'amount in k'),
 ('TB8-40',[(SCRUB,'`(?<![\\\\u0600-\\\\u06ffA-Za-z])${NUMBER_WORDS}','`(?!)(?<![\\\\u0600-\\\\u06ffA-Za-z])${NUMBER_WORDS}')],T_U,'in Persian words'),
 ('TB8-41',[(SCRUB,'`(?<![\\\\w@.-])(?:${DOMAIN}|${IPV4})','`(?!)(?<![\\\\w@.-])(?:${DOMAIN}|${IPV4})')],T_U,'scheme-less subscription'),
 # Finding 2: every article write is scrubbed, whatever its source.
 ('TB8-42',[(REVIEW,'        assertClean(command.content);\n        const publish','        const publish')],T_I,'finding 2'),
 ('TB8-43',[(REVIEW,'      async (tx, now) => {\n        assertClean(command.content);\n','      async (tx, now) => {\n')],T_I,'finding 2'),
 ('TB8-44',[(REVIEW,'        if (spec.publish) assertClean(before);\n','')],T_I,'finding 2'),
 # Finding 3: the enqueue lock and the hourly cap.
 ('TB8-45',[(LEARN,'    await this.deps.repository.lockLearningEnqueue(scope, tx);\n','')],T_I,'racing on one conversation'),
 ('TB8-46',[(LEARN,"      return 'TENANT';\n",'')],T_I,'thirty jobs'),
 # Finding 4: each SQL predicate of the decisions, alone (the service checks left in place).
 ('TB8-47',[(REPO,"\n          eq(supportLearningCandidates.state, 'PENDING'),\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /** PENDING → REJECTED",'\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /** PENDING → REJECTED')],T_I,'finding 4'),
 ('TB8-48',[(REPO,"\n          eq(supportLearningCandidates.state, 'PENDING'),\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /**\n   * ADR-0035 consequences",'\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /**\n   * ADR-0035 consequences')],T_I,'finding 4'),
 ('TB8-49',[(REPO,"\n          eq(supportLearningCandidates.state, 'PENDING'),\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /** PENDING → REJECTED",'\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /** PENDING → REJECTED')],T_I,'finding 4'),
 ('TB8-50',[(REPO,"\n          eq(supportLearningCandidates.state, 'PENDING'),\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /** PENDING → REJECTED","\n          eq(supportLearningCandidates.state, 'PENDING'),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /** PENDING → REJECTED")],T_I,'finding 4'),
 ('TB8-51',[(REPO,"\n          eq(supportLearningCandidates.state, 'PENDING'),\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /**\n   * ADR-0035 consequences",'\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /**\n   * ADR-0035 consequences')],T_I,'finding 4'),
 ('TB8-52',[(REPO,"\n          eq(supportLearningCandidates.state, 'PENDING'),\n          eq(supportLearningCandidates.version, input.expectedVersion),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /**\n   * ADR-0035 consequences","\n          eq(supportLearningCandidates.state, 'PENDING'),\n        ),\n      )\n      .returning();\n    return row === undefined ? null : candidate(row);\n  }\n\n  /**\n   * ADR-0035 consequences")],T_I,'finding 4'),
 # Finding 5: the proposal key is bound to its reply.
 ('TB8-53',[(LEARN,'      outboundId: command.outboundId,\n    });\n    // Throws IDEMPOTENCY_PAYLOAD_MISMATCH','    });\n    // Throws IDEMPOTENCY_PAYLOAD_MISMATCH')],T_I,'finding 5'),
 # Finding 6: the purge takes the title and the tags too.
 ('TB8-54',[(REPO,'        title: null,\n        body: null,\n        rationale: null,','        body: null,\n        rationale: null,')],T_I,'retention purges'),
 ('TB8-55',[(REPO,"        tags: sql`'{}'::text[]`,\n        textPurgedAt: now,",'        textPurgedAt: now,')],T_I,'retention purges'),
 # Finding 7: a scrubber rejection never absorbs a clean proposal.
 ('TB8-56',[(REPO,'      .where(and(eq(supportLearningCandidates.tenantId, tenantId), notSensitiveRejection))','      .where(and(eq(supportLearningCandidates.tenantId, tenantId)))')],T_I,'finding 7'),
 # Nits: the reject note, a stop during the provider call, the proposer is the author.
 ('TB8-57',[(REVIEW,'scrubSensitive(command.note).text','command.note')],T_I,'reject note'),
 ('TB8-58',[(LEARN,"        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'inactive';\n        if (duplicate !== null) {",'        if (duplicate !== null) {')],T_I,'during the provider call'),
 ('TB8-59',[(LEARN,'          if (reply.createdByAdminId !== adminId) {','          if (false) {')],T_I,'their own reply'),
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
