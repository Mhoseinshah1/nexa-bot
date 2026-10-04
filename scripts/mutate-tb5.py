"""TB5 (Assist Mode) mutation driver (docs/support-agent/tb5-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
TB5-01..07 need the integration database (`bash scripts/dev-services.sh`); point
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
T_I=('integration','tests/integration/support-assist.test.ts')
T_P=('unit','tests/unit/support-ai-prompt.test.ts')

M=[
 ('TB5-01',[(SVC,"      return label === undefined ? [] : [label];","      return label === undefined ? [ref] : [label];")],T_I,'produces a draft'),
 ('TB5-02',[(SVC,"    const parsed = supportAiDecisionSchema.safeParse(result.outcome.output);","    const parsed = { success: true as const, data: result.outcome.output as never as import('@nexa/contracts').SupportAiDecision };")],T_I,'extra key'),
 ('TB5-09',[(SVC,"!parsed.success || parsed.data.replyText.length > config.maxOutputChars","!parsed.success")],T_I,'over-long reply'),
 ('TB5-03',[(REPO,"          eq(supportAiJobs.id, id),\n          eq(supportAiJobs.state, 'QUEUED'),\n        ),\n      )\n      .returning({ id: supportAiJobs.id });\n    return rows.length > 0;\n  }\n\n  async markFailed","          eq(supportAiJobs.id, id),\n        ),\n      )\n      .returning({ id: supportAiJobs.id });\n    return rows.length > 0;\n  }\n\n  async markFailed")],T_I,'not resurrected'),
 ('TB5-04',[(SVC,"      await this.deps.jobs.discardOpen(scope, conversation.id, now, tx);\n","")],T_I,'newer request discards'),
 ('TB5-05',[(SVC,"    if (config.mode === 'OFF') {","    if (config.mode === ('NEVER' as string)) {")],T_I,'while the support AI is OFF'),
 ('TB5-06',[(SVC,"      origin: 'ASSIST',","      origin: 'OPERATOR',")],T_I,'sends a draft only by the operator'),
 ('TB5-07',[(SVC,"    if (draft.state !== 'READY') {","    if (draft.state === ('NEVER' as string)) {")],T_I,'discarded draft cannot be sent'),
 ('TB5-08',[(PROMPT,"    input.identityLinked\n","    true\n")],T_P,'unlinked'),
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
