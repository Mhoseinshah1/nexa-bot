"""TB10 (polish, analytics, final QA) mutation driver (docs/support-agent/tb10-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
A mutant in packages/contracts rebuilds the contracts before the run and again after the
restore, because the test projects import @nexa/contracts from its dist.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-tb10.py [TB10-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

NC='packages/contracts/src/notification-center.ts'
BC='packages/contracts/src/business-chats.ts'
SAI='packages/contracts/src/support-ai.ts'
SAN='packages/contracts/src/support-analytics.ts'
REPO='apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository.ts'
CTRL='apps/api/src/surfaces/web/business-chats.controller.ts'
READER='apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-analytics.reader.ts'
ASSEMBLE='apps/api/src/modules/control/support-ai/domain/support-analytics.ts'
ANALYTICS='apps/api/src/modules/control/support-ai/application/support-analytics.service.ts'
CONFIG='apps/api/src/modules/control/support-ai/application/support-ai-config.service.ts'
INBOX_PAGE='apps/web/src/pages/business-chats.tsx'
AI_PAGE='apps/web/src/pages/support-ai.tsx'
NC_PAGE='apps/web/src/pages/notification-center.tsx'
SA_PAGE='apps/web/src/pages/support-analytics.tsx'
CSS='apps/web/src/styles/pages/ops-b.css'
T_U=('unit','tests/unit/support-tb10.test.ts')
T_I=('integration','tests/integration/support-tb10.test.ts')
T_W=('web','tests/web/support-tb10-polish.test.tsx')
T_A=('web','tests/web/support-analytics.test.tsx')

M=[
 # --- the notification rules (contracts) ---------------------------------------------------
 ('TB10-01',[(NC,"    code: 'support.handoff_required',\n    category: 'SUPPORT',","    code: 'support.handoff_required',\n    category: 'SUPPORT_AI',")],T_I,'a handoff reaches support'),
 ('TB10-02',[(NC,"  SUPPORT_AI: 'support_ai.configure',\n};","  SUPPORT_AI: 'business_chats.view',\n};")],T_I,'reach support_ai.configure holders only'),
 ('TB10-03',[(NC,"  BUSINESS_CHAT: { contextKey: 'conversationId', fallback: 'BUSINESS_CHATS' },\n","")],T_U,'links a handoff to its conversation'),
 ('TB10-04',[(NC,"    code: 'support.business_connection.unusable',","    prefix: 'support.',")],T_U,'never admits a support recovery'),
 # --- the inbox rules (contracts) ----------------------------------------------------------
 ('TB10-05',[(BC,"  if (replied !== null && inbound.getTime() <= replied) return null;\n","")],T_U,'replied after the customer'),
 ('TB10-06',[(BC,"  return first !== null && (replied === null || first.getTime() > replied) ? first : inbound;","  return inbound;")],T_U,'OLDEST customer message'),
 ('TB10-07',[(SAI,"  return trippedUntil.getTime() > now.getTime() ? 'OPEN' : 'HALF_OPEN';","  return trippedUntil.getTime() >= now.getTime() ? 'OPEN' : 'HALF_OPEN';")],T_U,'HALF_OPEN from it on'),
 ('TB10-08',[(SAN,"    case 'handoff_ai_unavailable':\n    case 'handoff_stale':\n      return 'HANDED_OFF';","    case 'handoff_ai_unavailable':\n      return 'DROPPED';\n    case 'handoff_stale':\n      return 'HANDED_OFF';")],T_U,'classifies every outcome'),
 # --- the inbox query and cursor -----------------------------------------------------------
 ('TB10-09',[(REPO,".orderBy(desc(priority), desc(activity), desc(businessConversations.id))",".orderBy(desc(activity), desc(businessConversations.id))")],T_I,'waiting for a person first'),
 ('TB10-10',[(REPO,"            : sql`(${priority}, ${activity}, ${businessConversations.id}) < (${\n                input.before.priority === 1\n              }, ${input.before.at.toISOString()}::timestamptz, ${input.before.id}::uuid)`,","            : sql`(${activity}, ${businessConversations.id}) < (${input.before.at.toISOString()}::timestamptz, ${input.before.id}::uuid)`,")],T_I,'pages without a gap or a repeat'),
 ('TB10-11',[(REPO,"          SELECT min(m.sent_at) FROM business_messages m","          SELECT max(m.sent_at) FROM business_messages m")],T_I,'oldest unanswered message'),
 ('TB10-12',[(CTRL,"    /^[01]\\|\\d{4}","    /^[0-9]\\|\\d{4}")],T_I,'refuses one it did not'),
 # --- the analytics ------------------------------------------------------------------------
 ('TB10-13',[(READER,"       WHERE tenant_id = ${tenantId}::uuid\n         AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz\n       GROUP BY reason`);","       WHERE tenant_id = ${tenantId}::uuid\n         AND created_at >= ${start}::timestamptz AND created_at <= ${end}::timestamptz\n       GROUP BY reason`);")],T_I,'counts each figure in'),
 ('TB10-14',[(READER,"       WHERE tenant_id = ${tenantId}::uuid\n         AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz\n       GROUP BY kind, state, outcome`);","       WHERE tenant_id = ${tenantId}::uuid\n         AND created_at > ${start}::timestamptz AND created_at < ${end}::timestamptz\n       GROUP BY kind, state, outcome`);")],T_I,'counts each figure in'),
 ('TB10-15',[(READER,"        FROM support_ai_runs\n       WHERE tenant_id = ${tenantId}::uuid\n         AND created_at","        FROM support_ai_runs\n       WHERE true\n         AND created_at")],T_I,'counts each figure in'),
 ('TB10-16',[(READER,"percentile_cont(0.95)","percentile_cont(0.9)")],T_I,'counts each figure in'),
 ('TB10-17',[(ASSEMBLE,"        auto.pending += job.count;\n        continue;","        auto.sent += job.count;\n        continue;")],T_U,'never as sent'),
 ('TB10-18',[(ASSEMBLE,"    assist.requested += job.count;\n","")],T_U,'every Assist draft as requested'),
 ('TB10-19',[(ANALYTICS,"    await this.deps.guard.check(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION);\n","")],T_I,'charged support_ai.configure'),
 # --- provider health ----------------------------------------------------------------------
 ('TB10-20',[(CONFIG,"          breaker: supportAiBreakerState(state?.trippedUntil ?? null, now),","          breaker: 'CLOSED' as const,")],T_I,'reports each breaker'),
 ('TB10-21',[(CONFIG,"      this.deps.conditions.conditionIsOpen(scope, SUPPORT_AI_UNAVAILABLE_DEDUPE_KEY),","      Promise.resolve(false),")],T_I,'reports each breaker'),
 ('TB10-22',[(CONFIG,"          rejectedAt: state?.rejectedAt?.toISOString() ?? null,","          rejectedAt: null,")],T_I,'reports each breaker'),
 # --- the web ------------------------------------------------------------------------------
 ('TB10-23',[(INBOX_PAGE,"  if (elapsed < 3_600_000) return { value: Math.floor(elapsed / 60_000), unit: 'web.unit_minutes' };","  if (elapsed < 3_600_000) return { value: Math.round(elapsed / 60_000), unit: 'web.unit_minutes' };")],T_W,'in one unit, floored'),
 ('TB10-24',[(INBOX_PAGE,"          {row.ticketId !== null && (","          {false && (")],T_W,'a ticket link'),
 ('TB10-25',[(AI_PAGE,"  HALF_OPEN: 'web.sai_breaker_half_open',","  HALF_OPEN: 'web.sai_breaker_open',")],T_W,'breaker as the server derived it'),
 ('TB10-26',[(AI_PAGE,"            {data.chainUnavailable && (","            {false && (")],T_W,'no provider is answering'),
 ('TB10-27',[(NC_PAGE,"      return id === '' ? '/business-chats' : `/business-chats/${id}`;","      return '/business-chats';")],T_W,'link a handoff to its conversation'),
 ('TB10-28',[(SA_PAGE,"      <Banner tone=\"info\" title={t('web.sa_cost_title')}>","      <Banner tone=\"info\" title={t('web.sa_none_in_period')}>")],T_A,'shows no cost and says why'),
 ('TB10-29',[(SA_PAGE,"  const selection = rangeIsComplete(chosen) ? chosen : { range: DEFAULT_RANGE };","  const selection = { range: DEFAULT_RANGE };")],T_A,'sends a preset taken from the address'),
 ('TB10-30',[(CSS,"   * character, paragraph by paragraph, instead of being forced right to left by the page.\n   */\n  unicode-bidi: plaintext;\n","   * character, paragraph by paragraph, instead of being forced right to left by the page.\n   */\n")],T_W,'by its own direction'),
 ('TB10-31',[(CSS,"  font-variant-numeric: tabular-nums;\n}","  font-variant-numeric: tabular-nums;\n  color: #b00020;\n}")],T_W,'only theme tokens and logical sides'),
 ('TB10-32',[(CSS,".bchat-ticket {\n  text-decoration: none;",".bchat-ticket {\n  text-decoration: none;\n  margin-left: 4px;")],T_W,'only theme tokens and logical sides'),
 ('TB10-33',[(INBOX_PAGE,"          <textarea\n            dir=\"auto\"\n","          <textarea\n")],T_W,'direction of what is typed'),
]

def build_contracts():
  r=subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True,text=True)
  if r.returncode!=0: print(r.stdout+r.stderr,flush=True)
  return r.returncode==0

only=sys.argv[1:]
killed=0; ran=0
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  originals={}; ok=True
  for f,a,b in edits:
    s=originals.get(f) or open(f,encoding='utf-8').read()
    originals.setdefault(f,s)
    cur=open(f,encoding='utf-8').read()
    if cur.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,cur.count(a),flush=True); ok=False; break
    open(f,'w',encoding='utf-8').write(cur.replace(a,b))
  contracts=any(f.startswith('packages/contracts/') for f in originals)
  if ok and contracts and not build_contracts():
    # A mutant that does not compile is not a mutant a test can kill; say so.
    print(mid,'DOES NOT COMPILE',flush=True); ok=False
  if ok:
    ran+=1
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    ran_any=any('passed' in l or 'failed' in l for l in summ)
    if r.returncode!=0 and ran_any: killed+=1
    print(mid,'KILLED' if (r.returncode!=0 and ran_any) else 'SURVIVED',summ,failed[:2],flush=True)
  for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
  if contracts: build_contracts()
print(f'{killed} of {ran} killed',flush=True)
