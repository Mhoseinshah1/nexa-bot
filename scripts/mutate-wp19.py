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
SVP='apps/web/src/pages/services.tsx'
APP='apps/web/src/app.tsx'
BR='apps/api/src/surfaces/telegram/bot-runtime.ts'
CL='apps/web/src/api/client.ts'
H='packages/contracts/src/http.ts'
CI='tests/unit/contracts-invariants.test.ts'
RFR='apps/api/src/modules/commerce/payments/infrastructure/drizzle-refund.repository.ts'
PS='apps/api/src/modules/commerce/payments/application/service-refund-push.service.ts'
CCS='apps/api/src/modules/commerce/customers/application/customer-capture.service.ts'
PL='apps/api/src/modules/commerce/provisioning/application/provisioner-loop.ts'
LL='tests/unit/provisioner-loop-lanes.test.ts'
RPL='apps/api/src/modules/commerce/payments/application/receipt-review-push-loop.ts'
RL='tests/unit/receipt-review-push-loop-lanes.test.ts'
M=[
 ('W19-01',[(S,"if (succeeded && item.serviceState !== 'TERMINATED') {","if (false && succeeded && item.serviceState !== 'TERMINATED') {"),(R,"           */\n          or(\n","           */\n          or(\n            sql`true`,\n")],'did not move'),
 ('W19-02',[(R,"inArray(provisioningOperations.state, ['FAILED', 'ABANDONED']),","inArray(provisioningOperations.state, ['FAILED', 'ABANDONED', 'UNKNOWN']),")],'UNKNOWN'),
 ('W19-02b',[(R,"inArray(provisioningOperations.state, ['FAILED', 'ABANDONED']),","inArray(provisioningOperations.state, ['FAILED', 'ABANDONED', 'UNKNOWN']),")],'UNKNOWN'),
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
 ('W19-09',[(RF,"      { notifyCustomer: false, serviceRemoved: true },","      { notifyCustomer: true, serviceRemoved: true },")],'exactly once'),
 ('W19-10',[(SV,"""function notRefundedAway(): SQL {
  return sql`NOT EXISTS (""","""function notRefundedAway(): SQL {
  return sql`TRUE OR NOT EXISTS (""")],'exactly once'),
 ('W19-11',[(S,"        if (existing !== null) return { outcome: 'ALREADY_OPEN', request: existing };\n","")],'however concurrently'),
 ('W19-12',[(S,"const eligibility = await this.eligibilityOf(scope, service, { checkFlag: true }, tx);","const eligibility = await this.eligibilityOf(scope, service, { checkFlag: false }, tx);"),(S,"    if (!(await this.deps.features.isEnabled(scope, FLAG))) return 'UNAVAILABLE';\n","")],'switch is off'),
 ('W19-13',[(S,"if (length < SERVICE_REFUND_REASON_MIN_LENGTH || length > SERVICE_REFUND_REASON_MAX_LENGTH) {","if (length < 1 || length > SERVICE_REFUND_REASON_MAX_LENGTH) {")],'outside 3'),
 ('W19-14',[(S,"""    if (request.state !== 'OPEN') {
      /*
       * A replay of THIS administrator's rejection""","""    if (request.state !== 'OPEN' && request.state === 'REJECTED') {
      /*
       * A replay of THIS administrator's rejection""")],'approval and a rejection'),
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
      /*
       * A replay of THIS administrator's rejection""","""    if (request.state !== 'OPEN' && request.state === 'REJECTED') {
      /*
       * A replay of THIS administrator's rejection"""),(R,"""        resolvedAt: now,
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
      /*
       * A replay of THIS administrator's rejection""","""    if (request.state !== 'OPEN' && request.state === 'REJECTED') {
      /*
       * A replay of THIS administrator's rejection"""),(R,"""        resolvedAt: now,
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
 ('W19-24',[(R,"           */\n          or(\n","           */\n          or(\n            sql`true`,\n")],'fill the batch'),
 ('W19-25',[(RF,"    if (await this.deps.repository.isServiceRefundReservation(scope, refund.id, tx)) {","    if (refund.reason === 'SERVICE_REFUND_REQUEST') {")],'reads like a request'),
 ('W19-26',[(S,"  ): Promise<ServiceRefundReview> {\n    await this.checkDecide(scope, actor);\n    const request = await this.requireRequest(scope, requestId);","  ): Promise<ServiceRefundReview> {\n    await this.deps.guard.check(scope, actor, SERVICE_REFUND_VIEW_PERMISSION);\n    const request = await this.requireRequest(scope, requestId);")],'exactly the two decision keys'),
 ('W19-27',[(DS,"      if (request.state !== 'EXECUTING') return { outcome: 'CLOSED' };\n","")],'as decided, not as started'),
 ('W19-22b',[(RF,"      if ((await this.deps.wallet.findByReference(scope, `${refundId}:refund`, tx)) !== null) {\n        return before;\n      }","      return before;"),(R,"            and(eq(services.state, 'TERMINATED'), eq(refunds.state, 'REQUESTED')),\n            and(\n              or(","            and(eq(services.state, 'TERMINATED')),\n            and(\n              or(")],'closed elsewhere'),
 ('W19-23',[(S,"        continue;\n      }\n      if (moved) decided += 1;","        throw error;\n      }\n      if (moved) decided += 1;")],'fails inside its own settlement'),

 # Second Codex review of #83. W19-28 (reject before the prompt closed) is superseded by
 # W19-32..33: that order was what let a cancelled prompt still reject.
 ('W19-30',[(S,"        const locked = await this.deps.services.lockForUpdate(scope, request.serviceId, tx);","        const locked = await this.deps.services.findById(scope, request.serviceId, tx);")],'ends while the approval waits'),
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
 # Round 9 replaced draining the stream with paging it: the cursor is still followed, on demand.
 ('W19-40',[(PG,"              onNext={() => nextCursor !== null && setTrail([...trail, nextCursor])}","              onNext={() => undefined}")],'one page of the stream',('web','tests/web/service-refund-requests.test.tsx')),
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
 ('W19-50',[(PV,"this.deps.panels.operability(scope, service.panelId, 'TERMINATE', tx);","this.deps.panels.operability(scope, service.panelId, 'TERMINATE');")],'inside the approval'),
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
      /*""","""    if (replayed !== null && (false as boolean)) {
      /*""")],'redelivered amount'),
 ('W19-54',[(S,"return key === undefined ? null : { key, hash: hashRequest(body) };","void hashRequest;\n    return key === undefined ? null : null;")],'idempotency key \\(Codex'),
 ('W19-55',[(DS,"""      return (
        (await this.enteredAgain(scope, actor, replayed.result.captureId)) ?? { outcome: 'CLOSED' }
      );
    }""","""      const entered = await this.enteredAgain(scope, actor, replayed.result.captureId);
      if (entered !== null) return entered;
    }""")],'from its own prompt, never from a newer one'),
 ('W19-56',[(DS,"""        // Its redelivery is then a known replay, answered and never offered to a newer prompt.
        await rememberOnce(""","""        // Its redelivery is then a known replay, answered and never offered to a newer prompt.
        if (false as boolean) await rememberOnce(""")],'from its own prompt, never from a newer one'),
 ('W19-57',[(DS,"""  if (updateId === undefined || capture.openedUpdateId === null) return true;
  return updateId > capture.openedUpdateId;""","""  void updateId;
  void capture;
  return true;""")],'sent after the tap that opened the prompt'),
 ('W19-58',[(RF,"{ notifyCustomer: false, serviceRemoved: true },","{ notifyCustomer: false },")],'never as leaving it untouched'),
 ('W19-59',[(S,"return request.state === 'OPEN' ? {} : null;","return {};")],'only while its request is still open'),
 ('W19-60',[(SVP,"      {mayViewRefundRequests && <OpenServiceRefundRequestsCard />}","      {!denied && mayViewRefundRequests && <OpenServiceRefundRequestsCard />}")],'refunds.view alone',('web','tests/web/service-refund-requests.test.tsx')),
 ('W19-61',[(APP,"    permission: ['services.view', 'refunds.view'],","    permission: 'services.view',")],'refunds.view alone',('web','tests/web/service-refund-requests.test.tsx')),
 # Round 6 (Codex review of #83).
 ('W19-22c',[(RF,"      if ((await this.deps.wallet.findByReference(scope, `${refundId}:refund`, tx)) !== null) {\n        return before;\n      }","      return before;"),(R,"            and(eq(services.state, 'TERMINATED'), eq(refunds.state, 'REQUESTED')),\n            and(\n              or(","            and(eq(services.state, 'TERMINATED')),\n            and(\n              or("),(S,"const removed = gone && item.refundState === 'REQUESTED';","const removed = gone;")],'closed elsewhere'),
 ('W19-02c',[(R,"inArray(provisioningOperations.state, ['FAILED', 'ABANDONED']),","inArray(provisioningOperations.state, ['FAILED', 'ABANDONED', 'UNKNOWN']),"),(R,"sql`not ${undecidedTermination()}`","sql`true`"),(S,"(await this.deps.repository.terminationUndecided(scope, request.serviceId, tx))","false")],'UNKNOWN'),
 ('W19-01b',[(S,"if (succeeded && item.serviceState !== 'TERMINATED') {","if (false && succeeded && item.serviceState !== 'TERMINATED') {"),(R,"           */\n          or(\n","           */\n          or(\n            sql`true`,\n"),(S,"      if (succeeded && !removed && !(gone && released)) return false;\n","")],'did not move'),
 ('W19-62',[(S,"const removed = gone && item.refundState === 'REQUESTED';","const removed = succeeded;")],'another deletion removed'),
 ('W19-63',[(S,"const removed = gone && item.refundState === 'REQUESTED';","const removed = gone;")],'released elsewhere'),
 ('W19-64',[(S,"(await this.deps.repository.terminationUndecided(scope, request.serviceId, tx))","false")],'in flight'),
 ('W19-64b',[(S,"(await this.deps.repository.terminationUndecided(scope, request.serviceId, tx))","false"),(R,"sql`not ${undecidedTermination()}`","sql`true`")],'in flight'),
 ('W19-65',[(R,"sql`not ${undecidedTermination()}`","sql`true`")],'waiting on another deletion'),
 ('W19-66',[(BR,"      if (result.request.state === 'EXECUTING') return refundOfferReply('PENDING', serviceId);\n","")],'redelivered reason'),
 ('W19-67',[(BR,"      if (result.request.state !== 'OPEN') {\n        return this.serviceDetail(scope, actor, customer, serviceId);\n      }\n","")],'redelivered reason'),
 ('W19-68',[(RF,"await this.creditWallet(scope, after, actor, now, tx, before.requestedByAdminId);","await this.creditWallet(scope, after, actor, now, tx);")],'approving administrator'),
 ('W19-69',[(R,"            : inArray(serviceRefundRequests.state, [...filter.states]),","            : undefined,")],'one stream'),
 ('W19-70',[(C,"      ...(input.attention === 'true' ? { states: SERVICE_REFUND_REQUEST_ATTENTION_STATES } : {}),\n","")],'one stream'),
 ('W19-71',[(CL,"  if (query.attention === true) params.set('attention', 'true');\n","")],'one page of the stream',('web','tests/web/service-refund-requests.test.tsx')),
 ('W19-72',[(H,"  .refine((query) => query.state === undefined || query.attention === undefined, {","  .refine((query) => query.state === undefined || query.attention === undefined || true, {")],'attention queue',('unit',CI)),
 ('W19-73',[(H,"    attention: z.enum(['true']).optional(),","    attention: z.string().optional(),")],'attention queue',('unit',CI)),
 # Round 7 (Codex review of #83).
 ('W19-74',[(R,"eq(provisioningOperations.type, 'TERMINATE'),\n          notInArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES]),","eq(provisioningOperations.type, 'TERMINATE'),\n          inArray(provisioningOperations.state, ['PLANNED', 'IN_FLIGHT']),"),(R,"      and other_op.state not in (${sql.join(","      and other_op.state in ('PLANNED', 'IN_FLIGHT') and other_op.state not in (${sql.join(")],'is UNKNOWN'),
 ('W19-75',[(R,"""                and(
                  eq(provisioningOperations.state, 'SUCCEEDED'),
                  eq(services.state, 'TERMINATED'),
                  eq(refunds.state, 'FAILED'),
                ),
""","")],'released elsewhere before its deletion succeeded'),
 ('W19-76',[(S,"if (succeeded && !removed && !(gone && released)) return false;","if (succeeded && !removed) return false;")],'released elsewhere before its deletion succeeded'),
 ('W19-77',[(S,"""          failureKind: succeeded
            ? 'RESERVATION_RELEASED'
            : (item.operationFailureKind ?? item.operationState),""","""          failureKind: item.operationFailureKind ?? item.operationState,""")],'released elsewhere before its deletion succeeded'),
 ('W19-78',[(PG,"      if (decided.state === 'COMPLETED') {","      if (false) {"),(PG,"      } else if (decided.state === 'FAILED') {","      } else if (false) {")],'replayed approval',('web','tests/web/service-refund-requests.test.tsx')),
 ('W19-79',[(PG,"      } else if (decided.state === 'FAILED') {","      } else if (false) {")],'replayed approval',('web','tests/web/service-refund-requests.test.tsx')),
 # Round 8 (Codex review of #83).
 ('W19-80',[(RFR,"                            AND w.state = 'REQUESTED'","                            AND false")],'currency exposure'),
 ('W19-81',[(H,"  reason: z.string().refine(isServiceRefundRejectionReason, {","  reason: z.string().min(1).max(500).refine(() => true, {")],'rejection reason',('unit',CI)),
 ('W19-82',[(S,"  if (!isServiceRefundRejectionReason(reason)) {","  if (reason.length === 0 || reason.length > 500) {")],'300 emoji'),
 ('W19-83',[(PG,"          disabled={busy || !isServiceRefundRejectionReason(reason)}","          disabled={busy || reason.trim().length === 0 || reason.length > 500}")],'300 emoji',('web','tests/web/service-refund-requests.test.tsx')),
 ('W19-84',[(BR,"        await reopen('refund-reason-retry').catch(() => undefined);\n","")],'filing fails for a reason nobody classified'),
 ('W19-85',[(CCS,"        input.updateId <= capture.openedUpdateId","        input.updateId < 0n")],'sent before the confirmation'),
 ('W19-86',[(BR,"      // The reason must be typed after this tap (Codex review of #83, round 8).\n      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),\n","")],'sent before the confirmation'),
 # Round 9 (Codex review of #83).
 ('W19-87',[(BR,"    if (!hasAnyPanelSection(permissions) && !mayDecideRefundRequest) return null;","    if (!hasAnyPanelSection(permissions)) return null;")],'no panel section'),
 ('W19-88',[(BR,"      ADMIN_REFUND_REQUEST_INTENTS.has(command.intent) && mayBePushedRefundRequests(permissions);","      mayBePushedRefundRequests(permissions);")],'no panel section'),
 ('W19-89',[(BR,"      if (!hasRefusalReply(error)) {\n        await reopen('refund-reason-retry')","      if (!isNexaError(error)) {\n        await reopen('refund-reason-retry')")],'typed error nobody answers'),
 ('W19-90',[(BR,"      if (!hasRefusalReply(error)) {\n        await reopen('refund-reason-retry')","      if (true) {\n        await reopen('refund-reason-retry')")],'sentence the customer is shown'),
 ('W19-91',[(S,"    if (await this.deps.repository.commercialUndecided(scope, service.id, tx)) {","    if (false) {")],'paid renewal of the service is undecided'),
 ('W19-92',[(PV,"    if (await this.deps.operations.terminationUndecided(scope, service.id, tx)) {","    if (false) {")],'operator’s deletion of the service is undecided'),
 ('W19-93',[(S,"        if (locked !== null) await this.deps.services.lockLifecycle(scope, locked.id, tx);\n","")],'lifecycle lock'),
 ('W19-94',[(PV,"    await this.deps.services.lockLifecycle(scope, action.serviceId, tx);\n","")],'lifecycle lock'),
 ('W19-95',[(PG,"  const cursor = trail[trail.length - 1];","  const cursor: AttentionCursor | undefined = undefined;")],'one page of the stream',('web','tests/web/service-refund-requests.test.tsx')),
 # Round 10 (Codex review of #83).
 ('W19-96',[(PV,"    if (await this.deps.services.hasActiveRefundRequest(scope, service.id, tx)) {","    if (false) {")],'open refund request'),
 ('W19-97',[(S,"        await this.deps.services.lockLifecycle(scope, service.id, tx);\n        const eligibility = await this.eligibilityOf(","        const eligibility = await this.eligibilityOf(")],'lifecycle lock'),
 ('W19-98',[(S,"        request.rejectionReason === reason &&\n        request.decidedByAdminId === adminId","        request.rejectionReason === reason")],'second administrator'),
 ('W19-99',[(BR,"  if (permissions.has(CUSTOMERS_VIEW_PERMISSION)) {\n    buttons.push({\n      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_user_button' },","  if (true) {\n    buttons.push({\n      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_user_button' },")],'refund request card',('unit','tests/unit/receipt-review-caption.test.ts')),
 ('W19-100',[(BR,"  if (permissions.has(SERVICES_VIEW_PERMISSION)) {\n    buttons.push({\n      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_service_button' },","  if (true) {\n    buttons.push({\n      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_service_button' },")],'refund request card',('unit','tests/unit/receipt-review-caption.test.ts')),
 ('W19-101',[(PS,"      const buttons = this.deps.keyboard(request, reviewer.permissions);","      const buttons = this.deps.keyboard(request, new Set(['users.view', 'services.view']) as never);")],'card buttons their permissions'),
 # Codex review of #83, round 11
 ('W19-102',[(PL,"            this.options.logger.error({ error, lane }, 'provisioner settlement lane failed');\n","            this.options.logger.error({ error, lane }, 'provisioner settlement lane failed');\n            break;\n")],'settlement lanes',('unit',LL)),
 ('W19-103',[(PL,"      if (scope !== null) {","      if (scope !== null && !failed) {")],'settlement lanes',('unit',LL)),
 ('W19-104',[(PL,"      if (!failed) this.lastProgressAt = this.options.now();","      this.lastProgressAt = this.options.now();")],'settlement lanes',('unit',LL)),
 ('W19-105',[(PV,"        origin.forRefundRequest !== true &&\n        (await this.deps.services.hasOpenRefundRequest(scope, locked.id, tx))","        false")],'while a refund request is open'),
 ('W19-106',[(PV,"      { requestedBy: 'OPERATOR', forRefundRequest: true },","      { requestedBy: 'OPERATOR' },")],'holds no lifecycle lock'),
 ('W19-107',[(PV,"      await this.deps.services.lockLifecycle(scope, locked.id, tx);\n","")],'serialises an operator'),
 ('W19-108',[(S,"        if (!(await this.deps.refundLedger.lockPayment(scope, request.paymentId, tx))) {\n          throw this.notEligible('SOURCE_UNRESOLVED');\n        }\n","")],'holds no lifecycle lock'),
 ('W19-109',[(S,"        if (!(await this.deps.refundLedger.lockPayment(scope, found.source.payment.id, tx))) {","        await this.deps.services.lockLifecycle(scope, service.id, tx);\n        if (!(await this.deps.refundLedger.lockPayment(scope, found.source.payment.id, tx))) {")],'holds no lifecycle lock'),
 ('W19-110',[(SV,"      .for('no key update')","      .for('update')")],'lets a settlement holding'),
 ('W19-111',[],'serves the attention stream',None,("DROP INDEX service_refund_requests_attention_idx","CREATE INDEX service_refund_requests_attention_idx ON service_refund_requests USING btree (tenant_id, created_at, id) WHERE state IN ('OPEN', 'EXECUTING', 'FAILED')")),
 # Codex review of #83, round 12
 ('W19-112',[(RPL,"        this.options.logger.error({ err: error }, 'receipt push pass failed');\n      }\n","        this.options.logger.error({ err: error }, 'receipt push pass failed');\n        return;\n      }\n")],'two lanes',('unit',RL)),
 ('W19-113',[(RPL,"      if (!failed) this.progress.record(this.options.now());","      this.progress.record(this.options.now());")],'two lanes',('unit',RL)),
 ('W19-114',[(S,"    if (await this.deps.repository.terminationUndecided(scope, service.id, tx)) {\n      return { eligible: false, reason: 'CANNOT_DELETE' };\n    }\n","")],'files no request while an operator'),
 ('W19-115',[(R,"            and(eq(services.state, 'TERMINATED'), eq(refunds.state, 'REQUESTED')),\n            and(\n              or(","            and(\n              eq(provisioningOperations.state, 'SUCCEEDED'),\n              eq(services.state, 'TERMINATED'),\n              eq(refunds.state, 'REQUESTED'),\n            ),\n            and(\n              or(")],'own deletion is UNKNOWN'),
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
