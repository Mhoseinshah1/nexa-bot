"""A7/A8 (Support AI memory and knowledge retrieval) mutation driver
(docs/support-agent/sai-memory-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
A mutant is KILLED only when the named test fails; the driver prints the first failing
assertion, so a mutant that dies by a crash (a syntax error, a missing import) is visible as
such. The integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL and DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-sai-memory.py [SAI-M01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

TRANSCRIPT='apps/api/src/modules/control/support-ai/domain/transcript.ts'
PROMPT='apps/api/src/modules/control/support-ai/domain/prompt.ts'
READ='apps/api/src/modules/control/support-ai/application/support-transcript.ts'
QUERY='apps/api/src/modules/control/support-ai/domain/knowledge-query.ts'
RELEVANCE='apps/api/src/modules/commerce/support-context/domain/knowledge-relevance.ts'
SOURCE='apps/api/src/modules/control/support-ai/infrastructure/support-context-source.ts'
JOBS='apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.ts'
T=('unit','tests/unit/support-ai-transcript.test.ts')
P=('unit','tests/unit/support-ai-prompt.test.ts')
K=('unit','tests/unit/support-knowledge-query.test.ts')
D=('unit','tests/unit/support-context-knowledge.test.ts')
I=('integration','tests/integration/support-assist.test.ts')

M=[
 # --- A7: who wrote each line ---
 ('SAI-M01',[(TRANSCRIPT,"  const lane = replyLanes.get(message.telegramMessageId);","  const lane = undefined as BusinessOutboundOrigin | undefined;")],T,'an echo takes the lane'),
 ('SAI-M02',[(TRANSCRIPT,"  ASSIST: 'AI_ASSIST',","  ASSIST: 'STAFF',")],T,'a reply line is authored by its lane'),
 ('SAI-M03',[(PROMPT,"    if (role === 'assistant') body = `${authorMarker(line.author)}\\n${body}`;\n","")],T,'every support line opens with its author marker'),
 ('SAI-M04',[(PROMPT,"          neutraliseMarkers(line.text.slice(0, SUPPORT_AI_TRANSCRIPT_MESSAGE_CHARS)).slice(","          line.text.slice(0, SUPPORT_AI_TRANSCRIPT_MESSAGE_CHARS).slice(")],T,'never forges one'),
 ('SAI-M05',[(TRANSCRIPT,"  if (message.origin === 'INBOUND') return 'CUSTOMER';\n","")],T,'a customer message is never relabelled'),
 ('SAI-M06',[(READ,"export const SUPPORT_TRANSCRIPT_READ_LINES = 60;","export const SUPPORT_TRANSCRIPT_READ_LINES = 40;")],T,'asks both repositories for 60'),
 ('SAI-M07',[(PROMPT,"export const SUPPORT_AI_TRANSCRIPT_MESSAGES = 40;","export const SUPPORT_AI_TRANSCRIPT_MESSAGES = 20;")],T,'the 40 most recent of the 60 lines'),
 ('SAI-M08',[(PROMPT,"never write one in replyText.","you may quote one.")],P,'explains every author marker'),
 ('SAI-M09',[(PROMPT,"(K1 is the closest match)","(K1 is the best match)")],P,'in both directions'),
 # --- A8: knowledge retrieval ---
 ('SAI-M10',[(RELEVANCE,"    .filter(({ score }) => score > 0)\n","")],D,'no match, or no query, selects nothing'),
 ('SAI-M11',[(RELEVANCE,"      score += weight * (termWeights.get(term) ?? 0) * (rarity.get(term) ?? 0);","      score += weight * (rarity.get(term) ?? 0);")],K,'a weighted part scores less'),
 ('SAI-M12',[(RELEVANCE,"      weights.set(term, Math.max(known ?? 0, part.weight));","      weights.set(term, part.weight);")],K,'at the highest weight'),
 ('SAI-M13',[(RELEVANCE,"      if (known === undefined && weights.size >= KNOWLEDGE_QUERY_MAX_TERMS) continue;\n","")],K,'the term bound keeps'),
 ('SAI-M14',[(QUERY,"  if (episode.open) {","  if (episode.open && false) {")],K,'THE EPISODE'),
 ('SAI-M15',[(QUERY,"  const stepOrQuestion = last.decision === 'REPLY' || last.decision === 'ASK_CLARIFYING_QUESTION';","  const stepOrQuestion = true;")],K,'troubleshooting is open only after'),
 ('SAI-M16',[(QUERY,"      .flatMap((job) => job.knowledgeLabels)","      .flatMap(() => [] as string[])")],K,'CONTINUITY'),
 ('SAI-M17',[(SOURCE,"      this.prior === null || options.conversationId === undefined","      true")],K,'reads the conversation'),
 ('SAI-M18',[(JOBS,"          inArray(supportAiJobs.state, ['READY', 'SENT']),","          inArray(supportAiJobs.state, ['READY', 'SENT', 'DISCARDED', 'FAILED']),")],I,'A8: priorDecisions'),
 ('SAI-M19',[(JOBS,"          eq(supportAiJobs.tenantId, tenantId),\n          eq(supportAiJobs.conversationId, conversationId),\n          isNotNull(supportAiJobs.decision),","          eq(supportAiJobs.conversationId, conversationId),\n          isNotNull(supportAiJobs.decision),")],I,'A8: priorDecisions'),
 ('SAI-M21',[(QUERY,"  return messages.map((message) => message.slice(0, share)).join('\\n');","  return messages.join('\\n');")],K,'three long messages never push'),
 # --- PR #236 review ---
 # B1: back to a LIST of bracket characters (the pre-review neutraliser)
 ('SAI-M22',[(PROMPT,"    .normalize('NFKC')\n    .replace(/\\p{Ps}/gu, '(')\n    .replace(/\\p{Pe}/gu, ')')","    .replace(/[[\\uFF3B\\u27E6\\u3010\\u3014\\u3016\\u301A\\uFE47]/g, '(')\n    .replace(/[\\]\\uFF3D\\u27E7\\u3011\\u3015\\u3017\\u301B\\uFE48]/g, ')')")],T,'around a marker never forges one'),
 # N1: a version moved over unchanged text (the table must name the text's version)
 ('SAI-M23',[(PROMPT,"export const SUPPORT_AI_POLICY_VERSION = 'sai4m-2026-10-07';","export const SUPPORT_AI_POLICY_VERSION = 'sai9-2026-12-31';")],P,'in both directions'),
 # N2: an automatic decision's cited titles are not recorded
 ('SAI-M24',[(JOBS,"              factRefs: [...decision.factRefs],\n              knowledgeLabels: [...(result.knowledgeLabels ?? [])],","              factRefs: [...decision.factRefs],")],('integration','tests/integration/support-auto-reply.test.ts'),'records the knowledge it cited'),
 # N3: the customer's words may take every term again
 ('SAI-M25',[(RELEVANCE,"  if (first !== undefined) take(first, KNOWLEDGE_QUERY_MAX_TERMS - KNOWLEDGE_QUERY_RESERVED_TERMS);","  if (first !== undefined) take(first, KNOWLEDGE_QUERY_MAX_TERMS);")],K,'N3: a long customer message'),
 # N4: topic words count in bodies again
 ('SAI-M26',[(RELEVANCE,"      body: part.titleAndTagsOnly !== true,","      body: true,")],K,'N4: after a vague'),
 # N5: the container wires the source without its memory
 ('SAI-M27',[('apps/api/src/container.ts',"new TbSupportContextSource(supportContext, supportAiJobs);","new TbSupportContextSource(supportContext);")],I,'the ASSEMBLED container'),
 # N6: no character ceiling on the transcript
 ('SAI-M28',[(PROMPT,"  while (total > SUPPORT_AI_TRANSCRIPT_MAX_CHARS && start < window.length - 1) {","  while (total < 0 && start < window.length - 1) {")],T,'character ceiling'),
 ('SAI-M20',[(SOURCE,"    return knowledgeQueryFor(options.transcript, prior);","    return knowledgeQueryFor(options.transcript, prior.slice(0, 0));")],I,'A8 end to end'),
]

only=sys.argv[1:]
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  files=set(); ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a),flush=True); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  if ok:
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    asserts=[l.strip() for l in out.splitlines() if 'AssertionError' in l or 'Error:' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:2],asserts[:1],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
