"""Package C (GB display) mutation driver (docs/package-c-falsification.md).

Reverts one rule at a time, runs the named tests, and restores the file with `git checkout`.
A mutation of `packages/contracts` or `packages/i18n` rebuilds that package before its test
and again after the restore, because the tests import its `dist`. Needs a clean tree. No
database: every test named here is a unit or web test. The input half of the package is
WP21's, falsified by `scripts/mutate-wp21.py`.
Usage: python3 scripts/mutate-package-c.py [C-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

TI='packages/contracts/src/traffic-input.ts'
I18N='packages/i18n/src/index.ts'
FMT='apps/web/src/format.ts'
PROD='apps/web/src/pages/products.tsx'
ORD='apps/web/src/pages/orders.tsx'
SVC='apps/web/src/pages/services.tsx'

T_U=('unit','tests/unit/traffic-format.test.ts')
T_CARD=('unit','tests/unit/customer-screens.test.ts')
T_PO=('web','tests/web/products-and-orders.test.tsx')
T_S=('web','tests/web/services.test.tsx')

# (id, [(file, before, after)], test, name filter)
M=[
 ('C-01',[(I18N,"  return `${groupTrafficFigure(formatTrafficGb(bytes))} ${GB_WORD[locale]}`;","  return `${bytes.toString()} ${GB_WORD[locale]}`;")],T_U,'shows every allowance in GB'),
 ('C-02',[(I18N,"  return `${groupTrafficFigure(formatTrafficGb(bytes))} ${GB_WORD[locale]}`;","  return `${formatTrafficGb(bytes)} ${GB_WORD[locale]}`;")],T_U,'grouped, instead of switching unit'),
 ('C-03',[(TI,"  const hundredths = (magnitude * 100n + BYTES_PER_GB / 2n) / BYTES_PER_GB;","  const hundredths = (magnitude * 100n) / BYTES_PER_GB;")],T_U,'nearest hundredth'),
 ('C-04',[(TI,".padStart(2, '0').replace(/0$/u, '')",".padStart(2, '0')")],T_U,'no noisy .00'),
 ('C-05',[(I18N,"  const grouped = whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');","  const grouped = whole;")],T_U,'where Number would round'),
 ('C-06',[(FMT,"  return groupTrafficFigure(formatTrafficGb(bytes));","  return formatTrafficGb(bytes);")],T_U,'Web Admin’s rule too'),
 ('C-07',[(PROD,"<Ltr>{formatTrafficGbText(value)}</Ltr>","<Ltr>{value.toString()}</Ltr>")],T_PO,'10.25 GB allowance as 10.25'),
 ('C-08',[(ORD,"<Ltr>{formatTrafficGbText(value)}</Ltr>","<Ltr>{value.toString()}</Ltr>")],T_PO,'order line’s traffic in GB'),
 ('C-09',[(SVC,"<Ltr>{formatTrafficGbText(bytes)}</Ltr>","<Ltr>{bytes.toString()}</Ltr>")],T_S,'limit and the used traffic in GB'),
 ('C-10',[(I18N,"  return `${groupTrafficFigure(formatTrafficGb(bytes))} ${GB_WORD[locale]}`;","  return `${groupTrafficFigure(formatTrafficGb(bytes))} ${bytes === 0n ? 'بایت' : GB_WORD[locale]}`;")],T_CARD,'floors remaining days and remaining traffic at zero'),
]

def build(pkg):
  subprocess.run(['pnpm','--filter',pkg,'build'],capture_output=True,check=True)

def rebuild(files):
  if any(f.startswith('packages/contracts') for f in files):
    build('@nexa/contracts'); build('@nexa/i18n')
  elif any(f.startswith('packages/i18n') for f in files):
    build('@nexa/i18n')

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
    rebuild(files)
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  rebuild(files)
