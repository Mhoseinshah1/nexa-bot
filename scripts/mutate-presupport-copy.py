"""Pre-support copy fixes A11, A3, E4 mutation driver (docs/pre-support/copy-a11-a3-e4-falsification.md).

Reverts one copy change at a time, inside ONE catalogue entry, rebuilds @nexa/i18n (the test
projects import it from its dist), runs the named test, restores the file and rebuilds again.
Modeled on scripts/mutate-tb10.py. No database needed.
Usage: python3 scripts/mutate-presupport-copy.py [COPY-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

CAT='packages/i18n/src/catalogue.fa.ts'
T=('unit','tests/unit/presupport-copy.test.ts')
NEW_A11=('پرداخت شما فقط پس از تأیید درگاه ثبت می‌شود.\\n\\nپس از پرداخت نیازی به کار دیگری نیست: '
  'وضعیت پرداخت به‌صورت خودکار بررسی می‌شود و نتیجه در همین گفتگو به شما اعلام می‌شود. '
  'دکمهٔ «بررسی وضعیت پرداخت» فقط برای وقتی است که چند دقیقه پس از پرداخت هنوز نتیجه‌ای دریافت نکرده‌اید.')
OLD_A11='پرداخت شما فقط پس از تأیید درگاه ثبت می‌شود؛ پس از پرداخت، دکمهٔ «بررسی وضعیت پرداخت» را بزنید.'

# (id, catalogue key, new text, reverted text, test filter, what it reverts)
M=[
 ('COPY-01','bot.payment.gateway_invoice',NEW_A11,OLD_A11,'bot.payment.gateway_invoice says','A11 plain invoice'),
 ('COPY-02','bot.payment.gateway_invoice_order_fee',NEW_A11,OLD_A11,'gateway_invoice_order_fee says','A11 order-fee invoice'),
 ('COPY-03','bot.payment.gateway_invoice_topup_fee',NEW_A11,OLD_A11,'gateway_invoice_topup_fee says','A11 top-up-fee invoice'),
 ('COPY-04','bot.wallet.summary','شناسه کاربری: {telegramId}','آی دی عددی: {telegramId}','bot.wallet.summary labels','A3 wallet label'),
 ('COPY-06','bot.service.transfer_confirm','شناسه کاربری مقصد: {recipientId}','آی دی عددی کاربر مقصد: {recipientId}','transfer_confirm labels','A3 transfer recipient label'),
 ('COPY-07','bot.wallet.summary','شناسه کاربری: {telegramId}','آی\u200cدی عددی: {telegramId}','bot.wallet.summary labels','A3 wallet label, ZWNJ spelling'),
 ('COPY-05','bot.discount.ask',"'کد تخفیف خود را ارسال کنید'","'کد تخفیف خود را در پیام بعدی بفرستید.'",'bot.discount.ask reads','E4 discount prompt'),
]

def build_i18n():
  r=subprocess.run(['pnpm','--filter','@nexa/i18n','build'],capture_output=True,text=True)
  if r.returncode!=0: print(r.stdout+r.stderr,flush=True)
  return r.returncode==0

def entry_span(s,key):
  start=s.find("  '"+key+"':")
  if start<0 or s.count("  '"+key+"':")!=1: return None
  end=s.find("',\n",start)
  return (start,end+3) if end>=0 else None

only=sys.argv[1:]
killed=0; ran=0
for mid,key,a,b,filt,what in M:
  if only and mid not in only: continue
  original=open(CAT,encoding='utf-8').read()
  span=entry_span(original,key)
  ok=span is not None and original[span[0]:span[1]].count(a)==1
  if not ok:
    print(mid,'ANCHOR MISSING for',key,flush=True); continue
  entry=original[span[0]:span[1]].replace(a,b)
  open(CAT,'w',encoding='utf-8').write(original[:span[0]]+entry+original[span[1]:])
  if not build_i18n():
    print(mid,'DOES NOT COMPILE',flush=True)
  else:
    ran+=1
    r=subprocess.run(['pnpm','exec','vitest','run','--project',T[0],T[1],'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    ran_any=any('passed' in l or 'failed' in l for l in summ)
    k=r.returncode!=0 and ran_any
    if k: killed+=1
    print(mid,what,'KILLED' if k else 'SURVIVED',summ,failed[:2],flush=True)
  open(CAT,'w',encoding='utf-8').write(original)
  build_i18n()
print(f'{killed} of {ran} killed',flush=True)
