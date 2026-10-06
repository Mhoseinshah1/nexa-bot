"""Phase 2 item 5 (panel tutorial after delivery) mutation driver
(docs/phase2/item5-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
A mutant counts as killed only when the named test RAN and failed. Mutants in
packages/contracts rebuild the package before the run and again after the restore, because
the tests resolve `@nexa/contracts` from its dist.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL and DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-p2-item5.py [D5-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

SENDER='apps/api/src/modules/control/client-apps/application/delivery-tutorial-sender.ts'
ADMIN='apps/api/src/modules/control/client-apps/application/delivery-tutorial.service.ts'
REPO='apps/api/src/modules/control/client-apps/infrastructure/drizzle-delivery-tutorial.repository.ts'
DELIVERY='apps/api/src/modules/commerce/provisioning/application/delivery.service.ts'
CONTAINER='apps/api/src/container.ts'
CONTRACT='packages/contracts/src/delivery-tutorial.ts'
WEB='apps/web/src/pages/delivery-tutorial.tsx'
T_U=('unit','tests/unit/delivery-tutorial.test.ts')
T_P=('unit','tests/unit/delivery-tutorial-premium.test.ts')
T_I=('integration','tests/integration/delivery-tutorial.test.ts')
T_W=('web','tests/web/delivery-tutorial.test.tsx')

M=[
 # DISABLED sends nothing, though it keeps its text: the mode gate removed AND the kept text
 # treated as sendable. (The gate alone is defence in depth: removing only it is an
 # equivalent mutant, because DISABLED sends neither text nor video — see the record.)
 ('D5-01',[(SENDER,"if (tutorial === null || tutorial.mode === 'DISABLED') return { kind: 'NONE' };","if (tutorial === null) return { kind: 'NONE' };"),
           (SENDER,"      deliveryTutorialSendsText(tutorial.mode) && tutorial.text !== null","      (tutorial.mode === 'DISABLED' || deliveryTutorialSendsText(tutorial.mode)) &&\n      tutorial.text !== null")],T_U,'DISABLED tutorial'),
 # The same, end to end: a tutorial switched off after it had text sends nothing.
 ('D5-31',[(SENDER,"if (tutorial === null || tutorial.mode === 'DISABLED') return { kind: 'NONE' };","if (tutorial === null) return { kind: 'NONE' };"),
           (SENDER,"      deliveryTutorialSendsText(tutorial.mode) && tutorial.text !== null","      (tutorial.mode === 'DISABLED' || deliveryTutorialSendsText(tutorial.mode)) &&\n      tutorial.text !== null")],T_I,'DISABLED tutorial'),
 # A purchase-only tutorial is not sent for a trial (applicability ignored).
 ('D5-02',[(SENDER,"    if (!(service.isTrial ? tutorial.appliesToTrial : tutorial.appliesToPurchase)) {\n      return { kind: 'NONE' };\n    }\n","")],T_U,'purchase-only'),
 # Trial and purchase are not swapped.
 ('D5-03',[(SENDER,"service.isTrial ? tutorial.appliesToTrial : tutorial.appliesToPurchase","service.isTrial ? tutorial.appliesToPurchase : tutorial.appliesToTrial")],T_U,'trial-only'),
 # The same, end to end (a trial-only tutorial after a real trial delivery).
 ('D5-04',[(SENDER,"service.isTrial ? tutorial.appliesToTrial : tutorial.appliesToPurchase","service.isTrial ? tutorial.appliesToPurchase : tutorial.appliesToTrial")],T_I,'trial delivery'),
 # A claimed service sends nothing (the claim's answer ignored).
 ('D5-05',[(SENDER,"return fresh ? ('CLAIMED' as const) : ('DUPLICATE' as const);","return fresh || true ? ('CLAIMED' as const) : ('DUPLICATE' as const);")],T_U,'replay sends nothing'),
 # The claim is per service, not one key for every service.
 ('D5-06',[(SENDER,"        deliveryTutorialClaimKey(service.id),\n","        deliveryTutorialClaimKey('every-service'),\n")],T_U,'own tutorial'),
 # The tenant's activity is read inside the claim's transaction.
 ('D5-07',[(SENDER,"      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'STOPPED' as const;\n","")],T_U,'stopped tenant'),
 # VIDEO_TEXT's caption is whole-or-nothing (captionWhole dropped).
 ('D5-08',[(SENDER,"      captionWhole: true,\n","")],T_U,'that fits'),
 # Too long: the bare video is still sent before the text.
 ('D5-09',[(SENDER,"      const bare = await bareVideo(video.fileId);\n","      const bare = 'DELIVERED' as string;\n")],T_U,'too long for a caption: the bare video'),
 # Too long: the text follows whole (not dropped).
 ('D5-10',[(SENDER,"arrangement: 'VIDEO_THEN_TEXT', outcome: await asText() };","arrangement: 'VIDEO_THEN_TEXT', outcome: 'DELIVERED' };")],T_U,'too long'),
 # UNKNOWN / RATE_LIMITED are not followed by the text (no retry in another shape).
 ('D5-11',[(SENDER,"if (captioned.outcome !== 'REFUSED') {","if (captioned.outcome === 'DELIVERED') {")],T_U,'neither retried'),
 # Too long, bare video RATE_LIMITED: the text is not burst into the same per-chat limit.
 ('D5-32',[(SENDER,"      if (bare === 'RATE_LIMITED') {","      if (bare === 'RATE_LIMITED' && false) {")],T_U,'bare video is RATE_LIMITED'),
 # A video Telegram refuses still lets the text go.
 ('D5-12',[(SENDER,"    // Telegram refused the video itself: the text still goes, whole.\n    return { kind: 'SENT', arrangement: 'TEXT', outcome: await asText() };","    return { kind: 'SENT', arrangement: 'TEXT', outcome: 'REFUSED' };")],T_U,'Telegram refuses'),
 # Nothing this bot can send: no claim, no send.
 ('D5-13',[(SENDER,"    if (text === '' && video === null) return { kind: 'NONE' };\n","")],T_U,'claims nothing'),
 # The text is drawn by the client-app guide renderer.
 ('D5-14',[(SENDER,"        ? renderClientAppGuide(tutorial.text)\n","        ? tutorial.text\n")],T_U,'guide renderer'),
 # The text goes through the tutorial template key.
 ('D5-15',[(SENDER,"export const DELIVERY_TUTORIAL_TEMPLATE_KEY = 'bot.service.delivery_tutorial' as const;","export const DELIVERY_TUTORIAL_TEMPLATE_KEY = 'bot.faq.page' as const;")],T_P,'premium emoji'),
 # The sweep: never for a rotation's new link.
 ('D5-16',[(DELIVERY,"          if (!rotated)\n            await this.sendTutorialAfter(","          if (true)\n            await this.sendTutorialAfter(")],T_U,'rotation'),
 # The sweep: the tutorial comes after the files, not before them.
 ('D5-17',[(DELIVERY,"          await this.sendFilesAfter(scope, service, record.sentTo ?? lookup.contact);\n          // Phase 2 item 5: the panel's tutorial, after the files — a first delivery only.\n          if (!rotated)\n            await this.sendTutorialAfter(scope, service, record.sentTo ?? lookup.contact);\n","          if (!rotated)\n            await this.sendTutorialAfter(scope, service, record.sentTo ?? lookup.contact);\n          await this.sendFilesAfter(scope, service, record.sentTo ?? lookup.contact);\n")],T_U,'after the files'),
 # The sweep: a throwing tutorial is swallowed.
 ('D5-18',[(DELIVERY,"    } catch {\n      // Deliberately swallowed: the link is delivered and recorded; a tutorial is a courtesy.\n      return;\n    }","    } finally {\n      // mutant: the error escapes\n    }")],T_U,'throws'),
 # The container wires the sweep to the sender.
 ('D5-19',[(CONTAINER,"      afterDelivery: (scope, service, contact) =>\n        deliveryTutorialSender.afterDelivery(scope, service, contact),","      afterDelivery: async () => undefined,")],T_I,'paid delivery'),
 # The claim is the idempotency store's durable insert — end to end, a re-armed delivery.
 ('D5-20',[(SENDER,"return fresh ? ('CLAIMED' as const) : ('DUPLICATE' as const);","return fresh || true ? ('CLAIMED' as const) : ('DUPLICATE' as const);")],T_I,'paid delivery'),
 # Admin: a stale revision is refused.
 ('D5-21',[(ADMIN,"        if (command.expectedRevision !== revision) {","        if (command.expectedRevision !== revision && false) {")],T_I,'stale revision'),
 # Admin: a write is audited with its values.
 ('D5-22',[(ADMIN,"        await this.deps.audit.record(\n          scope,\n          actor,\n          {\n            action: 'panel.delivery_tutorial_update',","        await (async (..._a: unknown[]) => undefined)(\n          scope,\n          actor,\n          {\n            action: 'panel.delivery_tutorial_update',")],T_I,'audits'),
 # Admin: a newly named video app must be this tenant's.
 ('D5-23',[(ADMIN,"          (await this.deps.apps.find(scope, submitted.videoClientAppId, tx)) === null","          false")],T_I,'video app'),
 # Repository: every read names the tenant.
 ('D5-24',[(REPO,"      .where(and(eq(deliveryTutorials.tenantId, tenantId), eq(deliveryTutorials.panelId, panelId)))","      .where(eq(deliveryTutorials.panelId, panelId))")],T_I,'tenant-scoped'),
 # Repository: the video options count the bots that hold the video.
 ('D5-25',[(REPO,"      botsWithVideo: Number(row.botsWithVideo),","      botsWithVideo: 0,")],T_I,'VIDEO_TEXT'),
 # Contract: raw markup (<tg-emoji>) is refused.
 ('D5-26',[(CONTRACT,"  const problem = clientAppTextProblem(value);\n  if (problem !== null) return problem;\n","")],T_U,'raw markup'),
 # Contract: an unknown icon marker is refused.
 ('D5-27',[(CONTRACT,"    if (!isAppearanceSlot(slot)) return 'UNKNOWN_ICON';","    if (!isAppearanceSlot(slot)) continue;")],T_U,'raw markup'),
 # Contract: a mode that sends text needs the text.
 ('D5-28',[(CONTRACT,"    if (deliveryTutorialSendsText(body.mode) && body.text === null) {","    if (false && body.text === null) {")],T_U,'without what it sends'),
 # Web: the draft refuses a mode without its text.
 ('D5-29',[(WEB,"  } else if (deliveryTutorialSendsText(draft.mode)) {","  } else if (false) {")],T_W,'refuses a draft'),
 # Web: the caption-fallback notice measures markers as their one emoji, like the server.
 ('D5-33',[(WEB,"  const captionLength = withMarkersAsFallback(rendered).length;","  const captionLength = rendered.length;")],T_W,'caption fallback'),
 # Web: a partial edit keeps the text the mode does not use.
 ('D5-30',[(WEB,"      text: text === '' ? null : text,","      text: text === '' || !deliveryTutorialSendsText(draft.mode) ? null : text,")],T_W,'partial edit'),
]

def build_contracts():
  subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True,check=True)

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
  contracts=any(f.startswith('packages/contracts') for f in originals)
  try:
    if ok:
      if contracts: build_contracts()
      ran+=1
      r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
      out=r.stdout+r.stderr
      failed=[l.strip() for l in out.splitlines() if '×' in l]
      summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
      ran_any=any('passed' in l or 'failed' in l for l in summ)
      if r.returncode!=0 and ran_any: killed+=1
      print(mid,'KILLED' if (r.returncode!=0 and ran_any) else 'SURVIVED',summ,failed[:2],flush=True)
  finally:
    # Restored whatever happened above — an interrupt, a failed build, a crashed runner.
    for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
    if contracts: build_contracts()
print(f'{killed} of {ran} killed',flush=True)
