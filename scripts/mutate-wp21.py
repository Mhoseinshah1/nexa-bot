"""WP21 mutation driver (docs/wp21-falsification.md).

Reverts one rule at a time, runs the named tests, and restores the file with `git checkout`.
A mutation of `packages/contracts` rebuilds the package before its test and again after the
restore, because the tests import its `dist`. Needs TEST_DATABASE_URL pointing at a
database nothing else is using, and a clean tree. Usage: python3 scripts/mutate-wp21.py
[W21-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if 'TEST_DATABASE_URL' not in os.environ:
  sys.exit('TEST_DATABASE_URL is required')
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

TI='packages/contracts/src/traffic-input.ts'
HTTP='packages/contracts/src/http.ts'
PS='apps/api/src/modules/commerce/catalog/application/product.service.ts'
AS='apps/api/src/modules/commerce/catalog/application/addon.service.ts'
PC='apps/api/src/surfaces/web/products.controller.ts'
AC='apps/api/src/surfaces/web/service-addons.controller.ts'
WEB='apps/web/src/pages/products.tsx'

T_U=('unit','tests/unit/wp21-traffic-input.test.ts')
T_HTTP=('integration','tests/integration/products-http.test.ts')
T_PROV=('integration','tests/integration/wp21-traffic-to-provider.test.ts')
T_RULE=('web','tests/web/wp21-traffic-rule.test.tsx')
T_FORM=('web','tests/web/products-and-orders.test.tsx')

M=[
 ('W21-01',[(TI,"export const BYTES_PER_GB = 1_073_741_824n;","export const BYTES_PER_GB = 1_000_000_000n;")],T_PROV,'10.25 GB converts to'),
 ('W21-02',[(TI,"  return (hundredths * BYTES_PER_GB + 50n) / 100n;","  return (hundredths * BYTES_PER_GB) / 100n;")],T_U,'rounds a hundredth'),
 ('W21-03',[(TI,"(\\.[0-9]{1,2})?$/u;","(\\.[0-9]{1,3})?$/u;")],T_HTTP,'refuses three decimals'),
 ('W21-04',[(TI,"= /^(0|[1-9][0-9]{0,8})","= /^-?(0|[1-9][0-9]{0,8})")],T_U,'refuses more than two decimals'),
 ('W21-05',[(TI,"  const hundredths = (magnitude * 100n + BYTES_PER_GB / 2n) / BYTES_PER_GB;","  const hundredths = (magnitude * 100n) / BYTES_PER_GB;")],T_U,'reopens a saved figure as typed'),
 ('W21-06',[(TI,"  return formatTrafficGb(stored) === formatTrafficGb(submitted) ? stored : submitted;","  return submitted;")],T_HTTP,'keeps a historical byte count'),
 ('W21-07',[(TI,"  if ((stored === 0n) !== (submitted === 0n)) return submitted;\n","")],T_U,'never keeps a figure over a change'),
 ('W21-08',[(HTTP,"  .refine((p) => p.trafficGb === null || (parseTrafficGb(p.trafficGb) ?? 0n) > 0n, {","  .refine((p) => p.trafficGb === null || (parseTrafficGb(p.trafficGb) ?? 0n) >= 0n, {")],T_HTTP,'refuses a typed zero'),
 ('W21-09',[(PS,"""              trafficBytes: trafficBytesAfterEdit(
                before.specification.trafficBytes,
                input.edit.specification.trafficBytes,
              ),""","""              trafficBytes: input.edit.specification.trafficBytes,""")],T_HTTP,'keeps a historical byte count an edit'),
 ('W21-10',[(AS,"          keepUntouchedTraffic(before.specification.trafficBytes, input.edit),","          input.edit,")],T_HTTP,'keeps an add-on'),
 ('W21-11',[(PC,"command.trafficGb === null ? UNLIMITED_TRAFFIC_BYTES : bytesOf(command.trafficGb),","command.trafficGb === null ? UNLIMITED_TRAFFIC_BYTES : BigInt(command.trafficGb.replace('.', '')),")],T_HTTP,'stores 10.25 GB'),
 ('W21-12',[(AC,"command.trafficGb === null ? null : bytesOf(command.trafficGb),","command.trafficGb === null ? null : BigInt(command.trafficGb.replace('.', '')),")],T_HTTP,'takes an add-on'),
 ('W21-13',[(WEB,"      trafficGb: state.trafficUnlimited ? null : traffic,","      trafficGb: state.trafficUnlimited ? '0' : traffic,")],T_RULE,'sends null'),
 ('W21-14',[(WEB,"(trafficBytes === null || trafficBytes <= 0n || trafficBytes > MAX_TRAFFIC_BYTES)","(trafficBytes === null || trafficBytes > MAX_TRAFFIC_BYTES)")],T_RULE,'accepts exactly what the schema accepts'),
 ('W21-15',[(WEB,"        : formatTrafficGb(BigInt(row.trafficBytes)),","        : row.trafficBytes,")],T_FORM,'reopens a saved 10.25'),
]

def build_contracts():
  subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True,check=True)

only=sys.argv[1:]
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  files=set(); ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a),flush=True); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  contracts=any(f.startswith('packages/contracts') for f in files)
  if ok:
    if contracts: build_contracts()
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  if contracts: build_contracts()
