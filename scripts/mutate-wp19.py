"""WP19 mutation driver (docs/wp19-falsification.md).

Reverts one rule at a time, runs the named integration tests, and restores the file with
`git checkout`. Needs TEST_DATABASE_URL pointing at a database nothing else is using, and
a clean tree. Usage: python3 scripts/mutate-wp19.py [W19-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if 'TEST_DATABASE_URL' not in os.environ:
  sys.exit('TEST_DATABASE_URL is required')
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')
S='apps/api/src/modules/commerce/payments/application/service-refund-request.service.ts'
R='apps/api/src/modules/commerce/payments/infrastructure/drizzle-service-refund-request.repository.ts'
RF='apps/api/src/modules/commerce/payments/application/refund.service.ts'
SV='apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository.ts'
FL='apps/api/src/modules/commerce/payments/application/financial-log.consumer.ts'
PC='apps/api/src/modules/commerce/payments/application/service-refund-push.consumer.ts'
IT='tests/integration/service-refund-requests.test.ts'
DS='apps/api/src/modules/commerce/payments/application/service-refund-decision.service.ts'
C='apps/api/src/surfaces/web/service-refund-requests.controller.ts'
PG='apps/web/src/pages/service-refund-requests.tsx'
EV='packages/contracts/src/events.ts'
PV='apps/api/src/modules/commerce/provisioning/application/provisioning.service.ts'
M=[
 ('W19-01',[(S,"if (succeeded && item.serviceState !== 'TERMINATED') {","if (false && succeeded && item.serviceState !== 'TERMINATED') {"),(R,"          or(\n","          or(\n            sql`true`,\n")],'did not move'),
 ('W19-02',[(R,"inArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES]),","inArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES, 'UNKNOWN' as never]),")],'UNKNOWN'),
 ('W19-02b',[(R,"inArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES]),","inArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES, 'UNKNOWN' as never]),"),(R,"inArray(provisioningOperations.state, ['FAILED', 'ABANDONED']),","inArray(provisioningOperations.state, ['FAILED', 'ABANDONED', 'UNKNOWN']),")],'UNKNOWN'),
 ('W19-03',[(S,"const succeeded = item.operationState === 'SUCCEEDED';","const succeeded = item.operationState !== 'ABANDONED';")],'definitively fails'),
 ('W19-04',[(S,"""    for (const permission of SERVICE_REFUND_DECIDE_PERMISSIONS) {
      await this.deps.guard.check(scope, actor, permission);
    }""","""    for (const permission of SERVICE_REFUND_DECIDE_PERMISSIONS) {
      if (permission !== 'services.terminate') await this.deps.guard.check(scope, actor, permission);
    }"""),(S,"""        await this.assertScopeActive(scope, tx);
        await this.deps.guard.check(scope, actor, 'services.terminate', tx);
        const request = await this.deps.repository.findByIdForUpdate(
          scope,
          requestIdOf(input.requestId),
          tx,
        );
        if (request === null) throw this.notFound();
        if (request.state !== 'OPEN') {
          if (
            request.decidedByAdminId""","""        await this.assertScopeActive(scope, tx);
        const request = await this.deps.repository.findByIdForUpdate(
          scope,
          requestIdOf(input.requestId),
          tx,
        );
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
 ('W19-08',[(RF,"  ): Promise<void> {\n    if (await this.deps.repository.isServiceRefundReservation(scope, refund.id, tx)) {","  ): Promise<void> {\n    if (refund !== null) return;\n    if (await this.deps.repository.isServiceRefundReservation(scope, refund.id, tx)) {")],'by hand'),
 ('W19-09',[(RF,"      { notifyCustomer: false },","      { notifyCustomer: true },")],'exactly once'),
 ('W19-10',[(SV,"""function notRefundedAway(): SQL {
  return sql`NOT EXISTS (""","""function notRefundedAway(): SQL {
  return sql`TRUE OR NOT EXISTS (""")],'exactly once'),
 ('W19-11',[(S,"        if (existing !== null) return { outcome: 'ALREADY_OPEN', request: existing };\n","")],'however concurrently'),
 ('W19-12',[(S,"const eligibility = await this.eligibilityOf(scope, service, { checkFlag: true }, tx);","const eligibility = await this.eligibilityOf(scope, service, { checkFlag: false }, tx);"),(S,"    if (!(await this.deps.features.isEnabled(scope, FLAG))) return 'UNAVAILABLE';\n","")],'switch is off'),
 ('W19-13',[(S,"if (length < SERVICE_REFUND_REASON_MIN_LENGTH || length > SERVICE_REFUND_REASON_MAX_LENGTH) {","if (length < 1 || length > SERVICE_REFUND_REASON_MAX_LENGTH) {")],'outside 3'),
 ('W19-14',[(S,"""    if (request.state !== 'OPEN') {
      if (request.state === 'REJECTED' && request.rejectionReason === reason) return request;
      throw this.stateInvalid(request.state);
    }""","""    if (request.state !== 'OPEN' && request.state === 'REJECTED') {
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
 # Codex review of #83
 ('W19-14b',[(S,"""    if (request.state !== 'OPEN') {
      if (request.state === 'REJECTED' && request.rejectionReason === reason) return request;
      throw this.stateInvalid(request.state);
    }""","""    if (request.state !== 'OPEN' && request.state === 'REJECTED') {
      if (request.state === 'REJECTED' && request.rejectionReason === reason) return request;
      throw this.stateInvalid(request.state);
    }"""),(R,"""        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),
          eq(serviceRefundRequests.state, 'OPEN'),""","""        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),""")],'approval and a rejection'),
 ('W19-14c',[(S,"""    if (request.state !== 'OPEN') {
      if (request.state === 'REJECTED' && request.rejectionReason === reason) return request;
      throw this.stateInvalid(request.state);
    }""","""    if (request.state !== 'OPEN' && request.state === 'REJECTED') {
      if (request.state === 'REJECTED' && request.rejectionReason === reason) return request;
      throw this.stateInvalid(request.state);
    }"""),(R,"""        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),
          eq(serviceRefundRequests.state, 'OPEN'),""","""        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),""")],'approval and a rejection',None,("ALTER TABLE service_refund_requests DROP CONSTRAINT service_refund_requests_rejected_check","TRUNCATE service_refund_requests CASCADE; ALTER TABLE service_refund_requests ADD CONSTRAINT service_refund_requests_rejected_check CHECK (state <> 'REJECTED' OR (rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) BETWEEN 1 AND 500 AND decided_by_admin_id IS NOT NULL AND decided_at IS NOT NULL AND approved_amount_minor IS NULL AND refund_id IS NULL AND operation_id IS NULL))")),
 ('W19-24',[(R,"          or(\n","          or(\n            sql`true`,\n")],'fill the batch'),
 ('W19-25',[(RF,"    if (await this.deps.repository.isServiceRefundReservation(scope, refund.id, tx)) {","    if (refund.reason === 'SERVICE_REFUND_REQUEST') {")],'reads like a request'),
 ('W19-26',[(S,"  ): Promise<ServiceRefundReview> {\n    await this.checkDecide(scope, actor);\n    const request = await this.requireRequest(scope, requestId);","  ): Promise<ServiceRefundReview> {\n    await this.deps.guard.check(scope, actor, SERVICE_REFUND_VIEW_PERMISSION);\n    const request = await this.requireRequest(scope, requestId);")],'exactly the two decision keys'),
 ('W19-27',[(DS,"      if (request.state !== 'EXECUTING') return { outcome: 'CLOSED' };\n","")],'as decided, not as started'),
 ('W19-22b',[(RF,"      if ((await this.deps.wallet.findByReference(scope, `${refundId}:refund`, tx)) !== null) {\n        return before;\n      }","      return before;"),(R,"              eq(refunds.state, 'REQUESTED'),\n","")],'closed elsewhere'),
 ('W19-23',[(S,"        continue;\n      }\n      if (moved) decided += 1;","        throw error;\n      }\n      if (moved) decided += 1;")],'fails inside its own settlement'),

 # Second Codex review of #83. W19-28 (reject before the prompt closed) is superseded by
 # W19-32..33: that order was what let a cancelled prompt still reject.
 ('W19-30',[(S,"          await this.deps.services.lockForUpdate(scope, request.serviceId, tx),","          await this.deps.services.findById(scope, request.serviceId, tx),")],'ends while the approval waits'),
 ('W19-31',[(S,"""      await this.assertExecutable(
        scope,
        request,
        await this.deps.services.findById(scope, request.serviceId, tx),
        tx,
      );
""","")],'refuses to preview'),
 ('W19-32',[(DS,"""        const rejected = await this.deps.requests.rejectWithin(
          scope,
          actor,
          { requestId, reason },
          tx,
        );""","""        const rejected = await (
          this.deps.requests as unknown as { reject: (...args: unknown[]) => Promise<never> }
        ).reject(scope, actor, { requestId, reason });""")],'in one transaction'),
 ('W19-33',[(DS,"        if (capture === null || capture.closedAt !== null) return null;","        if (capture === null) return null;")],'prompt was cancelled'),
 ('W19-34',[(S,"  const parsed = uuidV7Schema.safeParse(candidate);\n  if (!parsed.success) {","  const parsed = { success: true as const, data: candidate };\n  if (!parsed.success) {")],'malformed request id'),
 ('W19-35',[(C,"""    const approved = await this.container.serviceRefundRequests.approve(scope, actor, {
      requestId: uuidV7Schema.parse(requestId),""","""    const approved = await this.container.serviceRefundRequests.approve(scope, actor, {
      requestId,""")],'malformed request id'),
 ('W19-36',[(C,"""    const rejected = await this.container.serviceRefundRequests.reject(scope, actor, {
      requestId: uuidV7Schema.parse(requestId),""","""    const rejected = await this.container.serviceRefundRequests.reject(scope, actor, {
      requestId,""")],'malformed request id'),
 ('W19-37',[(C,"      serviceId: uuidV7Schema.parse(serviceId),","      serviceId,")],'malformed request id'),
 ('W19-38',[(R,"          filter.before === undefined\n","          true\n")],'pages every request'),
 ('W19-39',[(C,"        items.length > limit && last !== undefined","        false && last !== undefined")],'pages every request'),
 ('W19-40',[(PG,"    if (page.nextCursor === null) return rows;","    return rows;")],'follows the server',('web','tests/web/service-refund-requests.test.tsx')),
 # Third Codex review of #83.
 ('W19-41',[(S,"""  ): Promise<(ServiceRefundRequestListItem & { readonly remaining: Money }) | null> {
    await this.checkDecide(scope, actor);""","""  ): Promise<(ServiceRefundRequestListItem & { readonly remaining: Money }) | null> {
    await this.deps.guard.check(scope, actor, SERVICE_REFUND_VIEW_PERMISSION);""")],'two decision keys alone'),
 ('W19-42',[(DS,"""      await this.mutate(scope, actor, denial, async (tx) => {
        await this.deps.captures.retireConfirmed(scope, captureId, tx);
      });
""","")],'retires a confirmation'),
 ('W19-43',[(DS,"""      const refused = await this.refusalOf(scope, actor, requestId, error);
      await this.closeIfOpen(scope, actor, waiting, 'SUPERSEDED');
      return refused.outcome""","""      await this.closeIfOpen(scope, actor, waiting, 'SUPERSEDED');
      const refused = await this.refusalOf(scope, actor, requestId, error);
      return refused.outcome""")],'keeps the reason prompt'),
 ('W19-44',[(S,"    const service = await this.deps.services.lockForUpdate(scope, parsed.data, tx);","    const service = await this.deps.services.findById(scope, parsed.data, tx);")],'ends while the filing waits'),
 ('W19-45',[(S,"""        if (replayed !== null) {
          if (replayed.serviceId""","""        if (replayed !== null && (false as boolean)) {
          if (replayed.serviceId""")],'redelivered filing'),
 ('W19-46',[(RF,"""      tx,
    );
    return after;
  }

  // -------------------------------------------------------------------------

  /**
   * One append-only ledger entry""","""      tx,
    );
    await this.announce(actor, after, tx, { outcome: 'FAILED', cause: 'OPERATOR_FAILED' });
    return after;
  }

  // -------------------------------------------------------------------------

  /**
   * One append-only ledger entry""")],'definitively fails'),
 ('W19-47',[(EV,"cause: z.enum(['OPERATOR_FAILED', 'SUPERSEDED']),","cause: z.enum(['OPERATOR_FAILED', 'SUPERSEDED', 'DELETION_FAILED']),")],'two values the release before WP19',('unit','tests/unit/contracts-invariants.test.ts')),
 ('W19-48',[(PV,"if (type === 'TERMINATE') {\n      const locked = await this.deps.services.lockForUpdate(scope, service.id, tx);","if (type === 'TERMINATE') {\n      const locked = service;")],'races an approval|ended while it waited'),
 ('W19-49',[(PV,"if (locked === null || !OPERATION_LEGAL_FROM.TERMINATE.includes(locked.state)) {","if (locked === null) {")],'ended while it waited'),
 ('W19-50',[(PV,"""      service.panelId,
      'TERMINATE',
      tx,
    );""","""      service.panelId,
      'TERMINATE',
    );""")],'inside the approval'),
 ('W19-51',[(S,"""        const eligibility = await this.eligibilityOf(scope, service, { checkFlag: true }, tx);
        if (!eligibility.eligible) return refuse(eligibility.reason);""","""        const eligibility = found;
        if (!eligibility.eligible) return refuse(eligibility.reason);""")],'refunded in full while the filing'),
 ('W19-52',[(DS,"""      if (
        !isNexaError(error) ||
        (error.code !== COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND &&
          error.code !== COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_STATE_INVALID)
      ) {
        throw error;
      }""","""      void error;""")],'reading its request fails'),
 ('W19-53',[(DS,"""    if (replayed !== null) {
      const entered = await this.enteredAgain(scope, actor, replayed.result.captureId);""","""    if (replayed !== null && (false as boolean)) {
      const entered = await this.enteredAgain(scope, actor, replayed.result.captureId);""")],'redelivered amount'),
 ('W19-54',[(S,"return key === undefined ? null : { key, hash: hashRequest(body) };","void hashRequest;\n    return key === undefined ? null : null;")],'idempotency key \\(Codex'),
]
only=sys.argv[1:] 
for entry in M:
  mid,edits,filt=entry[0],entry[1],entry[2]
  project,test=entry[3] if len(entry)>3 and entry[3] is not None else ('integration',IT)
  # A database-level guard is lifted for the row and restored after it: (setup, teardown).
  db=entry[4] if len(entry)>4 else None
  if only and mid not in only: continue
  files=set()
  ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a)); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  if ok and db is not None:
    subprocess.run(['psql',os.environ['TEST_DATABASE_URL'],'-qc',db[0]],check=True)
  # Tests read @nexa/contracts from its build, so a contract mutation is built in and out.
  contracts=any(f.startswith('packages/contracts/') for f in files)
  if ok and contracts:
    subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True,check=True)
  if ok:
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:4],flush=True)
  if ok and db is not None:
    subprocess.run(['psql',os.environ['TEST_DATABASE_URL'],'-qc',db[1]],check=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  if contracts:
    subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True,check=True)
