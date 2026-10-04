"""TB1 (Telegram Business connection + transport) mutation driver (docs/support-agent/tb1-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
A mutation of `packages/contracts` rebuilds it before its test and again after the restore,
because the tests import its `dist`. Needs a clean tree. TB1-08 needs the integration
database (`bash scripts/dev-services.sh`).
Usage: python3 scripts/mutate-tb1.py [TB1-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

CTRL='apps/api/src/surfaces/telegram/webhook.controller.ts'
UPD='apps/api/src/surfaces/telegram/business-updates.ts'
BC='packages/contracts/src/business-chats.ts'
DOM='apps/api/src/modules/commerce/business-chats/domain/telegram-business.ts'
TR='apps/api/src/modules/commerce/business-chats/application/business-transport.ts'
SVC='apps/api/src/modules/commerce/business-chats/application/business-connection.service.ts'

T_U=('unit','tests/unit/business-chats.test.ts')
T_W=('unit','tests/unit/business-webhook.test.ts')
T_T=('unit','tests/unit/business-transport.test.ts')
T_I=('integration','tests/integration/business-connections.test.ts')

# (id, [(file, before, after)], test, name filter)
M=[
 ('TB1-01',[(CTRL,"    if (business !== null) {","    if (business !== null && false) {")],T_W,'never the customer turn'),
 ('TB1-02',[(BC,"  if (input.fromUserId !== null && input.fromUserId !== input.ownerUserId) return 'INBOUND';","  if (input.fromUserId !== input.ownerUserId) return 'INBOUND';")],T_U,'no sender never counts'),
 ('TB1-03',[(BC,"  if (input.senderBusinessBotId !== null) return 'OTHER_BOT';","  if (input.senderBusinessBotId !== null) return 'OWN_ECHO';")],T_U,'another business bot'),
 ('TB1-04',[(BC,"  if (!BUSINESS_REQUIRED_RIGHTS.every((right) => held.has(right))) return 'RIGHTS_INSUFFICIENT';","")],T_U,'fails closed'),
 ('TB1-05',[(TR,"    if (status !== 'ACTIVE') {","    if (status === 'SUPERSEDED' && false) {")],T_T,'refuses before any request'),
 ('TB1-06',[(TR,"      if (sent.errorCode === 'telegram.rate_limited') {","      if (sent.errorCode !== '') {")],T_T,'UNKNOWN'),
 ('TB1-07',[(DOM,"    (right): right is BusinessBotRight => granted[right] === true,","    (right): right is BusinessBotRight => granted[right] !== false,")],T_U,'absent rights object as NO rights'),
 ('TB1-08',[(SVC,"          change === 'INSERTED'\n","          change === 'INSERTED' && false\n")],T_I,'supersedes'),
 ('TB1-09',[(UPD,"        await report('CONNECTION_NOT_APPLIED', error).catch(() => undefined);\n        throw error;","        await report('CONNECTION_NOT_APPLIED', error).catch(() => undefined);")],T_W,'Telegram redelivers it'),
]

def build(pkg):
  subprocess.run(['pnpm','--filter',pkg,'build'],capture_output=True,check=True)

def rebuild(files):
  if any(f.startswith('packages/contracts') for f in files):
    build('@nexa/contracts'); build('@nexa/i18n')

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
