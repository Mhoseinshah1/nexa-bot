"""TB4 (support AI provider foundation) mutation driver
(docs/support-agent/tb4-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
A mutation of `packages/contracts` rebuilds it before its test and again after the restore.
The integration mutants (T_I) need the integration database (`bash scripts/dev-services.sh`).
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
REPO='apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai.repository.ts'
ALERT='apps/api/src/modules/control/support-ai/application/credential-alert.ts'
T_A=('unit','tests/unit/support-ai-adapters.test.ts')
T_C=('unit','tests/unit/support-ai-chain.test.ts')
T_I=('integration','tests/integration/support-ai-config.test.ts')

M=[
 ('TB4-01',[(CHAIN,"      if (!supportAiOutcomeFallsBack(outcome.outcome)) return last;\n","")],T_C,'never falls back'),
 ('TB4-02',[(C,"  'TIMEOUT',\n] as const satisfies readonly SupportAiOutcomeKind[];","  'TIMEOUT',\n  'INVALID_OUTPUT',\n] as const satisfies readonly SupportAiOutcomeKind[];")],T_C,'never falls back'),
 ('TB4-03',[(CHAIN,"      if (state.trippedUntil !== null && state.trippedUntil.getTime() > now.getTime()) continue;\n","")],T_C,'skips a tripped provider'),
 ('TB4-04',[(ALERT,"      !transitioned &&\n      ((await","      false &&\n      ((await")],T_C,'raises credential_rejected once'),
 ('TB4-05',[(OAI,"  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {","  if (code === 'never') {")],T_A,'never RATE_LIMITED'),
 ('TB4-06',[(ANT,"  if (stop === 'refusal')\n    return { outcome: 'REFUSED_BY_PROVIDER', code: 'anthropic.refusal', usage };\n","")],T_A,'maps refusal'),
 ('TB4-07',[(CFG,"        if (command.config.mode === 'AUTO_REPLY_SAFE' && before.config.mode !== 'AUTO_REPLY_SAFE') {","        if (command.config.mode === 'NEVER' && before.config.mode !== 'AUTO_REPLY_SAFE') {")],T_I,'entering automatic replies require'),
 ('TB4-08',[(CFG,"      if (written.wasRejected) await this.closeRejection(scope, provider, tx);\n","")],T_I,'replacing the key closes it'),
 ('TB4-09',[(HTTP,"        redirect: 'error',\n","")],T_A,'never follows a redirect'),
 # --- substitute review of PR #199 ---------------------------------------------------------
 ('TB4-10',[(CFG,"        SUPPORT_AI_AUTO_REPLY_PERMISSION,\n        denial,\n        error,","        SUPPORT_AI_CONFIGURE_PERMISSION,\n        denial,\n        error,")],T_I,'one DENIED audit row'),
 ('TB4-11',[(REPO,"        and(sameKey(tenantId, provider, keySetAt), isNull(supportAiProviderCredentials.rejectedAt)),","        and(\n          eq(supportAiProviderCredentials.tenantId, tenantId),\n          eq(supportAiProviderCredentials.provider, provider),\n          isNull(supportAiProviderCredentials.rejectedAt),\n        ),")],T_I,'401 from a call made with a since-replaced key'),
 ('TB4-12',[(REPO,"    const where = sameKey(tenantId, provider, keySetAt);","    const where = and(\n      eq(supportAiProviderCredentials.tenantId, tenantId),\n      eq(supportAiProviderCredentials.provider, provider),\n    );")],T_I,'transient failure from a call made with a since-replaced key'),
 ('TB4-13',[(REPO,"          sameKey(tenantId, provider, keySetAt),\n          isNotNull(supportAiProviderCredentials.rejectedAt),","          eq(supportAiProviderCredentials.tenantId, tenantId),\n          eq(supportAiProviderCredentials.provider, provider),\n          isNotNull(supportAiProviderCredentials.rejectedAt),")],T_I,'never clears the new key'),
 ('TB4-14',[(CHAIN,"!(await this.deps.credentials.claimProbe(scope, step.provider, credential.keySetAt, now))","false")],T_C,'exactly one of two concurrent callers'),
 ('TB4-15',[(REPO,"          lte(supportAiProviderCredentials.trippedUntil, now),\n","")],T_I,'claims the half-open probe once'),
 ('TB4-16',[(CHAIN,"      if (outcome.outcome === 'OK') await this.alert.accepted(","      await this.alert.accepted(")],T_C,'never clears a rejection or emits credential_accepted'),
 ('TB4-17',[(HTTP,"  return Math.max(\n    requested,\n    Math.min(requested + AI_OUTPUT_TOKEN_HEADROOM, AI_OUTPUT_TOKEN_BUDGET_MAX),\n  );","  return requested;")],T_A,'bounded output headroom'),
 ('TB4-18',[(ANT,"          max_tokens: outputTokenBudget(request.maxOutputTokens),","          max_tokens: request.maxOutputTokens,")],T_A,'bounded output headroom'),
 ('TB4-19',[(OAI,"          max_completion_tokens: outputTokenBudget(request.maxOutputTokens),","          max_completion_tokens: request.maxOutputTokens,")],T_A,'bounded output headroom'),
 ('TB4-20',[(CFG,"        await this.assertScopeActive(scope, tx);\n        const before","        const before")],T_I,'once the tenant is stopped'),
 ('TB4-21',[(CFG,"        await this.assertScopeActive(scope, tx);\n        const now = this.deps.clock.now();\n        const written","        const now = this.deps.clock.now();\n        const written")],T_I,'once the tenant is stopped'),
 ('TB4-22',[(CFG,"        await this.assertScopeActive(scope, tx);\n        const removed","        const removed")],T_I,'once the tenant is stopped'),
 ('TB4-23',[(ANT,"  if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {\n    return { outcome: 'INVALID_OUTPUT', code: 'anthropic.truncated', usage };\n  }\n","")],T_A,'truncatedParseable'),
 ('TB4-24',[(OAI,"  if (finish === 'length' || finish === 'model_context_window_exceeded') {\n    return { outcome: 'INVALID_OUTPUT', code: `${prefix}.truncated`, usage };\n  }\n","")],T_A,'truncatedParseable'),
 ('TB4-25',[(CFG,"        if (removed.wasRejected) await this.closeRejection(scope, provider, tx);\n","")],T_I,'deleting a rejected key closes its alert'),
 ('TB4-26',[(C,"    if (new Set(providers).size !== providers.length) {","    if (providers.length < 0) {")],T_C,'repeats a provider'),
 ('TB4-27',[(REPO,"        and(sameKey(tenantId, provider, keySetAt), isNull(supportAiProviderCredentials.rejectedAt)),","        sameKey(tenantId, provider, keySetAt),")],T_I,'a second mark answers false'),
 ('TB4-28',[(CHAIN,"      if (credential === null) continue;\n","")],T_C,'key is gone by the time it is read'),
 ('TB4-29',[(HTTP,"      if (total > AI_RESPONSE_MAX_BYTES) {","      if (total < 0) {")],T_A,'1 MB cap'),
 ('TB4-30',[(HTTP,"  assertOutsideTransaction('An AI provider call');\n","")],T_A,'inside a database transaction'),
 ('TB4-31',[(CHAIN,"      !(await this.deps.conditions.tenantConditionIsOpen(tenantId, SUPPORT_AI_UNAVAILABLE_CODE))","      false")],T_C,'records available only while unavailable is open'),
 ('TB4-32',[(CHAIN,"      dedupeKey: `${SUPPORT_AI_AVAILABLE_CODE}:chain`,\n","")],T_C,'records available only while unavailable is open'),
 ('TB4-33',[(ALERT,"      ((await this.deps.conditions.conditionIsOpen(scope, dedupeKey)) ||","      (true ||")],T_C,'raises credential_rejected again'),
 ('TB4-34',[(ALERT,"      (!(await this.deps.conditions.conditionIsOpen(scope, dedupeKey)) ||","      (true ||")],T_C,'closes a credential alert left open'),
 ('TB4-35',[(OAI,"  const notJson = nonJsonSuccess(result, body, prefix);\n  if (notJson !== null) return notJson;\n  if (result.status < 200","  if (result.status < 200")],T_A,'body is not JSON as TEMPORARY'),
 ('TB4-36',[(ANT,"  const notJson = nonJsonSuccess(result, body, 'anthropic');\n  if (notJson !== null) return notJson;\n","")],T_A,'body is not JSON as TEMPORARY'),
 ('TB4-37',[(HTTP,"{ kind: 'NETWORK', code: 'body_read_failed' }","{ kind: 'NETWORK', code: 'body_too_large' }")],T_A,'fails mid-read'),
 ('TB4-38',[(CFG,"      provider,\n      region: command.region ?? null,\n    });","      provider,\n      apiKey: command.apiKey,\n      region: command.region ?? null,\n    });")],T_I,'plaintext key out of the idempotency'),
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
