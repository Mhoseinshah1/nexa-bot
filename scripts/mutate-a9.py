"""Pre-support A9 (QR on the link view) mutation driver (docs/pre-support/a9-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-a9.py [A9-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

DELIVERY='apps/api/src/modules/commerce/provisioning/application/delivery.service.ts'
RUNTIME='apps/api/src/surfaces/telegram/bot-runtime.ts'
CONTAINER='apps/api/src/container.ts'
T_U=('unit','tests/unit/presupport-a9-link-qr.test.ts')
T_I=('integration','tests/integration/provisioning-delivery.test.ts')

M=[
 # The link view is followed by a QR photo at all.
 ('A9-01',[(DELIVERY,"      await this.sendLinkQr(scope, service, options.card, sentUrl, options.linkQrKey);\n","")],T_U,'decodes to exactly'),
 # The QR encodes the EXACT link the view shows.
 ('A9-02',[(DELIVERY,"          bytes: this.deps.qr.encode(sentUrl),\n          fileName: 'subscription.png',\n          mimeType: 'image/png',\n        },\n        // Its own caption","          bytes: this.deps.qr.encode(`${sentUrl}#`),\n          fileName: 'subscription.png',\n          mimeType: 'image/png',\n        },\n        // Its own caption")],T_U,'decodes to exactly'),
 # The caption is the existing QR caption key.
 ('A9-03',[(DELIVERY,"        caption: { templateKey: 'bot.service.link_qr_caption', values: {} },\n      });\n    } catch {","        caption: { templateKey: 'bot.service.delivered', values: {} },\n      });\n    } catch {")],T_U,'decodes to exactly'),
 # The link view's QR has its OWN caption, never the delivery card's «details in the NEXT message».
 ('A9-11',[(DELIVERY,"        caption: { templateKey: 'bot.service.link_qr_caption', values: {} },","        caption: { templateKey: 'bot.service.delivered_qr_caption', values: {} },")],T_U,'decodes to exactly'),
 ('A9-12',[(DELIVERY,"        caption: { templateKey: 'bot.service.link_qr_caption', values: {} },","        caption: { templateKey: 'bot.service.delivered_qr_caption', values: {} },")],T_I,'sends the subscription again'),
 # ...and the delivery card's split fallback keeps delivered_qr_caption.
 ('A9-13',[(DELIVERY,"      caption: { templateKey: 'bot.service.delivered_qr_caption', values: {} },\n    });\n    if (first.outcome !== 'DELIVERED') return first;","      caption: { templateKey: 'bot.service.link_qr_caption', values: {} },\n    });\n    if (first.outcome !== 'DELIVERED') return first;")],('unit','tests/unit/delivery-card.test.ts'),'falls back to the photo'),
 # Review of PR #211: (a) a claim that throws sends no photo and never fails the link view.
 ('A9-14',[(DELIVERY,"    } catch {\n      // Deliberately swallowed: the link view is shown and recorded already.\n      return;\n    }","    } finally {\n      // mutant: the error escapes\n    }")],T_U,'claim cannot be written'),
 # (b) a refused edit whose view went as a new message still gets its one QR: the QR follows
 # the VIEW's outcome, not the edit's.
 ('A9-15',[(DELIVERY,"      if (edited.outcome !== 'REFUSED') return edited;\n    }\n    return this.deps.messenger.send(scope, view);","      if (edited.outcome !== 'REFUSED') return edited;\n      await this.deps.messenger.send(scope, view);\n      return edited;\n    }\n    return this.deps.messenger.send(scope, view);")],T_U,'edit is refused'),
 # (c) a rate-limited edit gets no QR and spends no claim.
 ('A9-16',[(DELIVERY,"      return { state: from, recorded: held, ...(sentTo === undefined ? {} : { sentTo }) };\n    }","      if (options.card !== undefined && options.linkQrKey !== undefined) {\n        await this.sendLinkQr(scope, service, options.card, sentUrl, options.linkQrKey);\n      }\n      return { state: from, recorded: held, ...(sentTo === undefined ? {} : { sentTo }) };\n    }")],T_U,'rate limited'),
 # A CARD_TEXT panel gets no QR.
 ('A9-04',[(DELIVERY,"      if (mode === 'CARD_TEXT') return;\n      const claimed","      const claimed")],T_U,'CARD_TEXT'),
 # A replayed tap finds the claim and sends nothing.
 ('A9-05',[(DELIVERY,"      if (!claimed) return;\n      await this.deps.messenger.sendFile","      await this.deps.messenger.sendFile")],T_U,'replayed tap'),
 # Only a view known to be on the screen gets a QR.
 ('A9-06',[(DELIVERY,"      result.outcome === 'DELIVERED'\n    ) {\n      await this.sendLinkQr","      result.outcome !== 'RATE_LIMITED'\n    ) {\n      await this.sendLinkQr")],T_U,'may not be on the screen'),
 # The tenant's activity is read inside the claim's transaction.
 ('A9-07',[(DELIVERY,"        (await this.deps.scopeActivity.scopeIsActive(scope, tx))\n          ? claims.claim(scope, key, tx)\n          : false,","        claims.claim(scope, key, tx),")],T_U,'tenant that stopped'),
 # The runtime hands the tap's key down (without it no QR is sent).
 ('A9-08',[(RUNTIME,"        card === null ? {} : { card, linkQrKey: input.idempotencyKey },","        card === null ? {} : { card },")],T_I,'sends the subscription again'),
 # The claim is durable (the idempotency store's unique key), not always granted.
 ('A9-09',[(CONTAINER,"      claim: (scope, key, tx) =>\n        idempotency.remember(","      claim: async (scope, key, tx) =>\n        true ||\n        idempotency.remember(")],T_I,'sends the subscription again'),
 # The claim is per tap: the update's key, not one key for every tap.
 ('A9-10',[(RUNTIME,"        card === null ? {} : { card, linkQrKey: input.idempotencyKey },","        card === null ? {} : { card, linkQrKey: service.id },")],T_I,'sends the subscription again'),
]

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
  if ok:
    ran+=1
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    ran_any=any('passed' in l or 'failed' in l for l in summ)
    if r.returncode!=0 and ran_any: killed+=1
    print(mid,'KILLED' if (r.returncode!=0 and ran_any) else 'SURVIVED',summ,failed[:2],flush=True)
  for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
print(f'{killed} of {ran} killed',flush=True)
