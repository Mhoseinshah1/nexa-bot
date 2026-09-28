"""Package F (service transfer) mutation driver (docs/package-f-falsification.md).

Reverts one rule at a time, runs the named tests, and restores the file with `git checkout`.
Needs a clean tree and, for the integration rows, TEST_DATABASE_URL and REDIS_URL pointing
at a database no other suite is using (the integration suite truncates between tests).
Run it in a separate worktree, never the implementation checkout.

A row that mutates the migration drops and recreates that database before its run and again
after the restore: the migrator records a migration as applied and never re-reads it, so a
mutated trigger is only seen by a database that has never had the real one.
Usage: python3 scripts/mutate-package-f.py [F-01 ...]
"""
import subprocess, sys, os, re
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

PROV='apps/api/src/modules/commerce/provisioning/'
SVC=PROV+'application/service-transfer.service.ts'
REPO=PROV+'infrastructure/drizzle-service-transfer.repository.ts'
PS=PROV+'application/provisioning.service.ts'
MSG='apps/api/src/modules/commerce/messaging/'
CNS=MSG+'application/customer-notification.service.ts'
SUBJ=MSG+'infrastructure/drizzle-notification-subject.reader.ts'
BOT='apps/api/src/surfaces/telegram/bot-runtime.ts'
CON='packages/contracts/src/service-transfer.ts'
MIG='apps/api/drizzle/0130_package_f_service_transfer.sql'

U=('unit','tests/unit/service-transfer.test.ts')
I=('integration','tests/integration/service-transfer.test.ts')

# (id, [(file, before, after)], test, name filter)
M=[
 # F3 — one evaluator decides whether a service may change hands
 ('F-01',[(SVC,"    if (!(SERVICE_TRANSFERABLE_STATES as readonly string[]).includes(service.state)) {\n      return 'SERVICE_STATE';\n    }\n","")],U,'refuses a service that is'),
 ('F-02',[(SVC,"    if (service.deliveryState !== 'DELIVERED') return 'NOT_DELIVERED';\n","")],U,'rather than DELIVERED'),
 ('F-03',[(SVC,"    if (order.purpose === 'TRIAL') return 'TRIAL';\n","")],I,'refuses a trial, and draws no button'),
 ('F-04',[(SVC,"    if (await this.deps.repository.operationUndecided(scope, service.id, tx)) {\n      return 'OPERATION_PENDING';\n    }\n","")],I,'planned to terminate'),
 ('F-05',[(SVC,"    if (await this.deps.services.hasActiveRefundRequest(scope, service.id, tx)) {\n      return 'REFUND_REQUESTED';\n    }\n","")],I,'OPEN refund request'),
 ('F-06',[(SVC,"    if (await this.deps.repository.commercialPaymentPending(scope, service.id, tx)) {\n      return 'PAYMENT_PENDING';\n    }\n","")],I,'paid renewal not yet applied'),
 ('F-07',[(CON,"export const SERVICE_TRANSFERABLE_STATES = ['ACTIVE', 'SUSPENDED'] as const;","export const SERVICE_TRANSFERABLE_STATES = ['ACTIVE'] as const;")],I,'transfers a SUSPENDED service'),
 ('F-08',[(REPO,"            ne(provisioningOperations.type, 'SYNC_USAGE'),\n","            isNotNull(provisioningOperations.id),\n")],I,'lets a SCHEDULED usage read through'),
 ('F-09',[(REPO,"            isNotNull(provisioningOperations.requestedByCustomerId),\n","")],I,'planned to terminate'),
 ('F-10',[(REPO,"          eq(orders.state, 'AWAITING_PAYMENT'),","          eq(orders.state, 'DRAFT'),")],I,'paid renewal not yet applied'),
 # The transfer: re-decided under both locks
 ('F-11',[(SVC,"        const locked = await this.deps.services.lockForUpdate(scope, serviceId.data, tx);","        const locked = await this.deps.services.findById(scope, serviceId.data, tx);")],I,'loses to a terminate'),
 ('F-12',[(SVC,"        await this.deps.services.lockLifecycle(scope, locked.id, tx);\n","")],I,'takes the lifecycle lock'),
 ('F-13',[(SVC,"        const reason = await this.ineligibilityOf(scope, service, tx);\n        if (reason !== null) {","        const reason = null as ServiceTransferIneligibilityReason | null;\n        if (reason !== null) {")],I,'loses to a terminate'),
 ('F-14',[(SVC,"  if (recipient.id === senderId) return 'RECIPIENT_SELF';\n","")],I,'refuses a transfer to oneself'),
 ('F-15',[(SVC,"  if (recipient.status !== 'ACTIVE') return 'RECIPIENT_BLOCKED';\n","")],I,'refuses a blocked recipient'),
 ('F-16',[(SVC,"        if (sender.status !== 'ACTIVE') {","        if ((false as boolean) && sender.status !== 'ACTIVE') {")],I,'refuses a sender who has been blocked'),
 ('F-17',[(SVC,"        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {","        if ((false as boolean) && !(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {")],I,'stopped accepting work'),
 # F8 — idempotency
 ('F-18',[(SVC,"        if (replayed !== null) {\n          if (","        if (replayed !== null && (false as boolean)) {\n          if (")],I,'answers a replayed key'),
 ('F-19',[(SVC,"          if (replayed.serviceId !== input.serviceId || replayed.fromCustomerId !== sender.id) {","          if ((false as boolean) && (replayed.serviceId !== input.serviceId || replayed.fromCustomerId !== sender.id)) {")],I,'answers a replayed key'),
 ('F-20',[(SVC,"            newest !== null &&\n            recipient !== null &&\n            newest.fromCustomerId === sender.id &&\n            newest.toCustomerId === recipient.id\n","            (false as boolean)\n")],I,'double tap'),
 ('F-21',[(SVC,"            newest.fromCustomerId === sender.id &&\n            newest.toCustomerId === recipient.id\n","            newest.fromCustomerId === sender.id\n")],I,'two recipients'),
 ('F-22',[(REPO,"      .orderBy(desc(serviceOwnershipTransfers.seq))","      .orderBy(asc(serviceOwnershipTransfers.seq))"),(REPO,"import { and, desc,","import { and, asc, desc,")],I,'given back'),
 # F4/F5 — what moves, and what is written beside it
 ('F-23',[(REPO,".set({ customerId: input.toCustomerId, customerNote: null, updatedAt: input.now })",".set({ customerId: input.toCustomerId, updatedAt: input.now })")],I,'clears the sender'),
 ('F-24',[(SVC,"        await this.deps.audit.record(\n          scope,\n          actor,\n          {\n            action: 'service.transfer',","        if ((false as boolean)) await this.deps.audit.record(\n          scope,\n          actor,\n          {\n            action: 'service.transfer',")],I,'confirmed with the brief'),
 ('F-25',[(SVC,"        await this.deps.outbox.write(tx, actor, {\n          eventType: 'ServiceOwnershipTransferred',","        if ((false as boolean)) await this.deps.outbox.write(tx, actor, {\n          eventType: 'ServiceOwnershipTransferred',")],I,'confirmed with the brief'),
 ('F-26',[(SVC,"        await this.deps.notifier.notify(\n          scope,\n          recipient.id,","        if ((false as boolean)) await this.deps.notifier.notify(\n          scope,\n          recipient.id,")],I,'tells the recipient through the dispatcher'),
 # F6 — the recipient's notification
 ('F-27',[(SUBJ,"            eq(services.customerId, serviceOwnershipTransfers.toCustomerId),\n","")],I,'supersedes the notification'),
 ('F-28',[(SUBJ,"  'SERVICE_PROVISION_DELAYED',\n  'SERVICE_TRANSFER_RECEIVED',\n];","  'SERVICE_PROVISION_DELAYED',\n];")],I,'supersedes the notification'),
 ('F-29',[(CNS,"        buttons: this.deps.buttonsFor?.(row.kind, { serviceId: facts.serviceId }) ?? [],","        buttons: [],")],I,'tells the recipient through the dispatcher'),
 # A payer who no longer owns the service
 ('F-30',[(PS,"    if (service.customerId !== action.customerId) {\n      return refuse(","    if ((false as boolean) && service.customerId !== action.customerId) {\n      return refuse(")],I,'refuses to settle the old owner'),
 ('F-31',[(PS,"    if (service.customerId !== action.customerId) {\n      return refuse(","    if ((false as boolean) && service.customerId !== action.customerId) {\n      return refuse(")],I,'refunds the old owner'),
 # The bot
 ('F-32',[(BOT,"    if ((await this.deps.serviceTransfers?.offered(scope, service)) === true) {","    if (this.deps.serviceTransfers !== undefined) {")],I,'refuses a trial, and draws no button'),
 ('F-33',[(BOT,"      await this.deps.captures.open(scope, actor, {\n        idempotencyKey: `${input.idempotencyKey}:transfer-reopen`,","      if ((false as boolean)) await this.deps.captures.open(scope, actor, {\n        idempotencyKey: `${input.idempotencyKey}:transfer-reopen`,")],I,'keeping the window open'),
 # The database's own rules (migration 0130)
 ('F-34',[(MIG,"    IF newest_from IS DISTINCT FROM OLD.customer_id OR newest_to IS DISTINCT FROM NEW.customer_id THEN","    IF false THEN")],I,'refuses a change of owner with no transfer row'),
 ('F-35',[(MIG,"    IF newest_from IS DISTINCT FROM OLD.customer_id OR newest_to IS DISTINCT FROM NEW.customer_id THEN","    IF newest_from IS NULL THEN")],I,'refuses a change of owner with no transfer row'),
 ('F-36',[(MIG,"     ORDER BY seq DESC\n     LIMIT 1;\n    IF newest_from","     ORDER BY seq ASC\n     LIMIT 1;\n    IF newest_from")],I,'given back'),
 ('F-37',[(MIG,"  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN","  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN")],I,'refuses a change of the order'),
 ('F-38',[(MIG,"    IF order_customer IS NOT NULL AND order_customer <> NEW.customer_id THEN","    IF false THEN")],I,'refuses a service written for a customer other than'),
 ('F-39',[(MIG,"  IF owner IS NOT NULL AND owner <> NEW.customer_id THEN","  IF false THEN")],I,'refuses a commercial action written for'),
 ('F-40',[(MIG,"CREATE TRIGGER service_ownership_transfers_no_update\n  BEFORE UPDATE ON service_ownership_transfers\n  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint\n","")],I,'append-only'),
 ('F-41',[(MIG,"CREATE TRIGGER service_ownership_transfers_no_delete\n  BEFORE DELETE ON service_ownership_transfers\n  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();","SELECT 1;")],I,'append-only'),
]

def fresh_db():
  url=os.environ.get('TEST_DATABASE_URL','')
  m=re.match(r'^(.*/)([^/?]+)$',url)
  if not m: sys.exit('TEST_DATABASE_URL must name a database for a migration row')
  admin=m.group(1)+'postgres'; name=m.group(2)
  subprocess.run(['psql',admin,'-qc',f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)','-c',f'CREATE DATABASE "{name}"'],check=True,capture_output=True)

only=sys.argv[1:]
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  files=set(); ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a),flush=True); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  # `@nexa/contracts` resolves to its dist, so a contract mutation is rebuilt to be seen.
  contracts=any(f.startswith('packages/contracts/') for f in files)
  migration=any(f.startswith('apps/api/drizzle/') for f in files)
  build=['pnpm','--filter','@nexa/contracts','build']
  if ok and contracts: subprocess.run(build,capture_output=True)
  if ok and migration: fresh_db()
  if ok:
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  if contracts: subprocess.run(build,capture_output=True)
  if migration: fresh_db()
