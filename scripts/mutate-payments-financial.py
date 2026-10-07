"""Roadmap E3/E4/E5 mutation driver (docs/refund-audit.md, docs/payment-fees-fx.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
A mutant in packages/contracts rebuilds it before the run and again after the restore, because
the test projects import it from its dist. Integration mutants need the database; point
TEST_DATABASE_URL and DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-payments-financial.py [AMT-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

PKG={'packages/i18n/':'@nexa/i18n','packages/contracts/':'@nexa/contracts'}
AMT='packages/contracts/src/payment-amounts.ts'
PRV='packages/contracts/src/gateway-invoices.ts'
CTL='apps/api/src/surfaces/web/payments.controller.ts'
REF='apps/api/src/modules/commerce/payments/application/refund.service.ts'
WEB='apps/web/src/pages/payments.tsx'
U_AMT=('unit','tests/unit/payment-amounts.test.ts')
U_PRV=('unit','tests/unit/rate-provenance.test.ts')
I_REP=('integration','tests/integration/financial-reports.test.ts')
I_TRU=('integration','tests/integration/payment-money-truth.test.ts')
W_MON=('web','tests/web/payment-money.test.tsx')

M=[
 # --- E4: the one breakdown --------------------------------------------------------------------
 # The gateway fee is never refundable: the ceiling is the principal.
 ('AMT-01',[(AMT,"    refundCeilingMinor: confirmed ? input.principalMinor : 0n,","    refundCeilingMinor: confirmed ? paid : 0n,")],U_AMT,'never refundable'),
 # A top-up credits the principal, never the fee.
 ('AMT-02',[(AMT,"      confirmed && input.topup && external\n        ? input.principalMinor","      confirmed && input.topup && external\n        ? paid")],U_AMT,'never the fee'),
 # Money counts as received only once confirmed.
 ('AMT-03',[(AMT,"    receivedMinor: confirmed && external ? paid : 0n,","    receivedMinor: external ? paid : 0n,")],U_AMT,'never confirmed'),
 # The server's principal is payments.amount, not the payable: the report and the detail agree.
 ('AMT-04',[(CTL,"    principalMinor: record.amount.amountMinor,\n    customerFee:","    principalMinor: record.customerFee?.payable.amountMinor ?? record.amount.amountMinor,\n    customerFee:")],I_REP,'own money breakdowns'),
 # The page renders the server's figures; it does not add principal and fee.
 ('AMT-05',[(WEB,"          [t('web.payment_amounts_customer_paid'), money('c', value.customerPaid)],","          [t('web.payment_amounts_customer_paid'), money('c', (BigInt(value.principal) + BigInt(value.customerFee)).toString())],")],W_MON,'computing nothing'),
 # --- E3: the refusal reason -------------------------------------------------------------------
 ('REF-01',[(REF,"      refusalReason: refusal,","      refusalReason: null,")],I_TRU,'names why a payment cannot be refunded'),
 ('REF-02',[(WEB,"                  data.refusalReason === null\n                    ? 'web.refund_unavailable'","                  data.refusalReason !== '__never__'\n                    ? 'web.refund_unavailable'")],W_MON,'by the server’s reason'),
 # --- E5: the provenance -----------------------------------------------------------------------
 # A central-rate attempt with no snapshot reports no rate, never the fixed one.
 ('PRV-01',[(PRV,"    if (input.fx === null)\n      return { authority: 'MARKET', policy: input.policy, rate: null, ...none };","    if (input.fx === null)\n      return { authority: 'MARKET', policy: input.policy, rate: input.fixedRateMinor?.toString() ?? null, ...none };")],U_PRV,'fails closed'),
 # The rate is frozen at the attempt's creation, not read as of now.
 ('PRV-02',[(PRV,"  const frozenAt = input.createdAt.toISOString();","  const frozenAt = new Date().toISOString();")],I_TRU,'keeps an attempt'),
]

def build_package(name):
  r=subprocess.run(['pnpm','--filter',name,'build'],capture_output=True,text=True)
  if r.returncode!=0: print(r.stdout+r.stderr,flush=True)
  return r.returncode==0

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
  pkgs=sorted({PKG[p] for p in PKG for f in originals if f.startswith(p)})
  if ok and not all(build_package(p) for p in pkgs):
    print(mid,'DOES NOT COMPILE',flush=True); ok=False
  if ok:
    ran+=1
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    ran_any=any('passed' in l or 'failed' in l for l in summ)
    # KILLED only when a named test FAILED: a non-zero exit with no × line is a broken run.
    dead=r.returncode!=0 and ran_any and len(failed)>0
    if dead: killed+=1
    print(mid,'KILLED' if dead else 'SURVIVED',summ,failed[:2],flush=True)
  for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
  for p in pkgs: build_package(p)
print(f'{killed} of {ran} killed',flush=True)
