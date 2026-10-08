"""Roadmap E3/E4/E5 mutation driver (docs/refund-audit.md, docs/payment-fees-fx.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
A mutant in packages/contracts rebuilds it before the run and again after the restore, because
the test projects import it from its dist. Integration mutants need the database; point
TEST_DATABASE_URL and DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-payments-financial.py [AMT-02 ...]
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

REP='apps/api/src/modules/commerce/payments/infrastructure/drizzle-refund.repository.ts'
W_PAY=('web','tests/web/payments.test.tsx')

M=[
 # --- E4: the one breakdown --------------------------------------------------------------------
 # A top-up credits the principal, never the fee.
 ('AMT-02',[(AMT,"      confirmed && input.topup && external\n        ? input.principalMinor","      confirmed && input.topup && external\n        ? paid")],U_AMT,'never the fee'),
 # Money counts as received only once confirmed.
 ('AMT-03',[(AMT,"    receivedMinor: confirmed && external ? paid : 0n,","    receivedMinor: external ? paid : 0n,")],U_AMT,'never confirmed'),
 # The server's principal is payments.amount, not the payable: the report and the detail agree.
 ('AMT-04',[(CTL,"    principalMinor: record.amount.amountMinor,\n    customerFee:","    principalMinor: record.customerFee?.payable.amountMinor ?? record.amount.amountMinor,\n    customerFee:")],I_REP,'own money breakdowns'),
 # The page renders the server's payable; it does not add principal and fee.
 ('AMT-05',[(WEB,"          [t('web.payment_customer_fee_payable'), money('c', value.payable)],","          [t('web.payment_customer_fee_payable'), money('c', (BigInt(value.principal) + BigInt(value.customerFee)).toString())],")],W_MON,'computing nothing'),
 # --- PR #247 F1: no second refund answer --------------------------------------------------------
 # The detail grows a principal-based refund figure beside the ledger's answer.
 ('F1-01',[(CTL,"    payable: amounts.payableMinor.toString(),","    payable: amounts.payableMinor.toString(),\n    refundCeiling: amounts.principalMinor.toString(),")],I_REP,'own money breakdowns'),
 # The page draws a ceiling of its own from the principal.
 ('F1-02',[(WEB,"          [t('web.payment_amounts_received'), money('r', value.received)],","          [t('web.payment_amounts_received'), money('r', value.received)],\n          ['سقف بازپرداخت', money('x', value.principal)],")],W_MON,'computing nothing'),
 # --- PR #247 F2: every report line is the sum of the breakdowns ---------------------------------
 # A wallet purchase counted as money received from outside.
 ('F2-01',[(AMT,"  const external = input.method !== 'WALLET';","  const external = true;")],I_REP,'own money breakdowns'),
 # --- PR #247 CX1/F3: the ledger and the write agree on a currency mixture ------------------------
 ('F3-01',[(REF,"        ? 'CURRENCY_MISMATCH'\n        : null);","        ? null\n        : null);")],I_TRU,'names every refusal reason'),
 ('F3-02',[(REP,"THEN 'MIXED' ELSE min(${refunds.currency}) END","THEN min(${refunds.currency}) ELSE min(${refunds.currency}) END")],I_TRU,'names every refusal reason'),
 # --- PR #247 F5: the controller hands the function what it read ---------------------------------
 ('F5-X1',[(CTL,"    topup: record.orderId === null,","    topup: false,")],I_TRU,'credits a confirmed top-up'),
 ('F5-X2',[(CTL,"    receiptCreditMinor: credit === null ? null : credit.amount.amountMinor,","    receiptCreditMinor: null,")],I_TRU,'credits a confirmed top-up'),
 ('F5-X3',[(CTL,"              sourceAt: invoice.fx.sourceAt,","              sourceAt: invoice.fx.fetchedAt,")],I_TRU,'keeps an attempt'),
 ('F5-X4',[(CTL,"      fixedRateMinor: invoice.conversionRateMinor,","      fixedRateMinor: null,")],I_TRU,'fixed rate'),
 # --- E3 / PR #247 F6: the refusal reason, read equals write --------------------------------------
 ('REF-01',[(REF,"      refusalReason: refusal,","      refusalReason: null,")],I_TRU,'names why a payment cannot be refunded'),
 ('REF-02',[(WEB,"                  data.refusalReason === null\n                    ? 'web.refund_unavailable'","                  data.refusalReason !== '__never__'\n                    ? 'web.refund_unavailable'")],W_MON,'by the server’s reason'),
 # The write names a different reason from the one the ledger read.
 ('F6-01',[(REF,"            'This payment cannot be refunded.',\n            { reason: unrefundable },","            'This payment cannot be refunded.',\n            { reason: 'CHANNEL_UNSUPPORTED' },")],I_TRU,'names every refusal reason'),
 # An UNKNOWN purchase operation no longer holds the money.
 ('F6-02',[(REF,"    if (await this.deps.deliveries.purchaseInProgress(scope, order, tx)) {\n      return 'DELIVERY_IN_PROGRESS';","    if (await this.deps.deliveries.purchaseInProgress(scope, order, tx)) {\n      return null;")],I_TRU,'names every refusal reason'),
 # --- PR #247 NITs -----------------------------------------------------------------------------
 # The rate is shown raw instead of grouped.
 ('NIT-01',[(WEB,"<Num key=\"v\" value={formatDecimalText(value.rate)} />","<Num key=\"v\" value={value.rate} />")],W_MON,'names the rate'),
 # The fee is drawn on a second card again.
 ('NIT-02',[(WEB,"                  <AmountsCard value={row.amounts} />","                  <AmountsCard value={row.amounts} />\n                  <AmountsCard value={row.amounts} />")],W_PAY,'no fee card elsewhere'),
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
  originals={}
  # try/finally (review of PR #247, CX2): a failed build, an exception or an interrupt still
  # restores every file this mutant touched and rebuilds every package it dirtied.
  try:
    ok=True
    for f,a,b in edits:
      cur=open(f,encoding='utf-8').read()
      originals.setdefault(f,cur)
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
  finally:
    for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
    for p in sorted({PKG[p] for p in PKG for f in originals if f.startswith(p)}):
      build_package(p)
print(f'{killed} of {ran} killed',flush=True)
