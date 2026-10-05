"""A10 + E7 (receipt flow) mutation driver (docs/pre-support/a10-e7-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
A mutant in packages/i18n rebuilds the catalogue before the run and again after the restore,
because the test projects import @nexa/i18n from its dist.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-a10-e7.py [A10-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

PKG={'packages/i18n/':'@nexa/i18n','packages/contracts/':'@nexa/contracts'}
SVC='apps/api/src/modules/commerce/payments/application/receipt.service.ts'
BOT='apps/api/src/surfaces/telegram/bot-runtime.ts'
CAT='packages/i18n/src/catalogue.fa.ts'
T_I=('integration','tests/integration/telegram-payment-flow.test.ts')
T_U=('unit','tests/unit/telegram-customer-ux.test.ts')
T_S=('integration','tests/integration/payment-receipts.test.ts')

M=[
 # --- exactly once: the new message is keyed on the payment's FIRST receipt row ----------------
 ('A10-01',[(SVC,"first: filed !== null && already === 0,","first: filed !== null,")],T_I,'second receipt'),
 ('A10-02',[(SVC,"        held: replayed.result.held,\n        first: false,","        held: replayed.result.held,\n        first: replayed.result.filed && replayed.result.held === 1,")],T_I,'redelivers the receipt update'),
 ('A10-03',[(BOT,"      if (!submitted.first) return { key: null, values: {}, buttons: [], orderId: null };\n","")],T_I,'second receipt'),
 # --- the invoice is edited into its final, button-less state, and is not the new message ------
 ('A10-04',[(BOT,"      if (chatId !== null) {\n        try {\n          await this.finaliseReceiptInvoice(","      if (chatId === '') {\n        try {\n          await this.finaliseReceiptInvoice(")],T_I,'ends it button-less and sends ONE new message'),
 ('A10-05',[(BOT,"const RECEIPT_INVOICE_FINAL_KEY: TemplateKey = 'bot.payment.received_for_review';","const RECEIPT_INVOICE_FINAL_KEY: TemplateKey = 'bot.payment.receipt_received';")],T_I,'ends it button-less and sends ONE new message'),
 ('A10-06',[(BOT,"      return { key: 'bot.payment.receipt_received', values: {}, buttons: [], orderId: null };","      return { key: 'bot.payment.received_for_review', values: {}, buttons: [], orderId: null };")],T_I,'ends it button-less and sends ONE new message'),
 # The prompt turn that releases its hold ends the invoice in the same final state, sends nothing.
 ('A10-07',[(BOT,"          templateKey: RECEIPT_INVOICE_FINAL_KEY,\n          values: {},\n          buttons: [],\n        },\n        false,\n      );\n    }\n  }","          templateKey: 'bot.payment.receipt_received',\n          values: {},\n          buttons: [],\n        },\n        false,\n      );\n    }\n  }")],T_I,'receipt beat the tap'),
 # --- an expired window still answers receipt_expired ----------------------------------------
 ('A10-08',[(SVC,"        if (open.expiresAt.getTime() <= now.getTime()) {","        if (open.expiresAt.getTime() <= now.getTime() && false) {")],T_I,'window closed'),
 # --- E7 and the copy -------------------------------------------------------------------------
 ('E7-01',[(CAT,"اکنون تصویر رسید را در همین گفتگو","اکنون تصویر یا فایل رسید را در همین گفتگو")],T_U,'no longer advertises a file'),
 ('E7-02',[(CAT,"اکنون تصویر رسید را در همین گفتگو","اکنون تصویر یا فایل رسید را در همین گفتگو")],T_I,'ends it button-less'),
 ('A10-09',[(CAT,"در حال بررسی می‌باشد.\\n\\nپس از بررسی","در حال بررسی می‌باشد.\\nپس از بررسی")],T_U,'blank line between them'),
 # --- review round (PR #208) ------------------------------------------------------------------
 # The invoice's final text must be EXACTLY received_for_review; the prompt shares its opening.
 ('A10-11',[(BOT,"const RECEIPT_INVOICE_FINAL_KEY: TemplateKey = 'bot.payment.received_for_review';","const RECEIPT_INVOICE_FINAL_KEY: TemplateKey = 'bot.payment.receipt_prompt';")],T_I,'ends it button-less and sends ONE new message'),
 # The invoice finalisation is best effort: a throw after the commit must not cost the message.
 ('A10-12',[(BOT,"        } catch (error) {\n          this.deps.logger?.error(","        } catch (error) {\n          throw error;\n          this.deps.logger?.error(")],T_I,'finalising the invoice throws'),
 # Service level: exactly one of two concurrent first receipts, and a replay is never first.
 ('A10-13',[(SVC,"first: filed !== null && already === 0,","first: filed !== null && already <= 1,")],T_S,'exactly one of two concurrent first receipts'),
 ('A10-14',[(SVC,"        held: replayed.result.held,\n        first: false,","        held: replayed.result.held,\n        first: replayed.result.filed && replayed.result.held === 1,")],T_S,'redelivered update without writing'),
 # E7 on the invoice itself: the instructions ask for an image, not a file.
 ('E7-03',[(CAT,"دکمهٔ پایین را بزنید و تصویر رسید را ارسال کنید.","دکمهٔ پایین را بزنید و تصویر یا فایل رسید را ارسال کنید.")],T_U,'image of the receipt, not a file'),
 ('A10-10',[(CAT,"در حال بررسی می‌باشد.\\n\\nپس از بررسی","در حال بررسی می‌باشد.\\nپس از بررسی")],T_I,'ends it button-less'),
]

def build_package(name):
  r=subprocess.run(['pnpm','--filter',name,'build'],capture_output=True,text=True)
  if r.returncode!=0: print(r.stdout+r.stderr,flush=True)
  return r.returncode==0

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
  pkgs=sorted({PKG[p] for p in PKG for f in originals if f.startswith(p)})
  if ok and not all(build_package(p) for p in pkgs):
    # A mutant that does not compile is not a mutant a test can kill; say so.
    print(mid,'DOES NOT COMPILE',flush=True); ok=False
  if ok:
    ran+=1
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    ran_any=any('passed' in l or 'failed' in l for l in summ)
    # KILLED only when a named test FAILED: a non-zero exit with no × line is a broken run
    # (a compile error, a missing database), not a test that noticed the mutant.
    dead=r.returncode!=0 and ran_any and len(failed)>0
    if dead: killed+=1
    print(mid,'KILLED' if dead else 'SURVIVED',summ,failed[:2],flush=True)
  for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
  for p in pkgs: build_package(p)
print(f'{killed} of {ran} killed',flush=True)
