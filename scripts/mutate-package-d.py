"""Package D (custom service) mutation driver (docs/package-d-falsification.md).

Reverts one rule at a time, runs the named tests, and restores the file with `git checkout`.
Needs a clean tree and, for the integration rows, TEST_DATABASE_URL and REDIS_URL pointing
at a database no other suite is using (the integration suite truncates between tests).
Run it in a separate worktree, never the implementation checkout.
Usage: python3 scripts/mutate-package-d.py [D-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

CS='apps/api/src/modules/commerce/custom-service/'
DOM=CS+'domain/custom-service-pricing.ts'
PRICER=CS+'application/custom-service-pricer.ts'
ADMIN=CS+'application/custom-service-admin.service.ts'
FLOW=CS+'application/custom-service-flow.service.ts'
REPO=CS+'infrastructure/drizzle-custom-service.repository.ts'
C='apps/api/src/modules/commerce/'
ORD=C+'orders/application/order.service.ts'
PRC=C+'pricing/application/pricing.service.ts'
DISC=C+'pricing/infrastructure/drizzle-discount.repository.ts'
COM=C+'commercial/application/commercial-action.service.ts'
CAP=C+'customers/application/customer-capture.service.ts'
PROV=C+'provisioning/application/provisioner.service.ts'
RES=C+'resellers/application/reseller.service.ts'
REF=C+'payments/application/service-refund-request.service.ts'
RRF=C+'payments/infrastructure/drizzle-receipt-review-facts.reader.ts'
PRS=C+'pricing/application/pricing.service.ts'
DDOM=CS+'domain/custom-service-pricing.ts'

U=('unit','tests/unit/custom-service-pricing.test.ts')
I=('integration','tests/integration/custom-service.test.ts')

# (id, [(file, before, after)], test, name filter)
M=[
 ('D-01',[(DOM,"if (matches.length === 1) return { kind: 'SELECTED', rule: matches[0]!, level };","if (matches.length >= 1) return { kind: 'SELECTED', rule: matches[0]!, level };")],U,'refuses two matching rules at one level'),
 ('D-02',[(DOM,"  if (rule.resellerTierId !== subject.tierId) return null;\n","")],U,'never prices a reseller by the ordinary'),
 ('D-03',[(DOM,"        units <= rule.maxUnits &&","        units < rule.maxUnits &&")],U,'treats both bounds as inclusive'),
 ('D-04',[(DOM,"const half = CUSTOM_SERVICE_VOLUME_UNITS_PER_GB / 2n;","const half = 0n;")],U,'rounds the volume price'),
 ('D-05',[(DOM,"if (volume.rule.unitPrice.currency !== currency || time.rule.unitPrice.currency !== currency) {","if (false as boolean) {")],U,'another currency than the sales currency'),
 ('D-06',[(DOM,"    a.enabled &&\n    b.enabled &&\n","")],U,'admits an adjacent range'),
 ('D-07',[(DOM,"    a.panelId === b.panelId &&\n","")],U,'admits an adjacent range'),
 ('D-08',[(ADMIN,"assertNoOverlap({ id, ...write }, existing);","void existing;")],I,'refuses an overlapping enabled range'),
 ('D-09',[(ADMIN,"assertNoOverlap({ id: ruleId, ...write }, await this.deps.rules.list(scope, tx));","")],I,'refuses to ENABLE a disabled rule'),
 ('D-10',[(REPO,"sql`SELECT pg_advisory_xact_lock(${CUSTOM_SERVICE_RULES_LOCK_CLASS}","sql`SELECT pg_advisory_xact_lock_shared(${CUSTOM_SERVICE_RULES_LOCK_CLASS}")],I,'serialises two concurrent overlapping creates'),
 ('D-11',[(ADMIN,"unitPrice: money(input.unitPriceMinor, currency),","unitPrice: money(input.unitPriceMinor, 'USD'),")],I,'prices a rule in the sales currency'),
 ('D-12',[(PRICER,"if (location === null || !location.enabled) {","if (location === null) {")],I,'is unavailable on a location that is not offered'),
 ('D-13',[(PRICER,"if (!eligibility.eligible) return { kind: 'UNAVAILABLE', reason: 'PANEL_NOT_ELIGIBLE' };","void eligibility;")],I,'is unavailable on a location that is not offered'),
 ('D-14',[(PRICER,"return standing === null ? null : standing.tier.id;","return null;")],I,'prices an ACTIVE reseller by their tier'),
 ('D-15',[(PRC,"      request.purpose === 'CUSTOM_SERVICE'\n        ? null","      (false as boolean)\n        ? null")],I,'prices an ACTIVE reseller by their tier'),
 ('D-16',[(ORD,"          await this.assertCustomTermsHold(scope, locked, tx);\n","")],I,'refuses a confirmation whose rule was re-priced'),
 ('D-17',[(ORD,"      now.price.volumeRule.id === snapshot.volumeRuleId &&\n","")],I,'refuses a confirmation when a more specific rule'),
 ('D-18',[(ORD,"    const custom = await this.assertCustomServiceEnabled(scope, tx);\n    const snapshot","    const custom = this.deps.customService!;\n    const snapshot")],I,'refuses a confirmation while the feature is off'),
 ('D-19',[(ORD,"        const custom = await this.assertCustomServiceEnabled(scope, tx);\n","        const custom = this.deps.customService!;\n")],I,'refuses while the feature is off'),
 ('D-20',[(ORD,"          await this.deps.captures?.close(scope, input.captureId, 'RECEIVED', now, tx);\n","")],I,'reads the volume, keeps the window open'),
 ('D-21',[(CAP,"  'CUSTOM_SERVICE_VOLUME',\n  'CUSTOM_SERVICE_DAYS',\n];","];")],I,'reads the volume, keeps the window open'),
 ('D-22',[(ORD,"    if (order.purpose !== 'NEW_SERVICE' && order.purpose !== 'CUSTOM_SERVICE') {\n      throw errors.conflict(\n        COMMERCE_ERROR_CODES.DISCOUNT_CODE_REJECTED","    if (order.purpose !== 'NEW_SERVICE') {\n      throw errors.conflict(\n        COMMERCE_ERROR_CODES.DISCOUNT_CODE_REJECTED")],I,'applies a code that names CUSTOM_SERVICE'),
 ('D-23',[(ORD,"      before.purpose === 'CUSTOM_SERVICE'\n        ? await this.customBaseFromSnapshot(scope, before, now, tx)","      (false as boolean)\n        ? await this.customBaseFromSnapshot(scope, before, now, tx)")],I,'applies a code that names CUSTOM_SERVICE'),
 ('D-24',[(DISC,"inArray(orders.purpose, ['NEW_SERVICE', 'CUSTOM_SERVICE']),","eq(orders.purpose, 'NEW_SERVICE'),")],I,'counts a live custom order as a purchase'),
 ('D-25',[(COM,"    if (service.productId === null) return available;\n","")],I,'refuses to renew or extend'),
 ('D-26',[(COM,"    assertExtendable(service);\n    this.assertLifecycleAllows(kind, service);","    this.assertLifecycleAllows(kind, service);"),
          (COM,"        assertExtendable(service);\n        this.assertLifecycleAllows(input.kind, service);","        this.assertLifecycleAllows(input.kind, service);"),
          (COM,"    assertExtendable(service);\n    const product = await this.deps.products.findById(","    const product = await this.deps.products.findById(")],I,'refuses to renew or extend'),
 ('D-27',[(PROV,"  CUSTOM_SERVICE: 'PROVISION',","  CUSTOM_SERVICE: 'RENEW',")],I,'promises cashback at confirmation and earns it at delivery'),
 ('D-28',[(RES,"    if (order.purpose === 'CUSTOM_SERVICE') return;\n","")],I,'prices an ACTIVE reseller by their tier'),
 ('D-29',[(REF,"    if (order.purpose !== 'NEW_SERVICE' && order.purpose !== 'CUSTOM_SERVICE') {\n      return { eligible: false, reason: 'NO_PAID_SOURCE' };","    if (order.purpose !== 'NEW_SERVICE') {\n      return { eligible: false, reason: 'NO_PAID_SOURCE' };")],I,'lets a paid custom service be the source'),
 ('D-30',[(RRF,"if (purpose === 'NEW_SERVICE' || purpose === 'CUSTOM_SERVICE') {","if (purpose === 'NEW_SERVICE') {")],I,'names the reserved username'),
 ('D-31',[(FLOW,"      !(await this.deps.pricer.volumePriceable(scope, capture.customerId, capture.subjectId, units))","      false")],I,'refuses a volume no rule prices'),
 ('D-32',[(REPO,"          eq(customServiceLocations.tenantId, tenantId),\n          eq(customServiceLocations.panelId, panelId),\n        ),\n      )\n      .limit(1);","          eq(customServiceLocations.panelId, panelId),\n        ),\n      )\n      .limit(1);")],I,'never lets another tenant'),
 # Codex on PR #88
 ('D-33',[(PRS,"    if (applied.length === 0 && countsAsPurchase) {\n      await this.deps.discounts.lockFirstPurchase(scope, order.customerId, tx);\n    }\n","")],I,'queues an undiscounted custom confirmation on the first-purchase lock'),
 ('D-34',[(PRS,"      if (firstPurchaseRule || countsAsPurchase) {","      if (firstPurchaseRule) {")],I,'queues a discounted custom confirmation on the first-purchase lock too'),
 ('D-35',[(ORD,"      { panelEligibility: 'SKIP' },\n","")],I,'answers a panel that filled up after the quote as unavailable'),
 ('D-36',[(ADMIN,"    if (!ruleAmountFits(input.maxUnits, input.unitPriceMinor)) {","    if (false as boolean) {")],I,'refuses a price that cannot be carried across its range'),
 ('D-37',[(DDOM,"  return maxUnits * unitPriceMinor <= CUSTOM_SERVICE_RULE_AMOUNT_CEILING;","  return maxUnits * unitPriceMinor < CUSTOM_SERVICE_RULE_AMOUNT_CEILING;")],U,'admits exactly the ceiling'),
]

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
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
