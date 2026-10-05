"""Pre-support A6 (service location label) mutation driver (docs/pre-support/a6-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-a6.py [A6-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

POLICY='apps/api/src/modules/commerce/locations/application/location-change-policy.ts'
RUNTIME='apps/api/src/surfaces/telegram/bot-runtime.ts'
CONTAINER='apps/api/src/container.ts'
T_U=('unit','tests/unit/presupport-a6-location-label.test.ts')
T_I=('integration','tests/integration/presupport-a6-location-label.test.ts')

M=[
 # The precedence: moved, then the panel's initial location, then the product.
 ('A6-01',[(POLICY,"  return movedLabel ?? panelInitialLabel ?? productLabel ?? null;","  return panelInitialLabel ?? movedLabel ?? productLabel ?? null;")],T_U,'moved label, then'),
 ('A6-02',[(POLICY,"  return movedLabel ?? panelInitialLabel ?? productLabel ?? null;","  return movedLabel ?? productLabel ?? panelInitialLabel ?? null;")],T_I,'sibling panel'),
 ('A6-03',[(POLICY,"  return movedLabel ?? panelInitialLabel ?? productLabel ?? null;","  return movedLabel ?? panelInitialLabel ?? null;")],T_I,'falls back'),
 # The panel's initial location is the panel-wide INITIAL row only.
 ('A6-04',[(POLICY,"  return rows.find((row) => row.initial && row.productId === null);","  return rows.find((row) => row.initial);")],T_U,'panel-wide INITIAL row'),
 ('A6-09',[(POLICY,"  return movedLabel ?? panelInitialLabel ?? productLabel ?? null;","  return panelInitialLabel ?? productLabel ?? null;")],T_I,'moved service'),
 # The service card reads the CURRENT panel's initial location.
 ('A6-05',[(RUNTIME,"          : ((await this.deps.panelLocations?.initialLabelFor(scope, service.panelId)) ?? null),","          : null,")],T_I,'sibling panel'),
 # The delivery card reads it too, through the same function.
 ('A6-06',[(CONTAINER,"              : await panelInitialLocationLabel(scope, service.panelId),","              : null,")],T_I,'sibling panel'),
 # The runtime is wired to the source.
 ('A6-07',[(CONTAINER,"      panelLocations: { initialLabelFor: panelInitialLocationLabel },\n","")],T_I,'sibling panel'),
 # Never a panel's identity: the label, not the name or key.
 ('A6-08',[(CONTAINER,"    initialLocationOf(await serviceLocationRepository.forPanel(scope, panelId))?.label ?? null;","    initialLocationOf(await serviceLocationRepository.forPanel(scope, panelId))?.locationKey ?? null;")],T_I,'internal'),
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
