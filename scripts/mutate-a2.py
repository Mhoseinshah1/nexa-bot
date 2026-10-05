"""Pre-support A2 (refresh on open) mutation driver (docs/pre-support/a2-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-a2.py [A2-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

RT='apps/api/src/surfaces/telegram/bot-runtime.ts'
SR='apps/api/src/modules/commerce/provisioning/application/service-refresh.service.ts'
T_I=('integration','tests/integration/customer-ux-services.test.ts')
FAILURE_TESTS='a panel failure draws the stored card|an exhausted probe budget draws the stored card'

M=[
 # The call itself, on each of the two intents that open a card.
 ('A2-01',[(RT,"    if (command.intent === 'SERVICE' && command.targetId !== null) {\n      return this.openServiceCard(","    if (command.intent === 'SERVICE' && command.targetId !== null) {\n      return this.serviceDetail(")],T_I,'opening a card makes one panel read'),
 ('A2-02',[(RT,"      const card = await this.openServiceCard(scope, actor, customer, command.targetId);","      const card = await this.serviceDetail(scope, actor, customer, command.targetId);")],T_I,'opening from the list'),
 # FAILED is not an answer on open: no toast, the stored card. ONE edit, run against the two
 # tests that reach FAILED (a panel failure, an exhausted budget): both must fail.
 ('A2-03',[(RT,"      if (outcome === 'NOT_FOUND') {\n        return { key: 'bot.service.not_found'","      if (outcome === 'FAILED') return toastReply('bot.service.refresh_failed');\n      if (outcome === 'NOT_FOUND') {\n        return { key: 'bot.service.not_found'")],T_I,FAILURE_TESTS),
 # N1: an unexpected error propagates; an expected refusal draws the stored card.
 ('A2-04',[(RT,"        if (!isExpectedRefreshRefusal(error)) throw error;\n","")],T_I,'an unexpected error thrown by the refresh'),
 ('A2-05',[(RT,"        if (!isExpectedRefreshRefusal(error)) throw error;\n","        throw error;\n")],T_I,'an expected refusal thrown by the refresh'),
 # B1: the open's own bounds. The open asks for them...
 ('A2-06',[(RT,"              onOpen: true,","              onOpen: false,")],T_I,'confirmed unreachable is not dialled on open|at the background floor is not spent'),
 # ...a panel the monitor confirmed unusable is not dialled on open...
 ('A2-07',[(SR,"    if (onOpen && view !== null && isConfirmedUnusable(view.health, this.deps.clock.now())) {","    if (false && onOpen && view !== null && isConfirmedUnusable(view.health, this.deps.clock.now())) {")],T_I,'confirmed unreachable is not dialled on open'),
 # ...but the ♻️ button still dials it.
 ('A2-08',[(SR,"    if (onOpen && view !== null && isConfirmedUnusable(view.health, this.deps.clock.now())) {","    if (view !== null && isConfirmedUnusable(view.health, this.deps.clock.now())) {")],T_I,'confirmed unreachable is not dialled on open'),
 # ...the open's token comes from above the background floor...
 ('A2-09',[(SR,"          onOpen ? this.deps.backgroundBudgetReserve : 0,","          0,")],T_I,'at the background floor is not spent'),
 # ...and the ♻️ button still takes from the floor (reserve 0).
 ('A2-10',[(SR,"          onOpen ? this.deps.backgroundBudgetReserve : 0,","          this.deps.backgroundBudgetReserve,")],T_I,'at the background floor is not spent'),
 # N4: no read for a card with a change in progress («working»).
 ('A2-11',[(RT,"      service !== null &&\n      !(await this.deps.services.changeInProgress(scope, service))\n","      service !== null\n")],T_I,'change in progress is drawn'),
]

only=sys.argv[1:]
killed=0; ran=0; kills=0
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  originals={}; ok=True
  try:
    # Write -> run -> restore: the restore is in `finally`, so an interrupted run or a
    # failing subprocess never leaves a mutant in the tree.
    for f,a,b in edits:
      s=originals.get(f) or open(f,encoding='utf-8').read()
      originals.setdefault(f,s)
      cur=open(f,encoding='utf-8').read()
      if cur.count(a)!=1:
        print(mid,'ANCHOR MISSING in',f,cur.count(a),flush=True); ok=False; break
      open(f,'w',encoding='utf-8').write(cur.replace(a,b))
    if ok:
      ran+=1
      r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
      out=r.stdout+r.stderr
      failed=[l.strip() for l in out.splitlines() if '×' in l]
      summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
      ran_any=any('passed' in l or 'failed' in l for l in summ)
      if r.returncode!=0 and ran_any: killed+=1; kills+=len(failed)
      print(mid,'KILLED' if (r.returncode!=0 and ran_any) else 'SURVIVED',summ,failed,flush=True)
  finally:
    for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
print(f'{killed} of {ran} mutants killed ({kills} failing tests in all)',flush=True)
