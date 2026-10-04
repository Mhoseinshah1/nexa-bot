"""UX Batch 02, issue 14 mutation driver: System -> Administrators -> New administrator
explains every unmet requirement instead of a silently disabled button.

Reverts one rule at a time, runs the web tests, and restores the file with
`git checkout`. Needs a clean tree. Usage:
python3 scripts/mutate-new-admin-validation.py [NA-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps']).returncode != 0:
  sys.exit('apps/ has uncommitted changes; a mutation restore would discard them')

P='apps/web/src/pages/system.tsx'

T=('web','tests/web/administrators.test.tsx')

M=[
 # The button is disabled again on the hidden predicate: the original defect.
 ('NA-01',[(P,'disabled={mutate.isPending}>','disabled={mutate.isPending || Object.keys(createAdminIssues({ username, displayName, password, roleKeys })).length > 0}>')],T),
 # An incomplete form is sent anyway, instead of explained before any request.
 ('NA-02',[(P,'if (Object.keys(found).length > 0) return;','void found;')],T),
 # A privilege escalation lands on the username field, as it did before.
 ('NA-03',[(P,"return { field: 'roleKeys', message: t('web.admin_privilege_escalation') };","return { field: 'username', message: t('web.admin_privilege_escalation') };")],T),
 # The role list draws nothing while loading, refused or empty.
 ('NA-04',[(P,'{roles.isPending ? (','{false ? ('),
           (P,') : roles.isError ? (',') : false ? ('),
           (P,') : available.length === 0 ? (',') : false ? (')],T),
 # The username is judged without the server's lower-casing, refusing `NewComer`.
 ('NA-05',[(P,'const username = input.username.trim().toLowerCase();','const username = input.username.trim();')],T),
 # The owner-grant 403 is no longer put on the roles field in Persian.
 ('NA-06',[(P,"=== 'admins.permissions.edit'","=== 'never'")],T),
 # A ticked role the catalogue no longer draws is validated and sent again.
 ('NA-07',[(P,'const chosen = roleKeys.filter((key) => available.some((role) => role.key === key));','const chosen = roleKeys;')],T),
 # The keys `role.not_found` names stay selected.
 ('NA-08',[(P,'setRoleKeys((current) => current.filter((key) => !missing.includes(key)));','void missing;')],T),
 # The catalogue is not read again after `role.not_found`.
 ('NA-09',[(P,"""          setRoleKeys((current) => current.filter((key) => !missing.includes(key)));
        }
        void queries.invalidateQueries({ queryKey: ['roles'] });""","""          setRoleKeys((current) => current.filter((key) => !missing.includes(key)));
        }""")],T),
 # Cancelling keeps the ticked roles.
 ('NA-10',[(P,"""    setRoleKeys([]);
    setRefusal(null);
    setAttempted(false);""","""    setRefusal(null);
    setAttempted(false);""")],T),
 # The username reason follows the first zod issue, so `اب` reads as too short.
 ('NA-11',[(P,"codes.includes('invalid_format')","codes[0] === 'invalid_format'")],T),
 # The idempotency fingerprint keeps the username's case.
 ('NA-12',[(P,'username: input.username.toLowerCase(),','username: input.username,')],T),
 # The idempotency fingerprint keeps the tick order.
 ('NA-13',[(P,'roleKeys: [...new Set(input.roleKeys)].sort(),','roleKeys: input.roleKeys,')],T),
]

only=sys.argv[1:]
for mid,edits,(project,test) in M:
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
