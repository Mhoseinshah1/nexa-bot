"""Package H (spec §7, §8, §9) mutation driver (docs/package-h-tutorials-marketing-stars.md).

Reverts one rule at a time, runs the named tests, and restores the file's original text.
Needs TEST_DATABASE_URL (and REDIS_URL) pointing at a database no other suite is using: the
integration suite truncates between tests. Run it in a separate worktree, never the
implementation checkout. Usage: python3 scripts/mutate-package-h.py [M1 ...]
"""
import subprocess, sys, os, re
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')
env=dict(os.environ)
M=[
 ('M1 §7 a video older than the tap is offered to the prompt','apps/api/src/modules/control/client-apps/application/client-app-video.service.ts',
  "(input.updateId === null || input.updateId <= prompt.openedUpdateId)","false",
  ['tests/integration/client-app-video.test.ts']),
 ('M2 §7 an expired prompt still stores','apps/api/src/modules/control/client-apps/application/client-app-video.service.ts',
  "if (prompt.expiresAt.getTime() <= now.getTime()) {","if (false) {",
  ['tests/integration/client-app-video.test.ts']),
 ('M3 §9 the service write does not re-check the policy','apps/api/src/modules/commerce/customers/application/customer.service.ts',
  "if (!(await this.marketingOptOutAllowed(scope, tx))) {","if (false) {",
  ['tests/integration/marketing-opt-out-policy.test.ts']),
 ('M4 §9 MARKETING always excludes stored opt-outs','apps/api/src/modules/commerce/broadcasts/application/marketing-opt-out-policy.ts',
  "return policy === undefined ? true : policy.honoured(scope, tx);","return true;",
  ['tests/integration/round-n-close.test.ts']),
 ('M5 §9 the support screen draws the button while OFF','apps/api/src/surfaces/telegram/bot-runtime.ts',
  "...((await this.deps.customers.marketingOptOutAllowed(scope))","...(true",
  ['tests/integration/marketing-opt-out-policy.test.ts']),
 ('M6 §8 a central-only route with no ratio is offered','apps/api/src/modules/commerce/payments/application/payment-gateway.service.ts',
  "!unpriceable.has(gateway.provider) &&","",
  ['tests/integration/fx-stars.test.ts']),
 ('M7 §8 the Stars route enables with central_fx off','apps/api/src/modules/commerce/payments/application/payment-gateway.service.ts',
  "if (!flagOn) {","if (false) {",
  ['tests/integration/fx-stars.test.ts']),
 ('M8 §8 the ratio can be cleared while the route is on','apps/api/src/modules/commerce/fx/application/stars-pricing.guards.ts',
  "if (route?.status === 'ACTIVE') {","if (false) {",
  ['tests/integration/fx-stars.test.ts']),
 ('M9 §8 a legacy stored rate blocks every route edit','apps/api/src/modules/commerce/payments/application/payment-gateway.service.ts',
  "input.config.providerUnitRateMinor !== undefined &&\n          input.config.providerUnitRateMinor !== null &&","config.providerUnitRateMinor !== null &&",
  ['tests/integration/fx-stars.test.ts']),
 ('M10 §8 Stars spec back to FIXED_RATE-first two policies','packages/contracts/src/payment-gateways.ts',
  "policies: ['CENTRAL_FX'],\n      fxBaseAsset: 'USDT',\n      modeSetting: null,","policies: ['FIXED_RATE', 'CENTRAL_FX'],\n      fxBaseAsset: 'USDT',\n      modeSetting: 'stars.pricing_mode',",
  ['tests/unit/fx-conversion.test.ts','tests/unit/telegram-stars.test.ts']),
 ('M11 §8 the retired mode guard accepts a change','apps/api/src/modules/commerce/fx/application/stars-pricing.guards.ts',
  "if (change.from === change.to) return Promise.resolve(null);","return Promise.resolve(null);",
  ['tests/integration/fx-stars.test.ts']),
]
only=sys.argv[1:]
for name,path,old,new,tests in M:
    if only and name.split()[0] not in only: continue
    src=open(path).read()
    if src.count(old)!=1:
        print(name,'PATTERN NOT FOUND',src.count(old)); continue
    open(path,'w').write(src.replace(old,new))
    try:
        if path.startswith('packages/contracts'):
            subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True)
        project='unit' if tests[0].startswith('tests/unit') else 'integration'
        r=subprocess.run(['pnpm','vitest','run','--project',project,*tests],capture_output=True,text=True,env=env,timeout=900)
        out=r.stdout+r.stderr
        m=re.search(r'Tests\s+(.*)',out)
        print(name,'=>',m.group(1).strip() if m else out[-500:],flush=True)
    finally:
        open(path,'w').write(src)
        if path.startswith('packages/contracts'):
            subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True)
