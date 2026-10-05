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
T_I=('integration','tests/integration/customer-ux-services.test.ts')

M=[
 # The call itself, on each of the two intents that open a card.
 ('A2-01',[(RT,"    if (command.intent === 'SERVICE' && command.targetId !== null) {\n      return this.openServiceCard(","    if (command.intent === 'SERVICE' && command.targetId !== null) {\n      return this.serviceDetail(")],T_I,'opening a card makes one panel read'),
 ('A2-02',[(RT,"      const card = await this.openServiceCard(scope, actor, customer, command.targetId);","      const card = await this.serviceDetail(scope, actor, customer, command.targetId);")],T_I,'opening from the list'),
 # FAILED is not an answer on open: no toast, the stored card.
 ('A2-03',[(RT,"      if (outcome === 'NOT_FOUND') {\n        return { key: 'bot.service.not_found'","      if (outcome === 'FAILED') return toastReply('bot.service.refresh_failed');\n      if (outcome === 'NOT_FOUND') {\n        return { key: 'bot.service.not_found'")],T_I,'a panel failure draws the stored card'),
 # The budget exhausted is FAILED too: the same rule, through the budget.
 ('A2-04',[(RT,"      if (outcome === 'NOT_FOUND') {\n        return { key: 'bot.service.not_found'","      if (outcome === 'FAILED') return toastReply('bot.service.refresh_failed');\n      if (outcome === 'NOT_FOUND') {\n        return { key: 'bot.service.not_found'")],T_I,'an exhausted probe budget'),
 # A refresh that throws never fails the open.
 ('A2-05',[(RT,"      } catch {\n        // An open never fails because a refresh did; the stored card is drawn below.\n        outcome = null;\n      }","      } finally {\n        // mutant: the throw propagates\n      }")],T_I,'a refresh that throws'),
]

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
print(f'{killed} of {ran} killed',flush=True)
