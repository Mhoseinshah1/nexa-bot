"""TB4 (support AI provider foundation) mutation driver
(docs/support-agent/tb4-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
A mutation of `packages/contracts` rebuilds it before its test and again after the restore.
TB4-07 and TB4-08 need the integration database (`bash scripts/dev-services.sh`).
Usage: python3 scripts/mutate-tb4.py [TB4-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

C='packages/contracts/src/support-ai.ts'
CHAIN='apps/api/src/modules/control/support-ai/application/support-ai-chain.ts'
CFG='apps/api/src/modules/control/support-ai/application/support-ai-config.service.ts'
HTTP='apps/api/src/infrastructure/ai/ai-http.ts'
OAI='apps/api/src/infrastructure/ai/openai-adapter.ts'
ANT='apps/api/src/infrastructure/ai/anthropic-adapter.ts'
T_A=('unit','tests/unit/support-ai-adapters.test.ts')
T_C=('unit','tests/unit/support-ai-chain.test.ts')
T_I=('integration','tests/integration/support-ai-config.test.ts')

M=[
 ('TB4-01',[(CHAIN,"      if (!supportAiOutcomeFallsBack(outcome.outcome)) return last;\n","")],T_C,'never falls back'),
 ('TB4-02',[(C,"  'TIMEOUT',\n] as const satisfies readonly SupportAiOutcomeKind[];","  'TIMEOUT',\n  'INVALID_OUTPUT',\n] as const satisfies readonly SupportAiOutcomeKind[];")],T_C,'never falls back'),
 ('TB4-03',[(CHAIN,"      if (state.trippedUntil !== null && state.trippedUntil.getTime() > now.getTime()) continue;\n","")],T_C,'skips a tripped provider'),
 ('TB4-04',[(CHAIN,"      if (await this.deps.credentials.markRejected(scope, provider, now)) {","      if ((await this.deps.credentials.markRejected(scope, provider, now)) || true) {")],T_C,'raises credential_rejected once'),
 ('TB4-05',[(OAI,"  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {","  if (code === 'never') {")],T_A,'never RATE_LIMITED'),
 ('TB4-06',[(ANT,"  if (stop === 'refusal') return { outcome: 'REFUSED_BY_PROVIDER', code: 'anthropic.refusal', usage };\n","")],T_A,'maps refusal'),
 ('TB4-07',[(CFG,"        if (command.config.mode === 'AUTO_REPLY_SAFE' && before.config.mode !== 'AUTO_REPLY_SAFE') {","        if (command.config.mode === 'NEVER' && before.config.mode !== 'AUTO_REPLY_SAFE') {")],T_I,'entering automatic replies require'),
 ('TB4-08',[(CFG,"      if (written.wasRejected) await this.closeRejection(scope, provider, tx);\n","")],T_I,'replacing the key closes it'),
 ('TB4-09',[(HTTP,"        redirect: 'error',\n","")],T_A,'never follows a redirect'),
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
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:2],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  rebuild(files)
