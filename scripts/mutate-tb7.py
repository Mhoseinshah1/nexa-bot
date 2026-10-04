"""TB7 (AUTO_REPLY_SAFE + handoff + tickets) mutation driver (docs/support-agent/tb7-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
Most mutants need the integration database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-tb7.py [TB7-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

AUTO='apps/api/src/modules/control/support-ai/application/support-auto-reply.service.ts'
GUARDS='apps/api/src/modules/control/support-ai/domain/auto-reply-guards.ts'
JOBS='apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.ts'
CONFIG='apps/api/src/modules/control/support-ai/application/support-ai-config.service.ts'
CONV='apps/api/src/modules/commerce/business-chats/application/business-conversation.service.ts'
LANE='apps/api/src/modules/commerce/business-chats/application/business-outbound.service.ts'
TICKETS='apps/api/src/modules/commerce/tickets/application/ticket.service.ts'
T_I=('integration','tests/integration/support-auto-reply.test.ts')
T_U=('unit','tests/unit/support-auto-reply-guards.test.ts')

M=[
 # Enqueue: coalescing, idempotency on the message, the settle delay.
 ('TB7-01',[(AUTO,"    if (pending !== null) {\n      await this.deps.jobs.finishAuto(","    if (pending !== null && false) {\n      await this.deps.jobs.finishAuto(")],T_I,'two inbound messages coalesce'),
 ('TB7-02',[(AUTO,"    if ((await this.deps.jobs.findByIdempotencyKey(scope, key, tx)) !== null) return;\n",""),
            (CONV,"          inserted = await this.insertMessage(scope, conversation.id, message, origin, now, tx);\n          contentVersion = inserted ? 1 : null;\n        }\n\n        let tookOver = false;\n        if (inserted || input.edited) {","          inserted = await this.insertMessage(scope, conversation.id, message, origin, now, tx);\n          contentVersion = 1;\n        }\n\n        let tookOver = false;\n        if (true) {")],T_I,'redelivered inbound'),
 ('TB7-03',[(JOBS,"      or(isNull(supportAiJobs.dueAt), lte(supportAiJobs.dueAt, now)),\n","")],T_I,'waits the settle delay'),
 # Produce: the re-checks before the provider and at the enqueue, and the job's own state.
 ('TB7-04',[(AUTO,"    if (conversation === null || conversation.controlEpoch !== epoch) {","    if (conversation === null) {"),
            (AUTO,"    if (conversation.state !== 'AI_ACTIVE') return this.drop(scope, job, 'dropped_state');","")],T_I,'during the settle delay'),
 ('TB7-05',[(CONV,"    if (conversation.controlEpoch !== input.controlEpoch) return { refused: 'epoch' };\n    if (conversation.state !== 'AI_ACTIVE') return { refused: 'state' };\n","")],T_I,'during the provider call'),
 ('TB7-06',[(AUTO,"    if (config.mode !== 'AUTO_REPLY_SAFE') return this.drop(scope, job, 'dropped_mode');","")],T_I,'mode switched OFF'),
 ('TB7-07',[(LANE,"        row.origin !== 'AUTO' || (await this.deps.autoMode.autoReplyEnabled(scope, tx));","        true || (await this.deps.autoMode.autoReplyEnabled(scope, tx));")],T_I,'mode switched OFF'),
 ('TB7-08',[(JOBS,"          eq(supportAiJobs.kind, 'AUTO_DECISION'),\n          eq(supportAiJobs.state, 'QUEUED'),\n        ),\n      )\n      .returning({ id: supportAiJobs.id });","          eq(supportAiJobs.kind, 'AUTO_DECISION'),\n        ),\n      )\n      .returning({ id: supportAiJobs.id });")],T_I,'in flight'),
 # The deterministic guards.
 ('TB7-09',[(GUARDS,"  if (!(config.autoTopics as readonly string[]).includes(decision.topic)) {","  if (false) {")],T_I,'empty allowlist means'),
 ('TB7-10',[(GUARDS,"  if ((SUPPORT_AI_HANDOFF_TOPICS as readonly string[]).includes(decision.topic)) {","  if (false) {")],T_I,'each guard individually'),
 ('TB7-11',[(GUARDS,"    !flags.identityLinked &&","    false &&")],T_I,'each guard individually'),
 ('TB7-12',[(GUARDS,"  if (flags.hasUnderReviewPayment || flags.hasUnreconciledService) {","  if (false) {")],T_I,'each guard individually'),
 ('TB7-13',[(GUARDS,"  if (CONFIDENCE_RANK[decision.confidence] < CONFIDENCE_RANK[config.autoMinConfidence]) {","  if (false) {")],T_I,'each guard individually'),
 ('TB7-14',[(GUARDS,"    reply === '' ||","    false ||")],T_I,'each guard individually'),
 ('TB7-15',[(GUARDS,"  if (decision.factRefs.some((ref) => !input.knownAliases.has(ref))) {","  if (false) {")],T_I,'each guard individually'),
 ('TB7-16',[(GUARDS,"  if (input.autoAtEpoch >= input.maxConsecutiveReplies)","  if (input.autoAtEpoch > input.maxConsecutiveReplies)")],T_I,'consecutive automatic replies'),
 ('TB7-17',[(GUARDS,"  if (trigger === null || trigger.origin !== 'INBOUND' || !readable) {","  if (trigger === null || !readable) {")],T_U,'preflight: only a customer message'),
 # TB6 x TB7: an image the reply would be about must be seen.
 ('TB7-22',[(GUARDS,"  if (input.required.some((id) => !input.loaded.has(id))) {","  if (false) {")],T_I,'vision off is never answered'),
 ('TB7-23',[(AUTO,"    if (result.exhausted === 'NO_VISION_STEP' || (required.length > 0 && answered && !seen)) {","    if (result.exhausted === 'NO_VISION_STEP') {")],T_I,'answering step was not given'),
 # The handoff: escalation, ticket linking, the operator signal; the CRITICAL widening.
 ('TB7-18',[(CONV,"    await this.deps.escalation.escalate(scope, { conversation: moved, reason, detail, now }, tx);\n","")],T_I,'UNKNOWN send'),
 ('TB7-19',[(TICKETS,"        : await this.deps.tickets.latestActiveForCustomer(scope, customerId, scoped);","        : null;")],T_I,'existing active ticket'),
 ('TB7-20',[(CONV,"        if (conversation.state === 'HANDOFF_REQUIRED') {\n          await this.deps.escalation.resolved(scope, moved.id, tx);\n        }\n        return moved;\n      },","        return moved;\n      },")],T_I,'exactly one ticket'),
 ('TB7-21',[(CONFIG,"        if (widened) {","        if (false) {")],T_I,'widening the allowlist'),
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
