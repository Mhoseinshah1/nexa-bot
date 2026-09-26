"""WP19 mutation driver (docs/wp19-falsification.md).

Reverts one rule at a time, runs the named integration tests, and restores the file with
`git checkout`. Needs TEST_DATABASE_URL pointing at a database nothing else is using, and
a clean tree. Usage: python3 scripts/mutate-wp19.py [W19-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if 'TEST_DATABASE_URL' not in os.environ:
  sys.exit('TEST_DATABASE_URL is required')
if subprocess.run(['git','diff','--quiet','--','apps']).returncode != 0:
  sys.exit('apps/ has uncommitted changes; a mutation restore would discard them')
S='apps/api/src/modules/commerce/payments/application/service-refund-request.service.ts'
R='apps/api/src/modules/commerce/payments/infrastructure/drizzle-service-refund-request.repository.ts'
RF='apps/api/src/modules/commerce/payments/application/refund.service.ts'
SV='apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository.ts'
FL='apps/api/src/modules/commerce/payments/application/financial-log.consumer.ts'
PC='apps/api/src/modules/commerce/payments/application/service-refund-push.consumer.ts'
IT='tests/integration/service-refund-requests.test.ts'
M=[
 ('W19-01',[(S,"if (succeeded && item.serviceState !== 'TERMINATED') {","if (false && succeeded && item.serviceState !== 'TERMINATED') {")],'did not move'),
 ('W19-02',[(R,"inArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES]),","inArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES, 'UNKNOWN' as never]),")],'UNKNOWN'),
 ('W19-03',[(S,"const succeeded = item.operationState === 'SUCCEEDED';","const succeeded = item.operationState !== 'ABANDONED';")],'definitively fails'),
 ('W19-04',[(S,"""    for (const permission of SERVICE_REFUND_DECIDE_PERMISSIONS) {
      await this.deps.guard.check(scope, actor, permission);
    }""","""    for (const permission of SERVICE_REFUND_DECIDE_PERMISSIONS) {
      if (permission !== 'services.terminate') await this.deps.guard.check(scope, actor, permission);
    }"""),(S,"""        await this.assertScopeActive(scope, tx);
        await this.deps.guard.check(scope, actor, 'services.terminate', tx);
        const request = await this.deps.repository.findByIdForUpdate(scope, input.requestId, tx);
        if (request === null) throw this.notFound();
        if (request.state !== 'OPEN') {
          if (
            request.decidedByAdminId""","""        await this.assertScopeActive(scope, tx);
        const request = await this.deps.repository.findByIdForUpdate(scope, input.requestId, tx);
        if (request === null) throw this.notFound();
        if (request.state !== 'OPEN') {
          if (
            request.decidedByAdminId""")],'may refund but not delete'),
 ('W19-05',[(S,"""        if (request.state !== 'OPEN') {
          if (
            request.decidedByAdminId === adminId &&""","""        if (false as boolean) {
          if (
            request.decidedByAdminId === adminId &&""")],'administrators approve together|approval and a rejection'),
 ('W19-06',[(S,"        if (input.amountMinor <= 0n) {\n          throw errors.validation(","        if (input.amountMinor < 0n) {\n          throw errors.validation(")],'and zero'),
 ('W19-07',[(RF,"""    if (
      !refundFitsWithin({
        paidMinor: payment.amount.amountMinor,
        consumedMinor: consumption.consumedMinor,
        requestedMinor: input.amountMinor,
      })
    ) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
        'That is more than this payment has left to refund.',
        {
          refundableMinor: refundableMinor(
            payment.amount.amountMinor,
            consumption.consumedMinor,
          ).toString(),
          currency: payment.amount.currency,
        },
      );
    }

    const now = this.deps.clock.now();
    const created = await this.deps.repository.create(
      scope,
      {
        id: this.deps.ids.uuid() as RefundId,
        paymentId: payment.id,
        customerId: payment.customerId,
        orderId: payment.orderId,
        state: 'REQUESTED',
        channel: SERVICE_REFUND_REQUEST_CHANNEL,""","""    const now = this.deps.clock.now();
    const created = await this.deps.repository.create(
      scope,
      {
        id: this.deps.ids.uuid() as RefundId,
        paymentId: payment.id,
        customerId: payment.customerId,
        orderId: payment.orderId,
        state: 'REQUESTED',
        channel: SERVICE_REFUND_REQUEST_CHANNEL,""")],'above what is left|operator’s own refund'),
 ('W19-08',[(RF,"function refuseWorkflowRefund(refund: RefundRecord): void {\n","function refuseWorkflowRefund(refund: RefundRecord): void {\n  if (refund !== null) return;\n")],'by hand'),
 ('W19-09',[(RF,"      { notifyCustomer: false },","      { notifyCustomer: true },")],'exactly once'),
 ('W19-10',[(SV,"""function notRefundedAway(): SQL {
  return sql`NOT EXISTS (""","""function notRefundedAway(): SQL {
  return sql`TRUE OR NOT EXISTS (""")],'exactly once'),
 ('W19-11',[(S,"        if (existing !== null) return { outcome: 'ALREADY_OPEN', request: existing };\n","")],'however concurrently'),
 ('W19-12',[(S,"const eligibility = await this.eligibilityOf(scope, service, { checkFlag: true }, tx);","const eligibility = await this.eligibilityOf(scope, service, { checkFlag: false }, tx);"),(S,"    if (!(await this.deps.features.isEnabled(scope, FLAG))) return 'UNAVAILABLE';\n","")],'switch is off'),
 ('W19-13',[(S,"if (length < SERVICE_REFUND_REASON_MIN_LENGTH || length > SERVICE_REFUND_REASON_MAX_LENGTH) {","if (length < 1 || length > SERVICE_REFUND_REASON_MAX_LENGTH) {")],'outside 3'),
 ('W19-14',[(S,"""        if (request.state !== 'OPEN') {
          if (request.state === 'REJECTED' && request.rejectionReason === reason) return request;
          throw this.stateInvalid(request.state);
        }""","""        if (request.state !== 'OPEN' && request.state === 'REJECTED') {
          if (request.state === 'REJECTED' && request.rejectionReason === reason) return request;
          throw this.stateInvalid(request.state);
        }""")],'approval and a rejection'),
 ('W19-15',[(FL,"...(request.approvedAmount === null ? {} : { amount: request.approvedAmount }),","...(request.approvedAmount === null ? { amount: request.principal } : { amount: request.approvedAmount }),")],'financial log'),
 ('W19-16',[(PC,"return permissions.has('refunds.issue') && permissions.has('services.terminate');","return permissions.has('refunds.issue');")],'review card per administrator'),
 ('W19-17',[(S,"if (service === null || service.customerId !== customerId) {","if (service === null) {")],'another customer'),
 ('W19-18',[(S,"{ idempotencyKey: `service-refund:${request.id}` },","{ idempotencyKey: `service-refund:${request.id}:${this.deps.ids.uuid()}` },")],'administrators approve together|reject replay|rejects once'),
]

M+=[
 ('W19-05b',[(S,"""        if (request.state !== 'OPEN') {
          if (
            request.decidedByAdminId === adminId &&""","""        if (false as boolean) {
          if (
            request.decidedByAdminId === adminId &&"""),(R,"""        decidedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),
          eq(serviceRefundRequests.state, 'OPEN'),""","""        decidedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),""")],'administrators approve together|approval and a rejection'),
 ('W19-06b',[(S,"        if (input.amountMinor <= 0n) {\n          throw errors.validation(","        if (input.amountMinor < 0n) {\n          throw errors.validation("),(RF,"""    if (
      !refundFitsWithin({
        paidMinor: payment.amount.amountMinor,
        consumedMinor: consumption.consumedMinor,
        requestedMinor: input.amountMinor,
      })
    ) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
        'That is more than this payment has left to refund.',""","""    if (
      input.amountMinor !== 0n && !refundFitsWithin({
        paidMinor: payment.amount.amountMinor,
        consumedMinor: consumption.consumedMinor,
        requestedMinor: input.amountMinor,
      })
    ) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
        'That is more than this payment has left to refund.',""")],'and zero'),
 ('W19-11b',[(S,"        if (existing !== null) return { outcome: 'ALREADY_OPEN', request: existing };\n",""),(R,"""      .onConflictDoNothing({
        target: [serviceRefundRequests.tenantId, serviceRefundRequests.serviceId],
        where: sql`state IN ('OPEN', 'EXECUTING')`,
      })
      .returning();""","""      .returning();""")],'however concurrently'),
]
only=sys.argv[1:] 
for mid,edits,filt in M:
  if only and mid not in only: continue
  files=set()
  ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a)); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  if ok:
    r=subprocess.run(['pnpm','exec','vitest','run','--project','integration',IT,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:4],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
