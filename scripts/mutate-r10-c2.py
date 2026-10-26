"""R10 C2 (the custom panel) mutation driver.

Reverts ONE rule at a time, runs the test that names it through scripts/claude/test-summary.sh,
and restores the file from the copy it read (checked by hash). Every mutant must turn its
test red. Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own (default below is the R10 C2 one).
Usage: python3 scripts/mutate-r10-c2.py [M1-skip-response-signature ...]
"""
import hashlib, os, subprocess, sys
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))+'/'
if subprocess.run(['git','diff','--quiet','--','apps','packages'],cwd=ROOT).returncode != 0:
    sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')
A='apps/api/src/modules/platform/providers/infrastructure/custom-panel.adapter.ts'
P='apps/api/src/modules/platform/providers/infrastructure/custom-panel-protocol.ts'
S='apps/api/src/modules/platform/panels/application/panel.service.ts'
E='apps/api/src/modules/commerce/provisioning/application/provision-executor.ts'
V='apps/api/src/modules/commerce/provisioning/application/provisioner.service.ts'
UNIT=['pnpm','exec','vitest','run','--project','unit']
INT=['pnpm','exec','vitest','run','--project','integration']
AD='tests/unit/custom-panel-adapter.test.ts'
DOC='tests/unit/custom-panel-protocol-doc.test.ts'
CI='tests/integration/custom-panel.test.ts'
M={
 'M1-skip-response-signature':(A,"    if (!signed) return failure(readUnsigned(result.status), result.status);","    if (false as boolean) return failure(readUnsigned(result.status), result.status);",UNIT+[AD,DOC]),
 'M2-unsigned-404-read-as-absent':(A,"""      method: 'GET',
      path: accountPath(ref.username),
    });
    if (!answer.ok) return answer;""","""      method: 'GET',
      path: accountPath(ref.username),
    });
    if (!answer.ok) return answer.status === 404 ? { ok: true, found: false } : answer;""",UNIT+[AD,DOC]),
 'M2i-unsigned-404-read-as-absent':(A,"""      method: 'GET',
      path: accountPath(ref.username),
    });
    if (!answer.ok) return answer;""","""      method: 'GET',
      path: accountPath(ref.username),
    });
    if (!answer.ok) return answer.status === 404 ? { ok: true, found: false } : answer;""",INT+[CI,'-t','wrong base URL']),
 'M3-unknown-code-as-refusal':(P,"""  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(CUSTOM_ERROR_CODES, code)) {
    return 'PROVIDER_ERROR';
  }""","""  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(CUSTOM_ERROR_CODES, code)) {
    return 'PROVIDER_REFUSED';
  }""",UNIT+[AD]),
 'M3i-unknown-code-as-refusal':(P,"""  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(CUSTOM_ERROR_CODES, code)) {
    return 'PROVIDER_ERROR';
  }""","""  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(CUSTOM_ERROR_CODES, code)) {
    return 'PROVIDER_REFUSED';
  }""",INT+[CI,'-t','unknown error code']),
 'M4-ownership-tag-mismatch-accepted':(A,"    if (account.nexaRef !== ref.clientId) return failure('PROVIDER_REFUSED', 409);\n","",UNIT+[AD]),
 'M5-executor-omits-operation-id':(E,"    operationId: input.operationId,\n  });","  });",INT+[CI,'-t','provisions with the operation id']),
 'M5b-new-operation-id-per-attempt':(V,"await suspendCall(adapter, target, http, ref, { operationId: operation.id }),","await suspendCall(adapter, target, http, ref, { operationId: crypto.randomUUID() }),",INT+[CI,'-t','suspends, resumes']),
 'M6-flag-gate-removed':(S,"          await this.assertProviderFeature(scope, providerType, tx);\n","",INT+[CI,'-t','is refused while custom_panel_provider is off']),
 'M7-https-gate-removed':(S,"    if (descriptor?.transport !== 'HTTPS_ONLY') return;","    if (descriptor !== null) return;",INT+[CI,'-t','refuses an http']),
 'M7b-adapter-https-check-removed':(A,"    if (!/^https:\\/\\//i.test(target.baseUrl)) return failure('BLOCKED_TARGET', null);\n","",UNIT+[AD,'-t','http:// base URL']),
 'M8-body-hash-dropped-from-canonical':(P,"    parts.nonce,\n    parts.bodySha256,\n  ].join('\\n');","    parts.nonce,\n  ].join('\\n');",UNIT+[DOC]),
 'M9-secret-length-gate-removed':(S,"      this.assertApiTokenLength(parsed.providerType, parsed.credentials.apiToken);\n","",INT+[CI,'-t','shorter than 32']),
 'M10-terminate-not-bound-as-gone':(A,"""    const written = await this.accountWrite(target, http, ref, ACCOUNT_SUFFIX.delete, context);
    if (!written.ok) return written;""","""    const written = await this.accountWrite(target, http, ref, ACCOUNT_SUFFIX.delete, context);
    if (!written.ok) return written.status === 409 ? { ok: true, wasPresent: false } : written;""",UNIT+[AD,'-t','terminateUser']),
 'M11-rotate-trusts-unchanged-link':(A,"    if (read.account.subscriptionUrl !== previousUrl) {","    if (read.account.subscriptionUrl !== previousUrl || unresolved === null) {",UNIT+[AD,'-t','rotateSubscription']),
 'M12-omitted-allowance-field-sent-as-zero':(A,"""      ...(plan.trafficLimitBytes === null
        ? {}
        : { trafficLimitBytes: formatBytes(plan.trafficLimitBytes) }),""","""      trafficLimitBytes: formatBytes(plan.trafficLimitBytes ?? 0n),""",UNIT+[AD,'-t','applyAllowance']),
 'M13-bytes-as-numbers':(A,"        trafficLimitBytes: formatBytes(input.volumeBytes ?? 0n),","        trafficLimitBytes: Number(input.volumeBytes ?? 0n),",UNIT+[AD,'-t','createUser']),
 'M15-per-panel-timeout-not-clamped':('apps/api/src/infrastructure/net/safe-http.ts',"        : Math.min(binding.timeoutMs, this.options.totalTimeoutMs);","        : binding.timeoutMs;",UNIT+['tests/unit/safe-http.test.ts','-t','per-panel binding']),
 'M14-lookup-mismatch-not-checked-in-create':(A,"""      if (account.nexaRef !== input.clientId) {""","""      if (false as boolean) {""",UNIT+[AD,'-t','createUser']),
}
names=sys.argv[1:] or list(M)
env=dict(os.environ)
env.setdefault('TEST_DATABASE_URL','postgres://nexa:nexa@127.0.0.1:5432/nexa_test_r10c2')
for name in names:
    f,old,new,cmd=M[name]
    p=ROOT+f
    orig=open(p).read()
    h=hashlib.sha256(orig.encode()).hexdigest()
    assert orig.count(old)==1,(name,orig.count(old))
    open(p,'w').write(orig.replace(old,new))
    try:
        r=subprocess.run(['bash','scripts/claude/test-summary.sh']+cmd,cwd=ROOT,capture_output=True,text=True,env=env)
        lines=[l for l in r.stdout.splitlines() if l.startswith('passed=') or ' › ' in l]
        print(f'== {name}: exit={r.returncode}')
        for l in lines[:8]: print('   ',l[:200])
    finally:
        open(p,'w').write(orig)
        assert hashlib.sha256(open(p).read().encode()).hexdigest()==h
print('restored', subprocess.run(['git','status','--short'],cwd=ROOT,capture_output=True,text=True).stdout or 'clean')
