"""Roadmap C1-C4 (campaign & broadcast) mutation driver (docs/campaign-broadcast-readiness.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
Integration mutants need the database; set TEST_DATABASE_URL and DATABASE_URL to a database
of your own if another suite is running.
Usage: python3 scripts/mutate-campaign-broadcast.py [CB-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

REPO='apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository.ts'
SVC='apps/api/src/modules/commerce/broadcasts/application/broadcast.service.ts'
PAGE='apps/web/src/pages/broadcasts.tsx'
CPAGE='apps/web/src/pages/campaigns.tsx'
T_R=('integration','tests/integration/broadcast-readiness.test.ts')
T_B=('integration','tests/integration/broadcasts.test.ts')
T_W=('web','tests/web/broadcast-readiness.test.tsx')
T_CW=('web','tests/web/campaigns.test.tsx')
AUD='apps/api/src/modules/commerce/audience/infrastructure/audience-sql.ts'
CSVC='apps/api/src/modules/commerce/campaigns/application/campaign.service.ts'
CREPO='apps/api/src/modules/commerce/campaigns/infrastructure/drizzle-campaign.repository.ts'
T_AB=('integration','tests/integration/audience-bots.test.ts')
T_C=('integration','tests/integration/campaigns.test.ts')

M=[
 # Opt-out authority: the stamp re-reads the preference in its own transaction, so a refused
 # recipient who opted out before the re-queue is SKIPPED, never sent.
 ('CB-01',[(REPO,"    if (input.marketing) {","    if (false) {")],T_R,'opts out before the re-queue'),
 # Frozen identity / per-bot routing: a recipient is sent through the bot frozen on its row,
 # never the customer's current bot.
 ('CB-02',[(REPO,"     RETURNING r.broadcast_id, r.customer_id, r.bot_instance_id, r.chat_id, r.attempts`);",
   "     RETURNING r.broadcast_id, r.customer_id,\n               (SELECT c.first_bot_instance_id FROM customers c WHERE c.tenant_id = r.tenant_id AND c.id = r.customer_id) AS bot_instance_id,\n               r.chat_id, r.attempts`);")],T_R,'own FROZEN bot'),
 # Frozen audience: the launch freezes exactly the set the preview counted; a newcomer
 # between the preview and the confirmation refuses the launch rather than joining it.
 ('CB-11',[(SVC,"          frozen.count !== input.expectedRecipients ||\n          frozen.fingerprint !== input.expectedFingerprint\n","          false\n")],T_B,'freezes exactly the previewed audience'),
 # No duplicate on re-queue: only FAILED goes back; an UNCONFIRMED one may have arrived.
 ('CB-03',[(REPO,"AND broadcast_id = ${id}::uuid AND state = 'FAILED'","AND broadcast_id = ${id}::uuid AND state IN ('FAILED', 'UNCONFIRMED')")],T_R,'re-sends only the refusals'),
 # ...and never an in-flight (SENDING) one.
 ('CB-04',[(REPO,"AND broadcast_id = ${id}::uuid AND state = 'FAILED'","AND broadcast_id = ${id}::uuid AND state IN ('FAILED', 'SENDING')")],T_R,'re-sends only the refusals'),
 # A 429 holds only the bot that got it.
 ('CB-05',[(REPO,"""             updated_at = ${now.toISOString()}::timestamptz
       WHERE tenant_id = ${tenantId}::uuid AND bot_instance_id = ${botInstanceId}::uuid`);
  }

  async completeFinished""","""             updated_at = ${now.toISOString()}::timestamptz
       WHERE tenant_id = ${tenantId}::uuid`);
  }

  async completeFinished""")],T_R,'holds the bot that got it'),
 # The per-bot read groups by the FROZEN bot on the recipient row.
 ('CB-06',[(REPO,"                   ON bi.tenant_id = r.tenant_id AND bi.id = r.bot_instance_id\n","                   ON bi.tenant_id = r.tenant_id AND bi.id = r.bot_instance_id AND false\n")],T_R,'counts the delivery per bot'),
 # Web: the steer and run buttons wait while a command is in flight (no double submit).
 ('CB-07',[(PAGE,"            <Button\n              size=\"sm\"\n              icon=\"pause\"\n              disabled={steer.isPending}","            <Button\n              size=\"sm\"\n              icon=\"pause\"")],T_W,'takes a steer once'),
 ('CB-08',[(CPAGE,"            icon=\"pause\"\n            disabled={run.isPending}","            icon=\"pause\"")],T_CW,'takes a run command once'),
 # Web: the test and the count never read a draft with unsaved edits.
 ('CB-09',[(PAGE,"          disabled={blocked || test.isPending}","          disabled={test.isPending}")],T_W,'withholds the test and the count'),
 # Web: a re-queue is asked first.
 # C3: the bot dimension narrows the ONE audience builder.
 ('CB-12',[(AUD,"    parts.push(sql`${c}.first_bot_instance_id = ANY(${uuids(bots)})`);","    void bots;")],T_AB,'selects the customers of the named bots only'),
 # C4: a campaign announcement is never a service announcement...
 ('CB-13',[(CSVC,"announcement.terms.purpose !== 'MARKETING') {","announcement.terms.purpose === 'NEVER') {")],T_C,'refuses a campaign announcement called a service announcement'),
 # ...and a draft stored before the rule is refused at the confirmation.
 ('CB-14',[(CSVC,"        assertAnnouncementPurpose(actions.map((a) => a.config));\n","")],T_C,'refuses to schedule a draft saved before the rule'),
 # C3 attribution: only PAID redemptions, and "delivered" means the announcement was SENT.
 ('CB-15',[(CREPO,"           AND o.state = 'PAID'\n","")],T_C,'PAID redeemers against who was told'),
 ('CB-16',[(CREPO,"WHERE t.customer_id = r.customer_id AND t.state = 'SENT'))::int","WHERE t.customer_id = r.customer_id))::int")],T_C,'PAID redeemers against who was told'),
 ('CB-10',[(PAGE,"              onClick={() => setRetryAsked(true)}","              onClick={() => steer.mutate('retryFailed')}")],T_W,'asks before a re-queue'),
]

only=sys.argv[1:]
killed=0; ran=0; kills=0
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  originals={}; ok=True
  try:
    for f,a,b in edits:
      s=originals.get(f) or open(f,encoding='utf-8').read()
      originals.setdefault(f,s)
      cur=open(f,encoding='utf-8').read()
      if cur.count(a)!=1:
        print(mid,'ANCHOR MISSING in',f,cur.count(a),flush=True); ok=False; break
      open(f,'w',encoding='utf-8').write(cur.replace(a,b))
    if ok:
      ran+=1
      r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
      out=r.stdout+r.stderr
      failed=[l.strip() for l in out.splitlines() if '×' in l]
      summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
      ran_any=any('passed' in l or 'failed' in l for l in summ)
      if r.returncode!=0 and ran_any: killed+=1; kills+=len(failed)
      print(mid,'KILLED' if (r.returncode!=0 and ran_any) else 'SURVIVED',summ,failed,flush=True)
  finally:
    for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
print(f'{killed} of {ran} mutants killed ({kills} failing tests in all)',flush=True)
