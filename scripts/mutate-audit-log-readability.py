"""UX Batch 02, issue 15 mutation driver: the Audit Log keeps a long actor/job id to two
lines without hiding any of it.

Reverts one rule at a time, runs the named web tests, and restores the file with
`git checkout`. Needs a clean tree. Usage:
python3 scripts/mutate-audit-log-readability.py [AL-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps']).returncode != 0:
  sys.exit('apps/ has uncommitted changes; a mutation restore would discard them')

P='apps/web/src/pages/audit-log.tsx'
B='apps/web/src/styles/base.css'
O='apps/web/src/styles/pages/ops-b.css'

T=('web','tests/web/audit-log.test.tsx')
T_CSS=('web','tests/web/stylesheet-contract.test.tsx')

BOUNDED="const bounded = style?.long === true ? 'clamp-2 audit-id' : undefined;"
TITLE='const title = style?.long === true ? (shown ?? undefined) : undefined;'
TECH='      <span className={bounded === undefined ? \'ltr mono\' : `ltr mono ${bounded}`} title={title}>\n        {shown}\n'
COPY_WHEN='{shown !== null && (style?.technical === true || style?.long === true) && ('
M=[
 ('AL-01',[(P,BOUNDED,"const bounded = undefined;")],T,'actor'),
 ('AL-02',[(P,TITLE,'const title = undefined;')],T,'actor'),
 ('AL-03',[(P,COPY_WHEN,'{false && (')],T,'cop'),
 ('AL-04',[(P,'<CopyButton value={shown}','<CopyButton value={shown.slice(0, 20)}')],T,'cop'),
 ('AL-05',[(P,TECH,TECH.replace('{shown}\n','{shown.slice(0, 30)}\n'))],T,'actor'),
 # Review of #191: the floor and the copy button on every label, the body font on a job id.
 ('AL-11',[(P,BOUNDED,"const bounded = 'clamp-2 audit-id';")],T,'short'),
 ('AL-12',[(P,COPY_WHEN,'{shown !== null && (')],T,'short'),
 ('AL-13',[(P,"`ltr mono ${bounded}`","`${bounded}`"),(P,"bounded === undefined ? 'ltr mono' :","bounded === undefined ? '' :")],T,'actor'),
 ('AL-14',[(P,"TECHNICAL_ACTORS.has(actorType) || label.startsWith('job:')","TECHNICAL_ACTORS.has(actorType)")],T,'technical'),
 ('AL-15',[(P,'long: label.length > LONG_ACTOR_LABEL,','long: label.length >= LONG_ACTOR_LABEL,')],T,'technical'),
 ('AL-16',[(O,'.audit-action {\n  width: fit-content;\n  max-width: 18rem;\n}','.audit-action {\n  min-width: 10rem;\n  width: fit-content;\n  max-width: 18rem;\n}')],T_CSS,'audit'),
 ('AL-17',[(O,'.audit-action {\n  width: fit-content;\n','.audit-action {\n')],T_CSS,'audit'),
 ('AL-18',[(P,'className="clamp-2 audit-action"','className="clamp-2 audit-id"')],T,'action'),
 ('AL-06',[(B,'  white-space: normal;\n  overflow-wrap: anywhere;\n  line-height: 1.45;','  white-space: normal;\n  overflow-wrap: break-word;\n  line-height: 1.45;')],T_CSS,'clamp'),
 ('AL-07',[(B,'  overflow: hidden;\n  white-space: normal;\n  overflow-wrap: anywhere;','  overflow: hidden;\n  overflow-wrap: anywhere;')],T_CSS,'clamp'),
 ('AL-08',[(O,'  min-width: 10rem;\n  max-width: 18rem;\n','  min-width: 10rem;\n')],T_CSS,'audit'),
 ('AL-09',[(P,'<span className="clamp-2 audit-action" dir="ltr" title={row.action}>','<span dir="ltr">')],T,'action'),
 ('AL-10',[(O,'.audit-correlation {\n  white-space: normal;\n  overflow-wrap: anywhere;\n}','.audit-correlation {\n  white-space: normal;\n}')],T_CSS,'audit'),
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
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
