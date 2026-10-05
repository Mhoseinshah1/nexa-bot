"""TB5 (Assist Mode) mutation driver (docs/support-agent/tb5-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
TB5-01..07, TB5-10..16 and TB5-18..30 need the integration database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-tb5.py [TB5-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

SVC='apps/api/src/modules/control/support-ai/application/support-assist.service.ts'
REPO='apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.ts'
PROMPT='apps/api/src/modules/control/support-ai/domain/prompt.ts'
LOOP='apps/api/src/modules/control/support-ai/application/assistant-loop.ts'
LANE='apps/api/src/modules/commerce/business-chats/application/business-conversation.service.ts'
WEB='apps/web/src/pages/support-assist.tsx'
T_I=('integration','tests/integration/support-assist.test.ts')
T_P=('unit','tests/unit/support-ai-prompt.test.ts')
T_L=('unit','tests/unit/assistant-loop.test.ts')
T_W=('web','tests/web/support-ai.test.tsx')
COURTESY="    if (draft.state !== 'READY' && draft.state !== 'SENT') throw this.notReady();"
MARK_SENT="""        if (!(await this.deps.jobs.markSent(scope, draft.id, outbound.id, now, tx))) {
          throw this.notReady();
        }"""
ASSIST_PERM="(input.origin === 'ASSIST' ? 'support_ai.assist' : BUSINESS_CHATS_REPLY_PERMISSION) as never"

M=[
 ('TB5-01',[(SVC,"      return label === undefined ? [] : [label];","      return label === undefined ? [ref] : [label];")],T_I,'produces a draft'),
 ('TB5-02',[(SVC,"    const parsed = supportAiDecisionSchema.safeParse(result.outcome.output);","    const parsed = { success: true as const, data: result.outcome.output as never as import('@nexa/contracts').SupportAiDecision };")],T_I,'extra key'),
 ('TB5-09',[(SVC,"!parsed.success || parsed.data.replyText.length > config.maxOutputChars","!parsed.success")],T_I,'over-long reply'),
 ('TB5-03',[(REPO,"          eq(supportAiJobs.id, id),\n          eq(supportAiJobs.state, 'QUEUED'),\n        ),\n      )\n      .returning({ id: supportAiJobs.id });\n    return rows.length > 0;\n  }\n\n  async markFailed","          eq(supportAiJobs.id, id),\n        ),\n      )\n      .returning({ id: supportAiJobs.id });\n    return rows.length > 0;\n  }\n\n  async markFailed")],T_I,'not resurrected'),
 ('TB5-04',[(SVC,"      await this.deps.jobs.discardOpen(scope, conversation.id, now, tx);\n","")],T_I,'newer request discards'),
 ('TB5-05',[(SVC,"    if (config.mode === 'OFF') {","    if (config.mode === ('NEVER' as string)) {")],T_I,'while the support AI is OFF'),
 ('TB5-06',[(SVC,"      origin: 'ASSIST',","      origin: 'OPERATOR',")],T_I,'sends a draft only by the operator'),
 # Revised in the PR #200 review: the rule now has two layers (an unlocked courtesy read and the
 # conditional write in the lane's transaction); this reverts both. Each layer alone: TB5-13, -14.
 ('TB5-07',[(SVC,COURTESY,""),(SVC,MARK_SENT,"        await this.deps.jobs.markSent(scope, draft.id, outbound.id, now, tx);")],T_I,'discarded draft cannot be sent'),
 ('TB5-08',[(PROMPT,"    input.identityLinked\n","    true\n")],T_P,'unlinked'),
 # --- Substitute review of PR #200 -------------------------------------------------------
 ('TB5-10',[(SVC,"    if (!active) return 'INACTIVE';\n","")],T_I,'between the claim and the call'),
 ('TB5-11',[(SVC,"      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'INACTIVE';\n","")],T_I,'during the provider call'),
 ('TB5-12',[(SVC,"      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return null;\n","")],T_I,'never leases a stopped tenant'),
 ('TB5-13',[(SVC,MARK_SENT,"        await this.deps.jobs.markSent(scope, draft.id, outbound.id, now, tx);")],T_I,'two concurrent sends'),
 ('TB5-14',[(REPO,"          eq(supportAiJobs.state, 'READY'),\n","")],T_I,'racing a discard'),
 ('TB5-15',[(SVC,COURTESY,"    if (draft.state === 'SENT' && draft.sentOutboundId !== null) return { outboundId: draft.sentOutboundId };\n"+COURTESY)],T_I,'replay of the operator'),
 ('TB5-16',[(SVC,"    if (!inserted) {","    if ((false as boolean) && !inserted) {")],T_I,'used on a different draft'),
 ('TB5-17',[(LOOP,"new LoopProgress(Math.max(options.intervalMs * 3, ASSISTANT_LEASE_MS), 1)","new LoopProgress(options.intervalMs)")],T_L,'stays fresh'),
 ('TB5-18',[(LOOP,"export const ASSISTANT_LEASE_MS = ASSISTANT_JOB_WORST_CASE_MS + 2 * 60_000;","export const ASSISTANT_LEASE_MS = 5 * 60_000;")],T_I,'two assistant replicas'),
 ('TB5-19',[(REPO,"          eq(supportAiJobs.id, sql`(${next})`),","          inArray(supportAiJobs.id, next),")],T_I,'two assistant replicas'),
 ('TB5-20',[(SVC,"    if (existing.requestHash !== requestHash) {","    if ((false as boolean) && existing.requestHash !== requestHash) {")],T_I,'same key with another conversation'),
 ('TB5-21',[(SVC,"      await this.deps.jobs.failUnclaimed(scope, conversationId, unclaimedCutoff(now), now, tx);\n","")],T_I,'the listing fails'),
 ('TB5-22',[(REPO,"lte(sql`coalesce(${supportAiJobs.claimedUntil}, ${supportAiJobs.createdAt})`, cutoff)","lte(supportAiJobs.createdAt, cutoff)")],T_I,'a live lease'),
 ('TB5-23',[(SVC,"        await this.deps.jobs.failUnclaimed(scope, conversation.id, unclaimedCutoff(now), now, tx);\n","")],T_I,'a new request fails the old'),
 ('TB5-24',[(LOOP,"job.attempts > ASSISTANT_MAX_ATTEMPTS","job.attempts > ASSISTANT_MAX_ATTEMPTS + 1")],T_I,'fails without a provider call'),
 ('TB5-25',[(LOOP,"job.attempts > ASSISTANT_MAX_ATTEMPTS","job.attempts >= ASSISTANT_MAX_ATTEMPTS")],T_I,'is still produced'),
 ('TB5-26',[(REPO,"    const free = or(isNull(supportAiJobs.claimedUntil), lte(supportAiJobs.claimedUntil, now));","    const free = sql`true`;")],T_I,'the lease predicate'),
 ('TB5-27',[(REPO,"    const free = or(isNull(supportAiJobs.claimedUntil), lte(supportAiJobs.claimedUntil, now));","    const free = or(isNull(supportAiJobs.claimedUntil), lt(supportAiJobs.claimedUntil, now));")],T_I,'the lease predicate'),
 ('TB5-28',[(SVC,"now.getTime() - SUPPORT_AI_DRAFT_RETENTION_DAYS * 86_400_000","now.getTime() - 86_400_000")],T_I,'after 30 days'),
 ('TB5-29',[(LANE,"      await this.deps.guard.check(scope, actor, BUSINESS_CHATS_REPLY_PERMISSION);\n    } catch (error) {\n      await recordMutationDenial(\n        this.mutationDeps(),\n        scope,\n        actor,\n        BUSINESS_CHATS_REPLY_PERMISSION,\n        denial,\n        error,\n      );\n      throw error;\n    }\n    const existing = await this.deps.outbound.findByIdempotencyKey(scope, key);",
             "      await this.deps.guard.check(scope, actor, "+ASSIST_PERM+");\n    } catch (error) {\n      throw error;\n    }\n    const existing = await this.deps.outbound.findByIdempotencyKey(scope, key);"),
            (LANE,"      BUSINESS_CHATS_REPLY_PERMISSION,\n      denial,\n      async (tx) => {\n        await this.assertScopeActive(scope, tx);\n        const now = this.deps.clock.now();\n        const raced = await this.deps.outbound.findByIdempotencyKey(scope, key, tx);",
             "      "+ASSIST_PERM+",\n      denial,\n      async (tx) => {\n        await this.assertScopeActive(scope, tx);\n        const now = this.deps.clock.now();\n        const raced = await this.deps.outbound.findByIdempotencyKey(scope, key, tx);")],T_I,'needs business_chats.reply'),
 ('TB5-30',[(REPO,"          eq(supportAiJobs.id, id),\n          inArray(supportAiJobs.state, ['QUEUED', 'READY']),\n","          eq(supportAiJobs.id, id),\n")],T_I,'discard is idempotent'),
 ('TB5-31',[(LOOP,"          this.reportedNoScope = true;\n","")],T_L,'reports a missing tenant scope once'),
 ('TB5-32',[(WEB,"nowMs - Date.parse(draft.createdAt) < ASSIST_WAIT_MS","nowMs >= 0")],T_W,'nothing claims'),
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
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:2],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  if not ok: print(mid,'NOT RUN',flush=True)
