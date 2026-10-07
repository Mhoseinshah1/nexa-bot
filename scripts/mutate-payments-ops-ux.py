"""Roadmap E1/E2/E6 mutation driver (docs/payments-under-review-ux.md §4).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
A mutant in packages/contracts or packages/i18n rebuilds that package before the run and again
after the restore, because the test projects import them from their dist.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL and DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-payments-ops-ux.py [SIT-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

PKG={'packages/i18n/':'@nexa/i18n','packages/contracts/':'@nexa/contracts'}
SIT='packages/contracts/src/payment-situations.ts'
SQL='apps/api/src/modules/commerce/payments/infrastructure/payment-ops-queue-sql.ts'
WEB='apps/web/src/pages/payments.tsx'
SVC='apps/api/src/modules/commerce/payments/application/receipt.service.ts'
PAY='apps/api/src/modules/commerce/payments/application/payment.service.ts'
BOT='apps/api/src/surfaces/telegram/bot-runtime.ts'
LANE='apps/api/src/modules/commerce/messaging/application/customer-notification.service.ts'
U_SIT=('unit','tests/unit/payment-situations.test.ts')
U_WIN=('unit','tests/unit/receipt-window.test.ts')
I_SIT=('integration','tests/integration/payment-situations.test.ts')
I_TG=('integration','tests/integration/telegram-payment-flow.test.ts')
I_LANE=('integration','tests/integration/customer-notifications.test.ts')
W_SIT=('web','tests/web/payment-situations.test.tsx')

M=[
 # --- E1: the classifier ---------------------------------------------------------------------
 # What the provider said after the end outranks how the attempt ended.
 ('SIT-01',[(SIT,"      if (inQueue('LATE_COMPLETION')) return 'LATE_COMPLETION';\n      if (inQueue('PARTIAL')) return 'PARTIAL';\n      if (facts.state === 'EXPIRED') return 'EXPIRED';","      if (inQueue('PARTIAL')) return 'PARTIAL';\n      if (facts.state === 'EXPIRED') return 'EXPIRED';")],U_SIT,'above how the attempt ended'),
 # A credited receipt is not a rejection.
 ('SIT-02',[(SIT,"      if (facts.receiptDisposition === 'CREDITED_TO_WALLET') return 'CREDITED_TO_WALLET';\n","")],U_SIT,'credited receipt apart'),
 # An UNKNOWN tells the customer not to pay again.
 ('SIT-03',[(SIT,"  OUTCOME_UNKNOWN: 'WAIT_DO_NOT_PAY_AGAIN',","  OUTCOME_UNKNOWN: 'MAY_PAY_AGAIN',")],U_SIT,'never shows an UNKNOWN'),
 # A refund only where REFUND_METHOD_SUPPORT has a channel.
 ('SIT-04',[(SIT,"    REFUND_METHOD_SUPPORT[facts.method].supported && !facts.topup && facts.state === 'CONFIRMED';","    !facts.topup && facts.state === 'CONFIRMED';")],U_SIT,'offers a refund only'),
 # Reconciliation only on an UNKNOWN gateway payment.
 ('SIT-05',[(SIT,"  const reconcilable = facts.state === 'UNKNOWN' && facts.method === 'GATEWAY';","  const reconcilable = facts.method === 'GATEWAY';")],U_SIT,'offers reconciliation only'),
 # An open refund is its own situation, ahead of a completed one.
 ('SIT-06',[(SIT,"      if (facts.refundOpen) return 'REFUND_IN_PROGRESS';\n","")],I_SIT,'derives each arm'),
 # The work queue drains: late money on an ended attempt is not work.
 ('SIT-07',[(SIT,"    state === 'UNKNOWN' || situation === 'CUSTOMER_SIGNALLED' || situation === 'REFUND_IN_PROGRESS'","    state === 'UNKNOWN' ||\n    situation === 'CUSTOMER_SIGNALLED' ||\n    situation === 'REFUND_IN_PROGRESS' ||\n    situation === 'LATE_COMPLETION'")],U_SIT,'so the queue drains'),
 # --- E2: the NEEDS_ACTION facet in SQL --------------------------------------------------------
 ('SQL-01',[(SQL,"      AND ${payments.providerReviewUntil} IS NULL\n      AND NOT ${paymentOpsQueueCondition('PARTIAL')})","      AND NOT ${paymentOpsQueueCondition('PARTIAL')})\n    OR (${payments.state} = 'PENDING' AND ${payments.providerReviewUntil} IS NOT NULL)")],I_SIT,'derives each arm'),
 ('SQL-02',[(SQL,"    OR (${payments.state} = 'CONFIRMED' AND ${openRefundCondition()})\n  )`;","    OR (${payments.state} = 'CONFIRMED' AND ${openRefundCondition()})\n    OR (${payments.state} IN ('FAILED', 'EXPIRED') AND ${paymentOpsQueueCondition('LATE_COMPLETION')})\n  )`;")],I_SIT,'derives each arm'),
 ('SQL-03',[(SQL,"       AND r.state IN ('REQUESTED', 'AWAITING_EXTERNAL'))`;","       AND r.state IN ('REQUESTED', 'AWAITING_EXTERNAL', 'FAILED'))`;")],I_SIT,'moves a payment out of NEEDS_ACTION'),
 # The situation is read behind payments.view.
 ('SQL-04',[(PAY,"    dispositions: ReadonlyMap<PaymentId, ReceiptDisposition>,\n  ): Promise<ReadonlyMap<PaymentId, PaymentSituationRead>> {\n    await this.deps.guard.check(scope, actor, PAYMENT_VIEW_PERMISSION);\n","    dispositions: ReadonlyMap<PaymentId, ReceiptDisposition>,\n  ): Promise<ReadonlyMap<PaymentId, PaymentSituationRead>> {\n")],I_SIT,'without payments.view'),
 # --- E1/E2 on the Web Admin ------------------------------------------------------------------
 ('WEB-01',[(WEB,"const QUEUE_ORDER: readonly PaymentOpsQueue[] = [\n  'NEEDS_ACTION',\n  ...PAYMENT_OPS_QUEUES.filter((one) => one !== 'NEEDS_ACTION'),\n];","const QUEUE_ORDER: readonly PaymentOpsQueue[] = PAYMENT_OPS_QUEUES;")],W_SIT,'leads the chips'),
 ('WEB-02',[(WEB,"                  <SituationCard value={row.situation} />\n","")],W_SIT,'says on the detail'),
 ('WEB-03',[(WEB,"      render: (row) => <SituationBadge value={row.situation} />,","      render: (row) => <SituationBadge value={row.state === 'CONFIRMED' ? { situation: 'CONFIRMED', money: 'YES', customer: 'NOTHING', actions: [], needsAction: false } : row.situation} />,")],W_SIT,'never classifies'),
 # --- E6: the receipt flow --------------------------------------------------------------------
 ('E6-01',[(BOT,"      buttons: [\n        { ...inlineLabel('payment.sent'), data: `${PAY_SENT_CALLBACK_PREFIX}${paymentId}` },\n      ],","      buttons: [],")],I_TG,'window closed'),
 ('E6-02',[(SVC,"            (expiredFor.expiresAt === null || expiredFor.expiresAt.getTime() > now.getTime());","            true;")],I_TG,'can no longer take one'),
 ('E6-03',[(BOT,"        values: await this.receiptInvoiceFinalValues(scope, actor, customerId, paymentId),","        values: {},")],I_TG,'ends it button-less and sends ONE new message'),
 ('E6-04',[(BOT,"          templateKey: RECEIPT_INVOICE_FINAL_KEY,\n          values,\n          buttons: [],","          templateKey: RECEIPT_INVOICE_FINAL_KEY,\n          values: {},\n          buttons: [],")],I_TG,'receipt beat the tap'),
 ('E6-05',[(LANE,"    if (row.kind === 'PAYMENT_EXPIRED' || row.kind === 'PAYMENT_TRANSFER_RECORDED') {","    if (row.kind === 'PAYMENT_TRANSFER_RECORDED') {")],I_LANE,'quotes the payment'),
 ('E6-06',[(LANE,"      return reference === null\n        ? { reason: reason ?? '\\u2014' }\n        : { reason: reason ?? '\\u2014', reference };","      return { reason: reason ?? '\\u2014' };")],I_LANE,'quotes the payment'),
 ('E6-07',[(PAY,"  return Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 60_000));","  return Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 60_000));")],U_WIN,'rounds a part-minute UP'),
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
