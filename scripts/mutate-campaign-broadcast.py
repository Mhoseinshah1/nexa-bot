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
T_BW=('web','tests/web/broadcasts.test.tsx')
T_ABW=('web','tests/web/audience-bots.test.tsx')
AB='apps/web/src/pages/audience-builder.tsx'
T_W=('web','tests/web/broadcast-readiness.test.tsx')
T_CW=('web','tests/web/campaigns.test.tsx')
AUD='apps/api/src/modules/commerce/audience/infrastructure/audience-sql.ts'
CSVC='apps/api/src/modules/commerce/campaigns/application/campaign.service.ts'
CREPO='apps/api/src/modules/commerce/campaigns/infrastructure/drizzle-campaign.repository.ts'
T_AB=('integration','tests/integration/audience-bots.test.ts')
T_C=('integration','tests/integration/campaigns.test.ts')
TRANSPORT='apps/api/src/modules/commerce/broadcasts/infrastructure/telegram-broadcast.transport.ts'
T_U=('unit','tests/unit/broadcast-transport.test.ts')

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
 ('CB-15',[(CREPO,"           AND o.state = 'PAID'\n","")],T_C,'counts a redeemer as told only when told'),
 ('CB-16',[(CREPO,"(SELECT count(*) FROM audience WHERE state = 'SENT')::int AS delivered","(SELECT count(*) FROM audience)::int AS delivered")],T_C,'counts a redeemer as told only when told'),
 # Web: a test send is a history row; the history is read again after it (Codex P2, PR #237).
 ('CB-17',[(PAGE,"      void client.invalidateQueries({ queryKey: ['broadcast-history', record.id] });\n    },\n  });\n  const large","    },\n  });\n  const large")],T_W,'reads the history again after a test'),
 # D2-F1: on a forward/copy, "chat not found" may name the SOURCE: a refusal, not unreachable.
 ('CB-18',[(TRANSPORT,"  if (request.sourced && AMBIGUOUS_ON_SOURCED_SEND.test(outcome.errorMessage)) {","  if (false && AMBIGUOUS_ON_SOURCED_SEND.test(outcome.errorMessage)) {")],T_U,'D2-F1|may name the source chat'),
 # Review N2: "waiting for a retry" is a PENDING row with an answer on record, not every PENDING.
 ('CB-19',[(REPO,"count(*) FILTER (WHERE r.state = 'PENDING' AND r.error_code IS NOT NULL)::int","count(*) FILTER (WHERE r.state = 'PENDING')::int")],T_R,'a 429 holds the bot that got it'),
 # Review N1: without audit.view, no refused rows and no operator identity.
 ('CB-20',[(SVC,"      if (!audited && row.result !== 'SUCCESS') continue;\n","")],T_R,'without audit.view'),
 ('CB-21',[(SVC,"        actorLabel: audited ? row.actorLabel : null,","        actorLabel: row.actorLabel,")],T_R,'without audit.view'),
 # Review N4: the history says when older rows exist.
 ('CB-22',[(SVC,"    const truncated = rows.length > BROADCAST_HISTORY_MAX;","    const truncated = false;")],T_R,'beyond the cap'),
 # Web foundation: a 409 on a campaign run command re-reads the campaign (settleOn onConflict).
 ('CB-23',[(CPAGE,"""      submission.settleOn(error, {
        onConflict: () => void client.invalidateQueries({ queryKey: [CAMPAIGNS_KEY] }),
      });
      notify(""","""      submission.settleOn(error);
      notify(""")],T_CW,'refused as stale'),
 # PR #245 Codex CX1: no attribution around Broadcast's guarded read.
 ('CB-24',[(CSVC,"broadcastId === null || discountId === null || announcement === null","broadcastId === null || discountId === null")],T_C,'may not read the announcement'),
 # Review m1: "told" is SENT or UNCONFIRMED, never a SKIPPED or failed row.
 ('CB-25',[(CREPO,"(SELECT count(*) FROM audience WHERE state IN ('SENT', 'UNCONFIRMED'))::int AS told","(SELECT count(*) FROM audience)::int AS told")],T_C,'counts a redeemer as told only when told'),
 ('CB-26',[(CREPO,"""               WHERE a.state IN ('SENT', 'UNCONFIRMED')
                 AND p.settled_at >= a.send_started_at)::int AS redeemers_told""","""               WHERE true
                 AND p.settled_at >= a.send_started_at)::int AS redeemers_told""")],T_C,'counts a redeemer as told only when told'),
 # Review m2: only an order paid after the send; never a refunded one (X14).
 ('CB-27',[(CREPO,"""                 AND p.settled_at >= a.send_started_at)::int AS redeemers_told""","""                 AND true)::int AS redeemers_told""")],T_C,'counts a redeemer as told only when told'),
 ('CB-28',[(CREPO,"           AND o.state = 'PAID'\n","           AND o.state IN ('PAID', 'REFUNDED')\n")],T_C,'counts a redeemer as told only when told'),
 # Review m4: a replayed hand-over launches only the campaign's own draft.
 ('CB-29',[(CSVC,"      if (!isTheCampaignsAnnouncement(draft, config.terms)) {","      if (false) {")],T_C,'never launches a draft someone edited'),
 # Review m5 X5: the hand-over's MARKETING is the campaign's, not a stored purpose.
 ('CB-30',[(CSVC,"        purpose: 'MARKETING',\n        frozenAudienceId,","        purpose: config.terms.purpose,\n        frozenAudienceId,")],T_C,'launches MARKETING even if a stored purpose'),
 # Review M1: the Composer is not remounted (and duplicated) by a version bump.
 ('CB-31',[(PAGE,"                    key={`composer-${record.id}`}","                    key={record.version}"),(PAGE,"                    key={`launch-${String(record.version)}`}","                    key={record.version}")],T_BW,'with ONE editor'),
 # Codex CX2: unsaved edits are never replaced silently.
 ('CB-32',[(PAGE,"    if (dirty) {\n      setStale(true);","    if (false) {\n      setStale(true);")],T_BW,'with ONE editor'),
 # Review m5 X10/X9/X11: a 409 re-reads the record on composer save, launch and confirmation.
 ('CB-33',[(PAGE,"""        onConflict: () => {
          if (record !== null) {
            void client.invalidateQueries({ queryKey: ['broadcast', record.id] });
          }
        },""","""        onConflict: () => undefined,""")],T_BW,'with ONE editor'),
 ('CB-34',[(PAGE,"        onConflict: () => void client.invalidateQueries({ queryKey: ['broadcast', record.id] }),","        onConflict: () => undefined,")],T_BW,'launch is refused as stale'),
 ('CB-35',[(CPAGE,"""      // A 409 (the campaign or its audience moved on): read both again.
      submission.settleOn(error, {
        onConflict: () => void client.invalidateQueries({ queryKey: [CAMPAIGNS_KEY] }),
      });""","""      submission.settleOn(error);""")],T_CW,'confirmation is refused as stale'),
 # Review m3: a default-valued audience key is not sent to the server.
 ('CB-36',[(AB,"    ...(botInstanceIds === null ? {} : { botInstanceIds }),","    botInstanceIds,")],T_BW,'no audience key at its default'),
 # Review m5 X12: the bot section only where there is a choice.
 ('CB-37',[(AB,"      {(opts?.bots.length ?? 0) > 1 && (","      {(opts?.bots.length ?? 0) > 0 && (")],T_ABW,'one bot'),
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
