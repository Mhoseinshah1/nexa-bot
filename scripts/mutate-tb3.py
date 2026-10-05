"""TB3 (the support context) mutation driver (docs/support-agent/tb3-falsification.md).

Reverts one load-bearing rule at a time, runs the named test, and restores the file with
`git checkout`. A mutation of `packages/contracts` rebuilds it before its test and again
after the restore. Needs a clean tree and an integration database of its own:
  TEST_DATABASE_URL=postgres://nexa:nexa@127.0.0.1:5432/nexa_test_tb3 python3 scripts/mutate-tb3.py
Usage: python3 scripts/mutate-tb3.py [TB3-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

READER='apps/api/src/modules/commerce/support-context/infrastructure/drizzle-support-context.reader.ts'
BUILDER='apps/api/src/modules/commerce/support-context/application/support-context.builder.ts'
DOMAIN='apps/api/src/modules/commerce/support-context/domain/support-context-payload.ts'
SERVICES='apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository.ts'
CONTRACT='packages/contracts/src/support-context.ts'
T_I=('integration','tests/integration/support-context.test.ts')
T_U=('unit','tests/unit/support-context-payload.test.ts')

M=[
 # The customer filter: another customer's orders join the context.
 ('TB3-01',[(READER,"          eq(orders.customerId, customerId),\n","")],T_I,'gives the exact customer'),
 # The tenant filter on payments: the right customer id under the wrong tenant reads rows.
 ('TB3-02',[(READER,"and(eq(payments.tenantId, tenantId), eq(payments.customerId, customerId))","eq(payments.customerId, customerId)")],T_I,'every reader puts the tenant'),
 # The tenant filter on incidents.
 ('TB3-03',[(READER,"       WHERE i.tenant_id = ${tenantId}\n","       WHERE ${tenantId}::uuid IS NOT NULL\n")],T_I,'every reader puts the tenant'),
 # The refunded-away filter (WP19), in the one customer page the builder reads.
 # (Review: re-anchored on `supportServicesForCustomer`, the read the builder now makes.)
 ('TB3-04',[(SERVICES,"          notRefundedAway(),\n        ),\n      )\n      .orderBy(\n        sql`CASE","        ),\n      )\n      .orderBy(\n        sql`CASE")],T_I,'refunded away'),
 # underReview: the customer-signal arm of PENDING dropped.
 ('TB3-05',[(READER,"        AND (${payments.customerSignalledAt} IS NOT NULL\n             OR ${payments.providerReviewStartedAt} IS NOT NULL))","        AND (${payments.providerReviewStartedAt} IS NOT NULL))")],T_I,'under review: UNKNOWN'),
 # underReview: the UNKNOWN arm dropped.
 ('TB3-06',[(READER,"    ${paymentOpsQueueCondition('UNKNOWN')}\n    OR (","    false\n    OR (")],T_I,'under review: UNKNOWN'),
 # The flag over ALL payments becomes the first row's own verdict.
 # (Review item 9: the flag is now its own LIMIT 1 statement; reverted to the shown rows' verdict.)
 ('TB3-07',[(READER,"      anyUnderReview: anyRows.length > 0,","      anyUnderReview: rows.some((row) => row.underReview === true),")],T_I,'reads ALL payments'),
 # The allowlist: the contract admits a subscription URL and the builder emits it.
 ('TB3-08',[(CONTRACT,"    hasSubscriptionLink: z.boolean(),\n","    hasSubscriptionLink: z.boolean(),\n    subscriptionUrl: z.string().nullable(),\n"),
            (BUILDER,"    unreconciled: service.state === 'UNRECONCILED',\n","    unreconciled: service.state === 'UNRECONCILED',\n    subscriptionUrl: service.subscriptionUrl,\n")],T_I,'gives the exact customer'),
 # The allowlist, builder only: the strict parse must refuse the extra key.
 ('TB3-09',[(BUILDER,"    unreconciled: service.state === 'UNRECONCILED',\n","    unreconciled: service.state === 'UNRECONCILED',\n    ...({ subscriptionUrl: service.subscriptionUrl } as object),\n")],T_I,'gives the exact customer'),
 # Null customer: the public payload claims an identity.
 ('TB3-10',[(BUILDER,"            identityLinked: false,\n","            identityLinked: true,\n")],T_I,'customerId null'),
 # Null customer: account readers are consulted anyway (the public branch removed).
 ('TB3-11',[(BUILDER,"    if (customer === null) {\n","    if (customer === null && customerId === 'never') {\n")],T_U,'a null customer gets public support only'),
 # Incident matching: a location target matches whatever panel it is on.
 ('TB3-12',[(READER,"                                   AND l.panel_id = s.panel_id))))","                                   ))))")],T_I,'agrees with the notice audience'),
 # Truncation drops from the HEAD of a family instead of the tail.
 ('TB3-13',[(DOMAIN,"current[family].slice(0, -1)","current[family].slice(1)")],T_U,'drops whole entries from the tail'),
 # --- Substitute review of PR #198 -----------------------------------------------------
 # 1. References built from every id, not from the aliases that survived the byte budget.
 ('TB3-14',[(BUILDER,"        services: survivingReferences('S', ids.services, parsed.services),","        services: new Map(ids.services.map((id, index) => [aliasFor('S', index), id])),")],T_I,'references hold only the aliases'),
 # 2. The incident match's customer filter.
 ('TB3-15',[(READER,"              AND s.customer_id = ${customerId}\n","              AND ${customerId}::uuid IS NOT NULL\n")],T_I,'reaches only the customer with a live service'),
 # 3. The live-state rule of the incident match.
 ('TB3-16',[(READER,"              AND s.state IN ('ACTIVE', 'SUSPENDED')\n","")],T_I,'agrees with the notice audience'),
 # 4a. PARTIAL/LATE_COMPLETION on a CONFIRMED payment.
 ('TB3-17',[(READER,"        AND ${payments.state} <> 'CONFIRMED'\n","")],T_I,'gateway facets'),
 # 4b. The provider-review half of the PENDING arm.
 ('TB3-18',[(READER,"        AND (${payments.customerSignalledAt} IS NOT NULL\n             OR ${payments.providerReviewStartedAt} IS NOT NULL))","        AND (${payments.customerSignalledAt} IS NOT NULL))")],T_I,'gateway facets'),
 # 4c. A refund already started takes the payment out of review.
 ('TB3-19',[(READER,"        AND NOT ${paymentOpsQueueCondition('REFUND_RELATED')})","        )")],T_I,'gateway facets'),
 # 5. The DRAFT exclusion.
 ('TB3-20',[(READER,"          ne(orders.state, 'DRAFT'),\n","")],T_I,'a DRAFT is not in the context'),
 # 6. The client-app relevance filter.
 ('TB3-21',[(BUILDER,"row.status === 'ENABLED' && isClientAppRelevant(row, facts)","row.status === 'ENABLED'")],T_I,'restricted to another provider'),
 # 8. The order filter of the service-card facts.
 ('TB3-22',[(READER,"o.tenant_id = ${tenantId} AND o.customer_id = ${customerId} AND o.id","o.tenant_id = ${tenantId} AND o.id")],T_I,'own order for a title'),
 # 11. Live services first in the bounded read.
 ('TB3-23',[(SERVICES,"        sql`CASE WHEN ${services.state} = 'TERMINATED' THEN 1 ELSE 0 END`,\n","")],T_I,'live services come first'),
]

def build(pkg):
  subprocess.run(['pnpm','--filter',pkg,'build'],capture_output=True,check=True)

def rebuild(files):
  if any(f.startswith('packages/contracts') for f in files):
    build('@nexa/contracts'); build('@nexa/i18n')

only=sys.argv[1:]
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  files=set(); ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a),flush=True); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  if ok:
    rebuild(files)
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  rebuild(files)
