"""Package A (Telegram Stars) mutation driver (docs/package-a-falsification.md).

Reverts one rule at a time, runs the named tests, and restores the file with `git checkout`.
A mutation of `packages/contracts` rebuilds the package first, because the tests import its
`dist`, and rebuilds it again after the restore. A row may carry a (setup, teardown) SQL
pair for a rule that lives in the database rather than in a file. Needs TEST_DATABASE_URL
pointing at a database nothing else is using, Redis on REDIS_URL, and a clean tree.
Usage: python3 scripts/mutate-package-a.py [A-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if 'TEST_DATABASE_URL' not in os.environ:
  sys.exit('TEST_DATABASE_URL is required')
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

CT='packages/contracts/src/telegram-stars.ts'
AD='apps/api/src/modules/commerce/payments/infrastructure/telegram-stars-adapter.ts'
PGS='apps/api/src/modules/commerce/payments/application/payment-gateway.service.ts'
PGR='apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment-gateway.repository.ts'
SEED='apps/api/src/infrastructure/persistence/seed.ts'
GIR='apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository.ts'
PS='apps/api/src/modules/commerce/payments/application/payment.service.ts'
SM='apps/api/src/infrastructure/telegram/send-message.ts'
DOM='apps/api/src/modules/commerce/payments/domain/telegram-stars.ts'
SPS='apps/api/src/modules/commerce/payments/application/telegram-stars-payment.service.ts'
GPS='apps/api/src/modules/commerce/payments/application/gateway-payment.service.ts'
WH='apps/api/src/surfaces/telegram/webhook.controller.ts'
FL='apps/api/src/modules/commerce/payments/application/financial-log.consumer.ts'
BR='apps/api/src/surfaces/telegram/bot-runtime.ts'
ANS='apps/api/src/modules/commerce/payments/infrastructure/telegram-stars-checkout-answerer.ts'
PR='apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository.ts'
OS='apps/api/src/modules/commerce/orders/application/order.service.ts'
TPL='packages/contracts/src/templates.ts'
WEB='apps/web/src/pages/payments.tsx'

T_I=('integration','tests/integration/telegram-stars.test.ts')
T_U=('unit','tests/unit/telegram-stars.test.ts')
T_W=('unit','tests/unit/telegram-stars-webhook.test.ts')
T_WEB=('web','tests/web/payments.test.tsx')

TRIGGER_SQL=('DROP TRIGGER IF EXISTS nexa_gateway_invoices_snapshot_guard ON gateway_invoices',
  'CREATE TRIGGER nexa_gateway_invoices_snapshot_guard BEFORE UPDATE ON gateway_invoices '
  'FOR EACH ROW EXECUTE FUNCTION nexa_gateway_invoices_snapshot_guard()')

# (id, [(file, before, after)], test, name filter[, (setup SQL, teardown SQL)])
M=[
 # --- the route and the conversion (A1) ---------------------------------------------------
 ('A-01',[(CT,"return (payableMinor + rateMinor - 1n) / rateMinor;","return payableMinor / rateMinor;")],T_U,'is ceil'),
 ('A-02',[(AD,"    if (rateMinor === null) return null;\n","    if (rateMinor === null) return amount.amountMinor;\n")],T_U,'converts only with a rate'),
 ('A-03',[(PGS,"          PAYMENT_GATEWAY_DESCRIPTORS[provider].conversion === 'FIXED_RATE' &&\n          before.providerUnitRateMinor === null","          false")],T_I,'cannot be switched on without a rate'),
 ('A-04',[(PGS,"          config.providerUnitRateMinor === null &&\n          before.status === 'ACTIVE'","          false")],T_I,'refuses clearing the rate'),
 ('A-05',[(PGS,"if (config.providerUnitRateMinor !== null && conversion !== 'FIXED_RATE') {","if (false as boolean) {")],T_I,'refuses clearing the rate'),
 ('A-06',[(PGR,"            PAYMENT_GATEWAY_DESCRIPTORS[provider].requiresCredentials ||\n            PAYMENT_GATEWAY_DESCRIPTORS[provider].conversion === 'FIXED_RATE'","            PAYMENT_GATEWAY_DESCRIPTORS[provider].requiresCredentials")],T_I,'boot reconcile'),
 ('A-07',[(SEED,"            PAYMENT_GATEWAY_DESCRIPTORS[provider].requiresCredentials ||\n            PAYMENT_GATEWAY_DESCRIPTORS[provider].conversion === 'FIXED_RATE'","            PAYMENT_GATEWAY_DESCRIPTORS[provider].requiresCredentials")],T_I,'starts disabled'),
 ('A-08',[(GIR,"        conversionRateMinor: input.conversionRateMinor,\n","        conversionRateMinor: input.conversionRateMinor === null ? null : 1n,\n")],T_I,'keeps an open invoice at the rate'),
 ('A-09',[],T_I,'refuses a rewrite',TRIGGER_SQL),
 ('A-10',[(GIR,"          input.botInstanceId === null\n            ? isNull(gatewayInvoices.botInstanceId)\n            : eq(gatewayInvoices.botInstanceId, input.botInstanceId),\n","")],T_I,'only in the bot it was sent through'),
 ('A-11',[(PS,"if (descriptor.invoiceCredential === 'BOT_TOKEN' && scope.botInstanceId === null) {","if (false as boolean) {")],T_I,'refused outside a bot'),
 ('A-12',[(PS,"      descriptor.invoiceCredential === 'GATEWAY_KEY' &&\n","")],T_I,'asks for ceil'),
 # --- the invoice (A2) --------------------------------------------------------------------
 ('A-13',[(SM,"      provider_token: '',\n","")],T_U,'sends XTR'),
 ('A-14',[(AD,"    return sent.errorCode === 'telegram.rate_limited'","    return sent.errorCode.startsWith('telegram.')")],T_U,'keeps a rate limit'),
 ('A-15',[(GPS,"      case 'BOT_TOKEN':\n        return invoice.botInstanceId === null\n          ? null\n          : this.deps.botTokens.tokenForBotInstance(scope, invoice.botInstanceId);","      case 'BOT_TOKEN':\n        return this.deps.credentials.read(scope, invoice.provider);")],T_I,'asks for ceil'),
 # --- pre-checkout (A3) -------------------------------------------------------------------
 ('A-16',[(DOM,"    facts.now.getTime() + TELEGRAM_STARS_PRE_CHECKOUT_MARGIN_MS > facts.payment.expiresAt.getTime()","    facts.now.getTime() > facts.payment.expiresAt.getTime()")],T_I,'last two minutes'),
 ('A-17',[(DOM,"    return 'WRONG_BOT';","    return null as never;")],T_I,'wrong bot'),
 ('A-18',[(DOM,"    return 'WRONG_PAYER';","    return null as never;")],T_I,'wrong payer'),
 ('A-19',[(DOM,"  if (facts.update.totalAmount !== facts.invoice.sentAmount) return 'WRONG_AMOUNT';\n","")],T_I,'not the snapshotted Stars'),
 ('A-20',[(DOM,"  if (facts.customer !== null && facts.customer.status === 'BLOCKED') return 'CUSTOMER_BLOCKED';\n","")],T_I,'blocked customer'),
 ('A-21',[(ANS,"      const errorMessage = ok\n        ? null\n        : await this.templates.render(scope, 'bot.payment.stars_precheckout_refused', {});","      const errorMessage = null;")],T_I,'one fixed sentence'),
 # --- successful_payment (A4) ------------------------------------------------------------
 ('A-22',[(SPS,"(await this.deps.invoices.findByChargeId(scope, PROVIDER, update.chargeId, tx)) !== null","false as boolean")],T_I,'never attaches one charge id'),
 ('A-23',[(GIR,"          eq(gatewayInvoices.tenantId, tenantId),\n          eq(gatewayInvoices.provider, provider),\n          eq(gatewayInvoices.providerOrderId, providerOrderId),\n        ),\n      )\n      .limit(1)\n      .for('update');","          eq(gatewayInvoices.provider, provider),\n          eq(gatewayInvoices.providerOrderId, providerOrderId),\n        ),\n      )\n      .limit(1)\n      .for('update');")],T_I,'from tenant B'),
 ('A-24',[(GPS,"    if (PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].approval === 'RECORDED_PAYMENT') {","    if (false as boolean) {")],T_I,'lets the worker settle'),
 ('A-25',[(GIR,"        isNotNull(gatewayInvoices.providerChargeId),\n","")],T_I,'lost'),
 ('A-26',[(WH,"      await this.container.starsPayments.recordSuccessfulPayment(scope, botInstance.id, payment);","      await this.container.starsPayments\n        .recordSuccessfulPayment(scope, botInstance.id, payment)\n        .catch(() => undefined);")],T_W,'fails the request'),
 ('A-27',[(WH,"    if (hasSuccessfulPayment(update)) {","    if (false as boolean) {")],T_W,'never handing it to the customer turn'),
 # --- the customer, the log --------------------------------------------------------------
 ('A-28',[(FL,"  if (invoice.conversionRateMinor !== null) {","  if (false as boolean) {")],T_I,'financial log'),
 ('A-29',[(BR,"  if (command === '/paysupport') {","  if (false as boolean) {")],T_U,'/paysupport'),
 ('A-30',[(BR,"          (provider === null || candidate.provider === provider),","          true,")],T_I,'route the customer tapped'),
 # --- the Codex review of #85 -------------------------------------------------------------
 ('A-31',[(PR,"          isNull(payments.customerSignalledAt),\n          /*\n           * Nor a payment an approved Stars pre-checkout holds (Codex review of #85):\n           * Telegram charges right after the approval. Row-local, so a cancellation that\n           * waited on the approval's row lock re-checks it against the committed row.\n           */\n          notHeldAt(now),\n","          isNull(payments.customerSignalledAt),\n")],T_I,'holds an approved checkout'),
 ('A-32',[(OS,"        if (await this.deps.payments.checkoutHeldFor(scope, orderId, now, tx)) {","        if (false as boolean) {")],T_I,'holds an approved checkout'),
 ('A-33',[(PS,"        if (\n          payment.checkoutHeldUntil !== null &&\n          payment.checkoutHeldUntil.getTime() > now.getTime()\n        ) {","        if (false as boolean) {")],T_I,'holds an approved checkout'),
 ('A-34',[(PR,"          // Never over an approved Stars checkout: the charge is on its way (#85, C2).\n          notHeldAt(now),\n","")],T_I,'holds an approved checkout'),
 ('A-35',[(PS,"        if (await this.deps.repository.hasCheckoutHeldPendingForOrder(scope, orderId, now, tx)) {","        if (false as boolean) {")],T_I,'holds an approved checkout'),
 ('A-36',[(SPS,"        const held = await this.deps.payments.holdForCheckout(","        const held = true || await this.deps.payments.holdForCheckout(")],T_I,'holds an approved checkout'),
 ('A-37',[(GPS,"        new Date(now.getTime() + RECORDED_OUTCOME_RETRY_MS))","        null)")],T_I,'keeps a recorded late charge due'),
 ('A-38',[(SPS,"        } catch (error) {\n          this.deps.logger.warn(\n            {\n              paymentId: step.invoice.paymentId,","        } catch (error) {\n          throw error;\n          this.deps.logger.warn(\n            {\n              paymentId: step.invoice.paymentId,")],T_I,'keeps a recorded late charge due'),
 ('A-39',[(AD,"      invoiceId: `message:${chatId}:${sent.messageId}`,","      invoiceId: `message:${sent.messageId}`,")],T_U,'same message id'),
 ('A-40',[(PS,"            approval === 'RECORDED_PAYMENT'\n              ? ('GATEWAY_CALLBACK' as const)","            approval === 'RECORDED_PAYMENT'\n              ? ('GATEWAY_INQUIRY' as const)")],T_I,'holds an approved checkout'),
 ('A-41',[(TPL,"    definition.maxLength ?? TEMPLATE_BODY_MAX_LENGTH,\n","    TEMPLATE_BODY_MAX_LENGTH,\n")],T_U,'override Telegram would refuse'),
 ('A-42',[(WEB,"                    ...(row.gatewayInvoice.providerChargeId === null\n                      ? []","                    ...(true\n                      ? []")],T_WEB,'shows the charge id'),
 ('A-43',[(PR,"  return or(isNull(payments.checkoutHeldUntil), lte(payments.checkoutHeldUntil, now));","  return or(isNull(payments.checkoutHeldUntil));")],T_I,'once the checkout hold has lapsed'),
]

def build_contracts():
  subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True,check=True)

only=sys.argv[1:]
for mid,edits,(project,test),filt,*extra in M:
  sqlpair=extra[0] if extra else None
  if only and mid not in only: continue
  files=set(); ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a),flush=True); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  contracts=any(f.startswith('packages/contracts') for f in files)
  if ok:
    if contracts: build_contracts()
    if sqlpair: subprocess.run(['psql',os.environ['TEST_DATABASE_URL'],'-qc',sqlpair[0]],check=True)
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  if contracts: build_contracts()
  if ok and sqlpair: subprocess.run(['psql',os.environ['TEST_DATABASE_URL'],'-qc',sqlpair[1]],check=True)
