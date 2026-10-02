"""TonPays Telegram mutation driver (docs/tonpays-telegram-falsification.md).

Reverts one rule at a time (TPTG-01..40, and the website route's TP-01..20 again, since this
route refactored the code they hold), runs the named tests, and restores every mutated file
with `git checkout`. A mutation of `packages/contracts` or `packages/i18n` rebuilds that
package before its test and again after the restore, because the tests import its `dist`.

Run it in a WORKTREE of its own (CLAUDE.md, reviewing with agents), with TEST_DATABASE_URL
pointing at a database nothing else is using, and a clean tree. Integration mutations are
serialised by construction: one subprocess at a time. A run that exceeds its timeout counts
as KILLED only when the mutation is expected to hang (`HANG`), and says so.

Usage: python3 scripts/mutate-tonpays-telegram.py [TPTG-01 TP-03 ...]
"""
import os
import re
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if 'TEST_DATABASE_URL' not in os.environ:
    sys.exit('TEST_DATABASE_URL is required')
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages']).returncode != 0:
    sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

P = 'apps/api/src/modules/commerce/payments/'
GPS = P + 'application/gateway-payment.service.ts'
PS = P + 'application/payment.service.ts'
RC = P + 'application/gateway-receipt-capture.service.ts'
PGS = P + 'application/payment-gateway.service.ts'
LOOP = P + 'application/gateway-payment-loop.ts'
DOM = P + 'domain/tonpays-telegram.ts'
DTP = P + 'domain/tonpays.ts'
TA = P + 'infrastructure/tonpays-telegram-adapter.ts'
WA = P + 'infrastructure/tonpays-adapter.ts'
PR = P + 'infrastructure/drizzle-payment.repository.ts'
IR = P + 'infrastructure/drizzle-gateway-invoice.repository.ts'
CT = P + 'infrastructure/drizzle-gateway-card-transfer.repository.ts'
RR = P + 'infrastructure/drizzle-receipt.repository.ts'
CRED = P + 'infrastructure/drizzle-gateway-credentials.ts'
OS = 'apps/api/src/modules/commerce/orders/application/order.service.ts'
OR = 'apps/api/src/modules/commerce/orders/infrastructure/drizzle-order.repository.ts'
CS = 'apps/api/src/modules/commerce/messaging/application/customer-screens.ts'
BR = 'apps/api/src/surfaces/telegram/bot-runtime.ts'
FF = 'apps/api/src/infrastructure/telegram/fetch-file.ts'
CAT = 'packages/i18n/src/catalogue.fa.ts'

T_AD = ('unit', 'tests/unit/tonpays-telegram-adapter.test.ts')
T_FF = ('unit', 'tests/unit/telegram-fetch-file.test.ts')
T_SCR = ('unit', 'tests/unit/tonpays-telegram-screen.test.ts')
T_RN = ('unit', 'tests/unit/tonpays-telegram-route-name.test.ts')
T_WA = ('unit', 'tests/unit/tonpays-adapter.test.ts')
T_LOOP = ('unit', 'tests/unit/gateway-payment-loop.test.ts')
T_REPO = ('integration', 'tests/integration/payment-provider-review-repository.test.ts')
T_GW = ('integration', 'tests/integration/tonpays-telegram-gateway.test.ts')
T_RV = ('integration', 'tests/integration/tonpays-telegram-review-window.test.ts')
T_TG = ('integration', 'tests/integration/tonpays-telegram-telegram.test.ts')
T_TP = ('integration', 'tests/integration/tonpays-gateway.test.ts')

# (id, [(file, from, to)], (project, test file), -t filter, expect)
# The filter is a literal: vitest reads `-t` as a regular expression, so it is escaped.
# expect: 'KILL' (a test must fail), 'HANG' (the run must time out: a lock it must skip), or
# 'LAYER' (one line of several: it is EXPECTED to survive, and the record says which holds it).
M = [
    # --- approval ------------------------------------------------------------------------
    ('TPTG-01', [(DTP, "      return paid === true ? 'APPROVED' : 'OPEN';",
                  "      return paid ? 'APPROVED' : 'OPEN';")],
     T_AD, 'only an inquiry’s completed AND paid === true approves', 'KILL'),
    ('TPTG-02', [(PS, "        const deadline = gatewaySettlementDeadline(payment);\n"
                      "        if (deadline === null || now.getTime() >= deadline.getTime()) {",
                  "        const deadline = gatewaySettlementDeadline(payment);\n"
                  "        if (deadline === null) {")],
     T_RV, 'TPTG-02: without a review', 'KILL'),
    # --- never re-sent ----------------------------------------------------------------------
    ('TPTG-03', [(GPS, "    if (invoice.creationSentAt !== null) {", "    if (false) {")],
     T_GW, 'TPTG-03', 'KILL'),
    ('TPTG-04', [(GPS, "    if (change.sentAt !== null) {", "    if (false) {")],
     T_GW, 'TPTG-04: a change whose send was stamped', 'KILL'),
    ('TPTG-05', [(GPS, "    if (submission.sentAt !== null) {", "    if (false) {")],
     T_GW, 'TPTG-05', 'KILL'),
    ('TPTG-06', [(WA, "  if (raw.status >= 500) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };\n", "")],
     T_AD, 'TPTG-06 (receipt)', 'KILL'),
    # --- receipt capture --------------------------------------------------------------------
    ('TPTG-07', [(CT, "          eq(gatewayReceiptCaptures.botInstanceId, botInstanceId),\n", ""),
                 (RC, "        invoice.botInstanceId === capture.botInstanceId &&\n        capture.botInstanceId === input.botInstanceId;",
                  "        invoice.botInstanceId === capture.botInstanceId;")],
     T_GW, 'TPTG-07', 'KILL'),
    # An upload ACCEPTED with neither signal must leave the payment to the 70-minute rule.
    ('TPTG-08', [(DOM, "    outcome.kind === 'ACCEPTED' &&\n    (outcome.receiptReceived === true || outcome.status === 'processing')",
                  "    outcome.kind === 'ACCEPTED'")],
     T_GW, 'TPTG-08', 'KILL'),
    ('TPTG-09', [(RC, "    if (input.file.kind !== 'PHOTO') return 'PHOTO_ONLY';\n", "")],
     T_GW, 'TPTG-09', 'KILL'),
    ('TPTG-09s', [(RC, "      input.file.fileSize > BigInt(TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES)",
                   "      input.file.fileSize > BigInt(TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES * 10)")],
     T_GW, 'TPTG-09', 'KILL'),
    ('TPTG-09f', [(FF, "  return request.maxBytes ?? PAYMENT_RECEIPT_MAX_BYTES;", "  return PAYMENT_RECEIPT_MAX_BYTES;")],
     T_FF, 'TPTG-09', 'KILL'),
    ('TPTG-10', [(CT, "          isNull(receiptCaptures.closedAt),\n        ),\n      );\n    const rows",
                  "          isNull(receiptCaptures.closedAt),\n          sql`false`,\n        ),\n      );\n    const rows")],
     T_GW, 'TPTG-10', 'KILL'),
    ('TPTG-10m', [(RR, "          isNull(gatewayReceiptCaptures.closedAt),\n        ),\n      );\n\n    const rows",
                   "          isNull(gatewayReceiptCaptures.closedAt),\n          sql`false`,\n        ),\n      );\n\n    const rows")],
     T_GW, 'TPTG-10', 'KILL'),
    # --- money ----------------------------------------------------------------------------
    # The credit reads the provider's figure instead of the payment's frozen amount.
    ('TPTG-11', [(PS, "        amount: confirmed.amount,",
                  "        amount: { ...confirmed.amount, amountMinor: (await this.deps.gatewayInvoices.findByPayment(scope, confirmed.id, tx))?.finalAmount ?? confirmed.amount.amountMinor },")],
     T_GW, 'TPTG-11: a top-up credits', 'KILL'),
    ('TPTG-12', [(IR, "                eq(gatewayInvoices.creationState, 'CREATING'),\n                isNull(gatewayInvoices.creationErrorCode),",
                  "                eq(gatewayInvoices.creationState, 'CREATING'),\n                sql`true`,")],
     T_GW, 'TPTG-12', 'KILL'),
    ('TPTG-13', [(IR, "                isNotNull(gatewayInvoices.webInvoiceUrl),\n                isNotNull(gatewayInvoices.invoiceUrl),",
                  "                sql`true`,")],
     T_TP, 'F3: a create answered without a payable link', 'KILL'),
    ('TPTG-13p', [(PS, "          descriptor.invoiceForm === 'LINK'\n            ? 'LINK'",
                   "          descriptor.invoiceForm === 'LINK'\n            ? 'ANY'")],
     T_TP, 'F3: a create answered without a payable link', 'KILL'),
    # --- configuration and identity ---------------------------------------------------------
    ('TPTG-14', [(PGS, "          (await this.deps.credentials.setAt(scope, provider, tx)) === null",
                  "          (await this.deps.credentials.setAt(scope, provider === 'TONPAYS_TELEGRAM' ? 'TONPAYS' : provider, tx)) === null")],
     T_GW, 'TPTG-14', 'KILL'),
    ('TPTG-14r', [(GPS, "      case 'GATEWAY_KEY':\n        return this.deps.credentials.read(scope, invoice.provider);",
                   "      case 'GATEWAY_KEY':\n        return (await this.deps.credentials.read(scope, 'TONPAYS')) ?? this.deps.credentials.read(scope, invoice.provider);")],
     T_GW, 'TPTG-14', 'KILL'),
    ('TPTG-15', [(DOM, "  if ((TONPAYS_TELEGRAM_CONFIGURATION_ERROR_CODES as readonly string[]).includes(code)) {\n    return 'CONFIGURATION';",
                  "  if ((TONPAYS_TELEGRAM_CONFIGURATION_ERROR_CODES as readonly string[]).includes(code)) {\n    return 'REFUSED';")],
     T_GW, 'TPTG-15', 'KILL'),
    ('TPTG-16', [(IR, "    tx?: unknown,\n  ): Promise<GatewayInvoiceRecord | null> {\n    const tenantId = requireTenantId(scope);\n    const [row] = await this.exec(tx)\n      .select()\n      .from(gatewayInvoices)\n      .where(\n        and(\n          eq(gatewayInvoices.tenantId, tenantId),\n          eq(gatewayInvoices.provider, provider),\n          eq(gatewayInvoices.providerOrderId, providerOrderId),",
                  "    tx?: unknown,\n  ): Promise<GatewayInvoiceRecord | null> {\n    const tenantId = requireTenantId(scope);\n    const [row] = await this.exec(tx)\n      .select()\n      .from(gatewayInvoices)\n      .where(\n        and(\n          eq(gatewayInvoices.tenantId, tenantId),\n          eq(gatewayInvoices.providerOrderId, providerOrderId),")],
     T_GW, 'TPTG-16', 'KILL'),
    ('TPTG-17', [(DOM, "  return TONPAYS_TELEGRAM_INVOICE_ID_PATTERN.test(invoiceId);", "  return invoiceId.length > 0;")],
     T_AD, 'TPTG-17', 'KILL'),
    ('TPTG-18', [(PS, "    if (descriptor.requiresBuyerChatId) {", "    if (false) {")],
     T_GW, 'TPTG-18', 'KILL'),
    ('TPTG-18b', [(PS, "    if (descriptor.boundToBot && scope.botInstanceId === null) {", "    if (false) {")],
     T_GW, 'TPTG-18', 'KILL'),
    ('TPTG-18a', [(TA, "      request.buyerChatId === null ||\n      !/^-?\\d{1,16}$/u.test(request.buyerChatId) ||\n      !Number.isSafeInteger(buyer)",
                   "      request.buyerChatId === null")],
     T_AD, 'TPTG-18', 'KILL'),
    ('TPTG-19', [(RC, "      payment.customerId !== input.customerId ||\n      payment.method !== 'GATEWAY' ||",
                  "      payment.method !== 'GATEWAY' ||")],
     T_GW, 'TPTG-19 (service)', 'KILL'),
    ('TPTG-19b', [(RC, "      invoice.creationState !== 'CREATED' ||\n      invoice.botInstanceId !== input.botInstanceId\n",
                   "      invoice.creationState !== 'CREATED'\n")],
     T_GW, 'TPTG-07: a window in bot A', 'KILL'),
    # The surface's own check, before the service: another bot's attempt is answered closed.
    ('TPTG-19s', [(BR, "    botInstanceId: BotInstanceId,\n  ): Promise<PendingReply> {\n    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);\n    /*\n     * TPTG-19: another customer's payment, another bot's attempt, or no such lane is\n     * answered as closed — never with anything about the attempt.\n     */\n    if (\n      view === null ||\n      view.invoice.botInstanceId !== botInstanceId ||\n      this.deps.gatewayReceipts === undefined\n    ) {\n      return {\n        key: 'bot.payment.gateway_closed',",
                   "    botInstanceId: BotInstanceId,\n  ): Promise<PendingReply> {\n    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);\n    /*\n     * TPTG-19: another customer's payment, another bot's attempt, or no such lane is\n     * answered as closed — never with anything about the attempt.\n     */\n    if (\n      view === null ||\n      this.deps.gatewayReceipts === undefined\n    ) {\n      return {\n        key: 'bot.payment.gateway_closed',")],
     T_TG, 'TPTG-19', 'KILL'),
    ('TPTG-19p', [(RC, "      payment.state !== 'PENDING' ||\n      payment.providerReviewUntil !== null ||",
                   "      payment.providerReviewUntil !== null ||")],
     T_TG, 'TPTG-19', 'KILL'),
    ('TPTG-20', [(DOM, "  if (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) return false;\n", "")],
     T_AD, 'TPTG-20', 'KILL'),
    ('TPTG-20c', [(DOM, "  if (invoice.cardChangeCooldownUntil !== null && now < invoice.cardChangeCooldownUntil) {\n    return false;\n  }\n", "")],
     T_AD, 'TPTG-20', 'KILL'),
    ('TPTG-20x', [(DOM, "  if (invoice.cardChangeShown === false || invoice.cardChangeExhausted === true) return false;",
                   "  if (invoice.cardChangeShown === false) return false;")],
     T_GW, 'TPTG-20', 'KILL'),
    ('TPTG-21', [(GPS, "            context: { paymentId: submission.paymentId, reason: code },",
                  "            context: { paymentId: submission.paymentId, reason: code, file: submission.telegramFileId },")],
     T_GW, 'TPTG-21', 'KILL'),
    ('TPTG-21k', [(GPS, "        outcome: outcome.kind,\n        reason: outcome.kind === 'ACCEPTED' ? null : outcome.code,\n      },\n      'gateway receipt upload answered',",
                   "        outcome: outcome.kind,\n        reason: outcome.kind === 'ACCEPTED' ? null : outcome.code,\n        key: apiKey,\n      },\n      'gateway receipt upload answered',")],
     T_GW, 'TPTG-21', 'KILL'),
    ('TPTG-22', [(GPS, "          cards.releaseCardChangeClaims(\n            scope,\n            claimed.slice(index).map((one) => one.row.id),",
                  "          cards.releaseCardChangeClaims(\n            scope,\n            claimed.slice(index + 1).map((one) => one.row.id),")],
     T_GW, 'TPTG-22', 'KILL'),
    ('TPTG-22r', [(GPS, "          cards.releaseSubmissionClaims(\n            scope,\n            claimed.slice(index).map((one) => one.row.id),",
                   "          cards.releaseSubmissionClaims(\n            scope,\n            claimed.slice(index + 1).map((one) => one.row.id),")],
     T_GW, 'TPTG-22', 'KILL'),
    ('TPTG-23', [(CAT, "  'bot.payment.route_name_tonpays': 'درگاه پرداخت تون پی وبسایت',",
                  "  'bot.payment.route_name_tonpays': 'تون‌پیز (TonPays)',")],
     T_RN, 'defaults the website route', 'KILL'),
    ('TPTG-23t', [(CS, "  TONPAYS_TELEGRAM: 'bot.payment.route_name_tonpays_telegram',",
                   "  TONPAYS_TELEGRAM: 'bot.payment.route_name_tonpays',")],
     T_RN, 'defaults the website route', 'KILL'),
    # --- the review window ------------------------------------------------------------------
    ('TPTG-24', [(PS, "          payment.expiresAt === null ||\n          input.acknowledgedAt.getTime() >= payment.expiresAt.getTime()\n",
                  "          payment.expiresAt === null\n"),
                 (PR, "          // Half-open: an acknowledgement AT the deadline opens nothing.\n          gt(payments.expiresAt, window.acknowledgedAt),\n", "")],
     T_REPO, 'TPTG-24: an acknowledgement opens a review only strictly before', 'KILL'),
    ('TPTG-24s', [(PS, "          payment.expiresAt === null ||\n          input.acknowledgedAt.getTime() >= payment.expiresAt.getTime()\n",
                   "          payment.expiresAt === null\n"),
                  (PR, "          // Half-open: an acknowledgement AT the deadline opens nothing.\n          gt(payments.expiresAt, window.acknowledgedAt),\n", "")],
     # The same two lines removed, seen end to end: the CHECK's `started < expires_at` is the
     # third line, refuses the write, and the worker opens nothing. Expected to survive.
     T_RV, 'TPTG-24/31', 'LAYER'),
    ('TPTG-25', [(PR, "          // Never a payment in a provider review: row-local (§9.6.3 a, b).\n          isNull(payments.providerReviewUntil),\n", ""),
                 (PR, "           * which a cross-table predicate would not be.\n           */\n          isNull(payments.providerReviewUntil),\n",
                  "           * which a cross-table predicate would not be.\n           */\n")],
     T_RV, 'TPTG-25: in review, the expiry sweep never takes', 'KILL'),
    ('TPTG-26', [(PR, "          // Never a payment in a provider review: row-local (§9.6.3 a, b).\n          isNull(payments.providerReviewUntil),\n",
                  "          sql`${payments.method} <> 'GATEWAY'`,\n"),
                 (PR, "           * which a cross-table predicate would not be.\n           */\n          isNull(payments.providerReviewUntil),\n",
                  "           * which a cross-table predicate would not be.\n           */\n          sql`${payments.method} <> 'GATEWAY'`,\n")],
     T_REPO, 'TPTG-25/26', 'KILL'),
    ('TPTG-27', [(PS, "        const deadline = gatewaySettlementDeadline(payment);\n        if (deadline === null || now.getTime() >= deadline.getTime()) {",
                  "        const deadline = payment.expiresAt;\n        if (deadline === null || now.getTime() >= deadline.getTime()) {")],
     T_RV, 'TPTG-02/27', 'KILL'),
    ('TPTG-28', [(PS, "        if (deadline === null || now.getTime() >= deadline.getTime()) {\n          return { outcome: 'NOT_ELIGIBLE', reason: 'DEADLINE_PASSED', payment };",
                  "        if (deadline === null || now.getTime() > deadline.getTime()) {\n          return { outcome: 'NOT_ELIGIBLE', reason: 'DEADLINE_PASSED', payment };")],
     T_RV, 'TPTG-28', 'KILL'),
    ('TPTG-29', [(DOM, "    outcome.kind === 'ACCEPTED' &&\n    (outcome.receiptReceived === true || outcome.status === 'processing')",
                  "    outcome.kind === 'ACCEPTED'")],
     T_AD, 'TPTG-29', 'KILL'),
    ('TPTG-29i', [(DOM, "    outcome.kind === 'ACCEPTED' &&\n    (outcome.receiptReceived === true || outcome.status === 'processing')",
                   "    outcome.kind === 'ACCEPTED' &&\n    (Boolean(outcome.receiptReceived) || outcome.status === 'processing')")],
     T_RV, 'TPTG-25/29', 'KILL'),
    ('TPTG-30', [(PR, "          // Written once: a repeated acknowledgement moves nothing.\n          isNull(payments.providerReviewUntil),\n", "")],
     T_REPO, 'TPTG-30: a repeated or later acknowledgement', 'KILL'),
    ('TPTG-31a', [(PR, "      .orderBy(asc(payments.expiresAt), asc(payments.id))\n      .limit(limit)\n      .for('update', { skipLocked: true });",
                   "      .orderBy(asc(payments.expiresAt), asc(payments.id))\n      .limit(limit);")],
     T_REPO, 'TPTG-31 (a)', 'HANG'),
    ('TPTG-31b', [(PR, "          eq(payments.id, id),\n          eq(payments.state, 'PENDING'),\n          eq(payments.method, 'GATEWAY'),\n          // Only a route whose descriptor reviews",
                   "          eq(payments.id, id),\n          eq(payments.method, 'GATEWAY'),\n          // Only a route whose descriptor reviews")],
     T_REPO, 'TPTG-31 (b)', 'KILL'),
    ('TPTG-32', [(PR, "    const reviewEnded = and(\n      eq(payments.tenantId, tenantId),\n      eq(payments.state, 'PENDING'),",
                  "    const reviewEnded = and(\n      eq(payments.tenantId, tenantId),")],
     T_RV, 'TPTG-32', 'KILL'),
    ('TPTG-33', [(GPS, "      payment.expiresAt !== null &&\n      this.deps.clock.now().getTime() < payment.expiresAt.getTime();",
                  "      payment.expiresAt !== null;")],
     T_GW, 'TPTG-33', 'KILL'),
    ('TPTG-34', [(PR, "      lte(payments.providerReviewUntil, now),", "      lte(payments.expiresAt, now),")],
     T_REPO, 'TPTG-34', 'KILL'),
    # UNKNOWN is never auto-settled, and four independent lines hold it: the lane's
    # eligibility, the settlement's PENDING check, the deadline under the lock, and the
    # conditional UPDATE from PENDING. Any one alone survives (the record says so); this row
    # writes the auto-settlement whole, and the named test must notice it.
    ('TPTG-35', [(GPS, "    const eligible =\n      claimed.paymentState === 'PENDING' &&\n      expiresAt !== null &&\n      now.getTime() < expiresAt.getTime();",
                  "    const eligible =\n      claimed.paymentState === 'UNKNOWN' ||\n      (claimed.paymentState === 'PENDING' && expiresAt !== null && now.getTime() < expiresAt.getTime());"),
                 (PS, "        if (payment.state !== 'PENDING') {\n          return { outcome: 'NOT_ELIGIBLE', reason: 'PAYMENT_NOT_PENDING', payment };",
                  "        if (payment.state !== 'PENDING' && payment.state !== 'UNKNOWN') {\n          return { outcome: 'NOT_ELIGIBLE', reason: 'PAYMENT_NOT_PENDING', payment };"),
                 (PS, "        const deadline = gatewaySettlementDeadline(payment);\n        if (deadline === null || now.getTime() >= deadline.getTime()) {",
                  "        const deadline = gatewaySettlementDeadline(payment);\n        if (payment.state === 'PENDING' && (deadline === null || now.getTime() >= deadline.getTime())) {"),
                 (PS, "  ): Promise<{ readonly payment: PaymentRecord; readonly order: OrderRecord }> {\n    const moved =\n      from === 'UNKNOWN'",
                  "  ): Promise<{ readonly payment: PaymentRecord; readonly order: OrderRecord }> {\n    const moved =\n      from === 'UNKNOWN' || payment.state === 'UNKNOWN'")],
     T_RV, 'TPTG-35: UNKNOWN is never auto-settled', 'KILL'),
    ('TPTG-35a', [(GPS, "    const eligible =\n      claimed.paymentState === 'PENDING' &&\n      expiresAt !== null &&\n      now.getTime() < expiresAt.getTime();",
                   "    const eligible =\n      claimed.paymentState === 'UNKNOWN' ||\n      (claimed.paymentState === 'PENDING' && expiresAt !== null && now.getTime() < expiresAt.getTime());")],
     T_RV, 'TPTG-35: UNKNOWN is never auto-settled', 'LAYER'),
    ('TPTG-36w', [(PS, "        if (await this.deps.repository.hasProviderReviewOrUnknownForOrder(scope, orderId, tx)) {",
                   "        if (false) {")],
     T_RV, 'TPTG-36', 'KILL'),
    ('TPTG-36c', [(OS, "        if (await this.deps.payments.providerReviewFor(scope, orderId, tx)) {", "        if (false) {")],
     T_RV, 'TPTG-36', 'KILL'),
    ('TPTG-36p', [(PR, "           * acknowledgement's row lock re-reads this column on the committed row.\n           */\n          isNull(payments.providerReviewUntil),\n",
                   "           * acknowledgement's row lock re-reads this column on the committed row.\n           */\n")],
     T_RV, 'TPTG-36', 'KILL'),
    ('TPTG-36o', [(OR, "AND live.state IN ('PENDING', 'UNKNOWN')", "AND live.state IN ('PENDING')")],
     T_RV, 'TPTG-36', 'KILL'),
    ('TPTG-36d', [(PS, "        if (payment.providerReviewUntil !== null) {\n          throw errors.conflict(\n            COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW,",
                   "        if (false) {\n          throw errors.conflict(\n            COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW,")],
     T_RV, 'TPTG-36', 'KILL'),
    ('TPTG-37c', [(PS, "            ? status === 'completed' && invoice?.providerPaid === true\n",
                   "            ? true\n")],
     T_RV, 'TPTG-37: needs payments.reconcile', 'KILL'),
    ('TPTG-37f', [(PS, "            : status !== null && RECONCILE_FAILED_STATUSES.includes(status);",
                   "            : true;")],
     T_RV, 'TPTG-37: needs payments.reconcile', 'KILL'),
    ('TPTG-37s', [(PS, "        if (payment.state !== 'UNKNOWN') {\n          throw errors.conflict(\n            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,\n            'Only a payment whose outcome is unknown can be reconciled.',",
                   "        if (false) {\n          throw errors.conflict(\n            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,\n            'Only a payment whose outcome is unknown can be reconciled.',")],
     T_RV, 'TPTG-37: needs payments.reconcile', 'KILL'),
    # A permission the support role HOLDS, so the denial the test expects can only come
    # from `payments.reconcile`.
    ('TPTG-37p', [(PS, "    const denial = { action, entityType: 'Payment', entityId: paymentId };\n    await this.authorize(scope, actor, PAYMENT_RECONCILE_PERMISSION, denial);",
                   "    const denial = { action, entityType: 'Payment', entityId: paymentId };\n    await this.authorize(scope, actor, 'orders.view', denial);"),
                  (PS, "    return runAuthorizedMutation(\n      this.mutationDeps(),\n      scope,\n      actor,\n      PAYMENT_RECONCILE_PERMISSION,\n      denial,\n      async (tx) => {\n        await this.assertScopeActive(scope, tx);\n        const payment = await this.deps.repository.findByIdForUpdate(scope, paymentId, tx);\n        if (payment === null || payment.method !== 'GATEWAY') {\n          throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');\n        }\n        if (payment.state !== 'UNKNOWN') {\n          throw errors.conflict(\n            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,\n            'Only a payment whose outcome is unknown can be reconciled.',",
                   "    return runAuthorizedMutation(\n      this.mutationDeps(),\n      scope,\n      actor,\n      'orders.view',\n      denial,\n      async (tx) => {\n        await this.assertScopeActive(scope, tx);\n        const payment = await this.deps.repository.findByIdForUpdate(scope, paymentId, tx);\n        if (payment === null || payment.method !== 'GATEWAY') {\n          throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');\n        }\n        if (payment.state !== 'UNKNOWN') {\n          throw errors.conflict(\n            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,\n            'Only a payment whose outcome is unknown can be reconciled.',")],
     T_RV, 'TPTG-37 (HTTP)', 'KILL'),
    ('TPTG-37r', [(PR, "          eq(payments.id, id),\n          eq(payments.state, 'UNKNOWN'),\n          eq(payments.method, 'GATEWAY'),\n        ),\n      )\n      .returning({ id: payments.id });\n    return rows.length > 0;\n  }\n\n  async reconcileFail(",
                   "          eq(payments.id, id),\n          eq(payments.method, 'GATEWAY'),\n        ),\n      )\n      .returning({ id: payments.id });\n    return rows.length > 0;\n  }\n\n  async reconcileFail(")],
     T_REPO, 'reconciles only from UNKNOWN', 'KILL'),
    ('TPTG-38', [(GPS, "    if (outcome.verdict === 'UNSUCCESSFUL') {\n      if (eligible) {",
                  "    if (outcome.verdict === 'UNSUCCESSFUL') {\n      if (eligible && reviewUntil === null) {")],
     T_RV, 'TPTG-38', 'KILL'),
    ('TPTG-38u', [(DTP, "    case 'canceled':\n      return 'UNSUCCESSFUL';", "      return 'UNSUCCESSFUL';\n    case 'canceled':\n      return 'OPEN';")],
     T_AD, 'TPTG-01/38', 'KILL'),
    ('TPTG-39', [(BR, "  if (payment.state === 'UNKNOWN') {\n    return screen('bot.payment.gateway_review_unresolved', [], 'INVOICE');\n  }\n", "")],
     T_SCR, 'TPTG-39: UNKNOWN', 'KILL'),
    ('TPTG-39r', [(BR, "  if (payment.state === 'PENDING' && reviewUntil !== null) {", "  if (false) {")],
     T_SCR, 'TPTG-39: in review', 'KILL'),
    ('TPTG-40', [(DOM, "  if (next.getTime() < reviewUntil.getTime() - 15_000) return next;\n  const last = new Date(reviewUntil.getTime() - 15_000);",
                  "  if (next.getTime() < reviewUntil.getTime()) return next;\n  const last = new Date(reviewUntil.getTime() - 15_000);")],
     T_AD, 'TPTG-40', 'KILL'),
    ('TPTG-40l', [(GPS, "      : reviewUntil !== null\n        ? // In review", "      : false\n        ? // In review")],
     T_RV, 'TPTG-40', 'KILL'),

    # --- the website route's rules, re-run over the refactored code (docs/tonpays-falsification.md)
    ('TP-01', [(DTP, "      return paid === true ? 'APPROVED' : 'OPEN';", "      return paid ? 'APPROVED' : 'OPEN';")],
     T_WA, 'approves ONLY completed with paid === true', 'KILL'),
    ('TP-02', [(PS, "        const deadline = gatewaySettlementDeadline(payment);\n        if (deadline === null || now.getTime() >= deadline.getTime()) {",
                "        const deadline = gatewaySettlementDeadline(payment);\n        if (deadline === null) {")],
     T_TP, 'is enforced by the settlement path itself', 'KILL'),
    ('TP-03', [(GPS, "    if (invoice.creationSentAt !== null) {", "    if (false) {")],
     T_TP, 'never re-sends a create whose send was stamped', 'KILL'),
    ('TP-04', [(GPS, "        if (invoice.creationAttempts + 1 < TONPAYS_CREATE_MAX_ATTEMPTS) {", "        if (false) {")],
     T_TP, 'retries a rate-limited create with the SAME order id', 'KILL'),
    ('TP-05', [(GPS, "    if (outcome.invoiceId !== invoiceId || outcome.orderId !== invoice.providerOrderId) {", "    if (false) {")],
     T_TP, 'never acts on an inquiry answer that names another order', 'KILL'),
    ('TP-06', [(GPS, "    if (invoice.providerInvoiceId !== null && invoice.providerInvoiceId !== hint.invoiceId) {", "    if (false) {")],
     T_TP, 'writes nothing for a webhook whose invoice id is not the one on record', 'KILL'),
    ('TP-07', [(GPS, "    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return 'IGNORED_INACTIVE';\n", "")],
     T_TP, 'ignores a webhook that names another tenant', 'KILL'),
    ('TP-08', [(PS, "    if (open !== null) {\n      const existing = await this.deps.repository.findById(scope, open.paymentId, tx);",
                "    if (false) {\n      const existing = await this.deps.repository.findById(scope, open!.paymentId, tx);")],
     T_TP, 'hands back the open attempt to a second tap', 'KILL'),
    ('TP-09', [(PGS, "          (await this.deps.credentials.setAt(scope, provider, tx)) === null", "          false")],
     T_TP, 'is refused enablement without one', 'KILL'),
    ('TP-10', [(CRED, "omit a predicate.\n      .where(\n        and(\n          eq(paymentGatewayCredentials.tenantId, tenantId),\n",
                "omit a predicate.\n      .where(\n        and(\n")],
     T_TP, 'ignores a webhook that names another tenant', 'KILL'),
    ('TP-11', [(PS, "          topupCashbackPercent: route.gateway.topupCashbackPercent,", "          topupCashbackPercent: null,")],
     T_TP, 'credits the Nexa amount and the route’s gift exactly once', 'KILL'),
    ('TP-12', [(GPS, "    if (outcome.verdict === 'UNSUCCESSFUL') {\n      if (eligible) {", "    if (outcome.verdict === 'UNSUCCESSFUL') {\n      if (false) {")],
     T_TP, 'credits the Nexa amount and the route’s gift exactly once', 'KILL'),
    ('TP-13', [(IR, "          eq(payments.amount, input.amount.amountMinor),\n          eq(payments.currency, input.amount.currency),\n          /*\n           * The EFFECTIVE",
                "          /*\n           * The EFFECTIVE")],
     T_TP, 'hands back an open top-up only for the same amount', 'KILL'),
    ('TP-14', [(WA, "  if (raw.status >= 500) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };\n", "")],
     T_WA, 'calls every 5xx UNKNOWN whatever code its body carries', 'KILL'),
    ('TP-15', [(WA, "    if (total > limit) {\n      await reader.cancel().catch(() => undefined);\n      return null;\n    }\n", "")],
     T_WA, 'stops reading a body at the bound', 'KILL'),
    ('TP-16', [(GPS, "          await this.releaseUnreached(scope, 'INQUIRY', due.slice(index), inquiryLease);",
                "          await this.releaseUnreached(scope, 'INQUIRY', due.slice(index + 1), inquiryLease);")],
     T_TP, 'gives back the inquiry leases it did not reach', 'KILL'),
    ('TP-17', [(GPS, "        await this.releaseUnreached(scope, 'CREATION', creating.slice(index + 1), creationLease);",
                "        await this.releaseUnreached(scope, 'CREATION', creating.slice(index + 2), creationLease);")],
     T_TP, 'gives back the creation leases it did not reach', 'KILL'),
    ('TP-18', [(IR, "          inArray(gatewayInvoices.paymentId, [...paymentIds]),\n          eq(column, leaseUntil),",
                "          inArray(gatewayInvoices.paymentId, [...paymentIds]),")],
     T_TP, 'releases only a lease still carrying the value it set', 'KILL'),
    ('TP-19', [(GPS, "          nextInquiryAt: next,\n          postDeadline,\n        },\n        at,\n        tx,\n      );\n    });",
                "          nextInquiryAt: outcome.verdict === 'OPEN' ? next : null,\n          postDeadline,\n        },\n        at,\n        tx,\n      );\n    });")],
     T_TP, 'keeps an unsuccessful inquiry scheduled until the failure is durable', 'KILL'),
    ('TP-20', [(LOOP, "  return Math.ceil(passBoundMs / intervalMs) + 3;", "  return 3;")],
     T_LOOP, 'tolerates the pass bound plus three intervals', 'KILL'),
]


def rebuild(files):
    for package in ('contracts', 'i18n'):
        if any(f.startswith(f'packages/{package}') for f in files):
            subprocess.run(['pnpm', '--filter', f'@nexa/{package}', 'build'],
                           capture_output=True, check=True)


only = sys.argv[1:]
results = []
for mid, edits, (project, test), filt, expect in M:
    if only and mid not in only:
        continue
    files = []
    ok = True
    for f, a, b in edits:
        s = open(f, encoding='utf-8').read()
        if s.count(a) != 1:
            print(mid, 'ANCHOR MISSING in', f, s.count(a), flush=True)
            ok = False
            break
        open(f, 'w', encoding='utf-8').write(s.replace(a, b))
        files.append(f)
    verdict = 'SETUP-FAILED'
    detail = []
    if ok:
        rebuild(files)
        try:
            r = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--project', project, test, '-t', re.escape(filt)],
                               capture_output=True, text=True, timeout=420)
            out = r.stdout + r.stderr
            ran = [l.strip() for l in out.splitlines() if 'Tests ' in l]
            detail = ran + [l.strip() for l in out.splitlines() if '×' in l][:3]
            # A run that matched no test is not a kill (scripts/falsify.sh).
            if not any('passed' in l or 'failed' in l for l in ran):
                verdict = 'NO-TEST-RAN'
            elif r.returncode != 0:
                verdict = 'KILLED' if expect != 'HANG' else 'KILLED (expected a hang)'
            else:
                verdict = 'SURVIVED (a layer, as expected)' if expect == 'LAYER' else 'SURVIVED'
        except subprocess.TimeoutExpired:
            verdict = 'KILLED (timed out: the sweep waited on the lock)' if expect == 'HANG' else 'TIMEOUT'
    for f in files:
        subprocess.run(['git', 'checkout', '--', f])
    rebuild(files)
    if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages']).returncode != 0:
        sys.exit(f'{mid}: the tree did not restore byte-for-byte')
    print(mid, verdict, detail, flush=True)
    results.append((mid, verdict))

print('\nSUMMARY')
for mid, verdict in results:
    print(f'{mid:10} {verdict}')
