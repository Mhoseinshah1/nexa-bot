"""Web route polish (roadmap B1-B4, B7) mutation driver (docs/web-redesign/route-audit.md).

Reverts one rule at a time, runs the named web test, and restores the file from the copy it
read. A mutant is KILLED only when a named test FAILED.
Usage: python3 scripts/mutate-web-route-polish.py [WRP-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

W='apps/web/src/'
REC=W+'pages/recovery.tsx'
BSC=W+'pages/backup-schedule.tsx'
T_REC='tests/web/recovery.test.tsx'
T_MC='tests/web/mutation-consistency.test.tsx'

M=[
 # --- B3: one idempotency key per logical attempt -------------------------------------------
 ('WRP-01',[(REC,"idempotencyKey: runNowKey.current('run-now')","idempotencyKey: crypto.randomUUID()")],T_REC,'automatic retry of a 5xx'),
 ('WRP-02',[(REC,"onError: (error) => runNowKey.settleOn(error),","onError: () => runNowKey.settle(),")],T_REC,'presses again after an unanswered'),
 ('WRP-03',[(REC,"    onSuccess: () => {\n      runNowKey.settle();","    onSuccess: () => {\n")],T_REC,'once one has succeeded'),
 ('WRP-04',[(BSC,"save.mutate({ ...command, idempotencyKey: submission.current(command) });","save.mutate({ ...command, idempotencyKey: newIdempotencyKey() });")],T_MC,'never from newIdempotencyKey'),
 ('WRP-05',[(BSC,"    }) => saveSetting(command),","    }) => saveSetting({ ...command, idempotencyKey: newIdempotencyKey() }),")],T_MC,'never minted inside a mutationFn'),
]

only=sys.argv[1:]
killed=0; ran=0
for mid,edits,test,filt in M:
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
    r=subprocess.run(['pnpm','exec','vitest','run','--project','web',test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    ran_any=any('passed' in l or 'failed' in l for l in summ)
    dead=r.returncode!=0 and ran_any and len(failed)>0
    if dead: killed+=1
    print(mid,'KILLED' if dead else 'SURVIVED',summ,failed[:2],flush=True)
  for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
print(f'{killed} of {ran} killed',flush=True)
