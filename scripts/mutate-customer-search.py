"""Customer Search mutation driver (UX batch 02, issues 12 and 13; docs/web-admin-search.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
Refuses a dirty apps/ or packages/ tree, because the restore would discard it. CS-08 runs an
integration test and needs TEST_DATABASE_URL (and DATABASE_URL) pointing at a database nothing
else is using; it is skipped, and says so, without one. Usage:
python3 scripts/mutate-customer-search.py [CS-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

LS='apps/web/src/ui/list-search.tsx'
US='apps/web/src/pages/users.tsx'
FA='apps/web/src/i18n/web.fa.ts'
REPO='apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository.ts'

T_WEB=('web','tests/web/customer-search.test.tsx')
T_TURN=('integration','tests/integration/telegram-customer-turn.test.ts')

M=[
 ('CS-01',[(US,"            autoApply\n","            autoApply={false}\n")],T_WEB,'sends ONE request for a burst'),
 ('CS-02',[(LS,"setTimeout(() => commit(wanted), LIST_SEARCH_DEBOUNCE_MS)","setTimeout(() => commit(wanted), 0)")],T_WEB,'sends ONE request for a burst'),
 ('CS-03',[(LS,"if (!autoApply || hidden || wanted === applied)","if (!autoApply || wanted === applied)")],T_WEB,'applies nothing by itself while the list is refused'),
 ('CS-04',[(LS,"const wanted = term === null ? '' : text.trim();","const wanted = term === null ? '' : text;")],T_WEB,'treats a paste exactly as typing'),
 ('CS-05',[(US,"queryKey: ['customers', searchSignature, cursor ?? null],","queryKey: ['customers', cursor ?? null],")],T_WEB,'never draws an older, slower answer'),
 ('CS-06',[(LS,"    setDraft((current) => ({ applied: value, text: current.text }));\n","")],T_WEB,'sends ONE request for a burst'),
 ('CS-07',[(FA,"'web.user_first_seen': 'اولین فعالیت',","'web.user_first_seen': 'نخستین تماس',")],T_WEB,'names first and last ACTIVITY'),
 ('CS-08',[(REPO,"          lastSeenAt: sql`greatest(${customers.lastSeenAt}, excluded.last_seen_at)`,\n","")],T_TURN,'moves last_seen_at on an ordinary message'),
]

only=sys.argv[1:]
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  if project=='integration' and 'TEST_DATABASE_URL' not in os.environ:
    print(mid,'SKIPPED: TEST_DATABASE_URL is required for an integration mutation',flush=True)
    continue
  files=set(); ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a),flush=True); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  if ok:
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt,'--testTimeout','600000'],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
