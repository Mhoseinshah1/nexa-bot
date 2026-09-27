"""WP20 mutation driver (docs/wp20-falsification.md).

Reverts one rule at a time, runs the named tests, and restores the file with `git checkout`.
A mutation of `packages/contracts` rebuilds the package first, because the tests import its
`dist`, and rebuilds it again after the restore. Needs TEST_DATABASE_URL pointing at a
database nothing else is using, Redis on REDIS_URL (default 127.0.0.1:6379), and a clean
tree. Usage: python3 scripts/mutate-wp20.py [W20-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if 'TEST_DATABASE_URL' not in os.environ:
  sys.exit('TEST_DATABASE_URL is required')
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

REL='apps/api/src/modules/platform/eventing/infrastructure/outbox-relay.ts'
DIAG='apps/api/src/modules/platform/system/infrastructure/drizzle-diagnostics.reader.ts'
WEB='apps/web/src/pages/system-diagnostics.tsx'
DISP='apps/api/src/modules/control/notifications/application/notification-dispatcher.ts'
CN='apps/api/src/modules/commerce/messaging/application/customer-notification.service.ts'
RP='apps/api/src/modules/commerce/payments/application/receipt-review-push.service.ts'
SRP='apps/api/src/modules/commerce/payments/application/service-refund-push.service.ts'
DEL='apps/api/src/modules/commerce/provisioning/application/delivery.service.ts'
CT='packages/contracts/src/messaging-reliability.ts'
AS='apps/api/src/modules/commerce/customers/application/anti-spam.service.ts'
RC='apps/api/src/infrastructure/redis/redis-interaction-counter.ts'
BR='apps/api/src/surfaces/telegram/bot-runtime.ts'

T_OR=('integration','tests/integration/wp20-outbox-retry.test.ts')
T_AS=('integration','tests/integration/wp20-anti-spam.test.ts')
T_IC=('integration','tests/integration/wp20-interaction-counter.test.ts')
T_U=('unit','tests/unit/wp20-retry-schedule.test.ts')
T_W=('web','tests/web/system-diagnostics.test.tsx')
T_CN=('integration','tests/integration/customer-notifications.test.ts')
T_RP=('integration','tests/integration/receipt-review-push.test.ts')
T_SR=('integration','tests/integration/service-refund-requests.test.ts')
T_PD=('integration','tests/integration/provisioning-delivery.test.ts')

# (id, [(file, before, after)], test, name filter)
M=[
 # --- the outbox: schedule, exhaustion, ordering ---------------------------------------
 ('W20-01',[(REL,"""              or(isNull(outboxMessages.nextAttemptAt), lte(outboxMessages.nextAttemptAt, now)),
""","")],T_OR,'claims nothing before it is due'),
 ('W20-02',[(REL,": new Date(this.clock.now().getTime() + deliveryRetryDelayMs(failures)),",": this.clock.now(),")],T_OR,'claims nothing before it is due'),
 ('W20-03',[(REL,"""              notExhausted(),
              // Due:""","""              // Due:""")],T_OR,'stops after twelve'),
 ('W20-04',[(REL,"const exhausted = failures >= DELIVERY_MAX_FAILED_ATTEMPTS;","const exhausted = failures > DELIVERY_MAX_FAILED_ATTEMPTS;")],T_OR,'stops after twelve'),
 ('W20-05',[(REL,"""              await this.opsEvents?.record(
                scopeOf(event),""","""              await (undefined as typeof this.opsEvents)?.record(
                scopeOf(event),""")],T_OR,'stops after twelve'),
 ('W20-06',[(REL,"""              noEarlierLiveSibling(),
            ),""","""            ),""")],T_OR,'own aggregate, and nothing else'),
 ('W20-07',[(REL,"""      AND earlier.attempts < ${DELIVERY_MAX_FAILED_ATTEMPTS}
  )`;""","""  )`;""")],T_OR,'stops after twelve'),
 ('W20-08',[(REL,"      AND earlier.attempts > 0\n","")],T_OR,'drains an aggregate'),
 ('W20-09',[(REL,"            held.add(aggregate);\n","")],T_OR,'own aggregate, and nothing else'),
 ('W20-10',[(REL,"""          // An exhausted message is in the diagnostics, not the lag (WP20).
          notExhausted(),""","""          // An exhausted message is in the diagnostics, not the lag (WP20).""")],T_OR,'stops after twelve'),
 ('W20-11',[(DIAG,"FILTER (WHERE attempts >= ${DELIVERY_MAX_FAILED_ATTEMPTS})","FILTER (WHERE false)")],T_OR,'stops after twelve'),
 ('W20-12',[(DIAG,"exhausted: Number(one.attempts) >= DELIVERY_MAX_FAILED_ATTEMPTS,","exhausted: false,")],T_OR,'stops after twelve'),
 ('W20-13',[(WEB,"{data.outbox.exhausted > 0 && (","{false && (")],T_W,'names the messages no longer retried'),
 ('W20-14',[(WEB,"        row.exhausted ? (","        false ? (")],T_W,'names the messages no longer retried'),
 # --- the later of retry_after and the lane's own back-off -----------------------------
 ('W20-15',[(DISP,"return Math.max(local, retryAfterMs ?? 0);","return retryAfterMs ?? local;")],T_U,'never lets a small retry_after'),
 ('W20-16',[(CN,"Math.max(result.retryAfterMs ?? 0, CUSTOMER_NOTIFICATION_BACKOFF_MS)","(result.retryAfterMs ?? CUSTOMER_NOTIFICATION_BACKOFF_MS)")],T_CN,'short retry_after never brings'),
 ('W20-17',[(RP,"Math.max(result.retryAfterMs ?? 0, RECEIPT_PUSH_BACKOFF_MS)","(result.retryAfterMs ?? RECEIPT_PUSH_BACKOFF_MS)")],T_RP,'a 429 waits'),
 ('W20-18',[(SRP,"Math.max(result.retryAfterMs ?? 0, REFUND_PUSH_BACKOFF_MS)","(result.retryAfterMs ?? REFUND_PUSH_BACKOFF_MS)")],T_SR,'waits its own back-off'),
 ('W20-19',[(DEL,"Math.max(result.retryAfterMs ?? 0, DELIVERY_BACKOFF_MS)","(result.retryAfterMs ?? DELIVERY_BACKOFF_MS)")],T_PD,'waits its own back-off'),
 ('W20-20',[(CT,"[5_000, 15_000, 60_000, 300_000, 900_000] as const","[5_000, 15_000, 60_000, 300_000] as const")],T_U,'waits 5 s'),
 ('W20-21',[(CT,"  return Math.max(local, provider);","  return provider || local;")],T_U,'takes the LATER'),
 ('W20-22',[(CT,"export const DELIVERY_MAX_FAILED_ATTEMPTS = 12;","export const DELIVERY_MAX_FAILED_ATTEMPTS = 13;")],T_U,'stops after twelve'),
 # --- anti-spam --------------------------------------------------------------------------
 ('W20-23',[(AS,"if (count <= ANTI_SPAM_MAX_INTERACTIONS) return 'ALLOWED';","if (count < ANTI_SPAM_MAX_INTERACTIONS) return 'ALLOWED';")],T_AS,'allows exactly twenty'),
 ('W20-24',[(AS,"if (count <= ANTI_SPAM_MAX_INTERACTIONS) return 'ALLOWED';","if (count <= ANTI_SPAM_MAX_INTERACTIONS + 1) return 'ALLOWED';")],T_AS,'blocks on the 21st'),
 ('W20-25',[(BR,"if (spam !== null && spam.verdict !== 'ALLOWED' && arrival !== 'BLOCKED') {","if (false as boolean) {")],T_AS,'blocks on the 21st'),
 ('W20-26',[(BR,"spam?.verdict === 'FLOODING' && arrival === 'BLOCKED' && answered === blocked","false")],T_AS,'answers nothing more'),
 ('W20-27',[(BR,"""      counted.verdict !== 'ALLOWED' &&
      (await this.deps.telegramAdmins?.resolve(""","""      counted.verdict !== 'ALLOWED' &&
      false &&
      (await this.deps.telegramAdmins?.resolve(""")],T_AS,'never blocks a bound administrator'),
 ('W20-28',[(BR,"    const updateId = updateIdOf(input.update);","    const updateId = (input.update as { message?: unknown }).message === undefined ? null : updateIdOf(input.update);")],T_AS,'counts button presses'),
 ('W20-29',[(BR,"  if (reason === ANTI_SPAM_BLOCK_REASON) {","  if (false as boolean) {")],T_AS,'blocks on the 21st'),
 ('W20-30',[(RC,"if fresh then\n  redis.call('ZADD'","if true then\n  redis.call('ZADD'")],T_IC,'redelivered update'),
 ('W20-31',[(RC,"`${this.prefix}:${input.tenantId}:${input.botInstanceId}:${input.telegramUserId}`","`${this.prefix}:${input.botInstanceId}:${input.telegramUserId}`")],T_AS,'counts per tenant'),
 ('W20-32',[(RC,"`${this.prefix}:${input.tenantId}:${input.botInstanceId}:${input.telegramUserId}`","`${this.prefix}:${input.tenantId}:${input.telegramUserId}`")],T_AS,'counts per bot'),
 ('W20-33',[(RC,"tonumber(ARGV[1]) - tonumber(ARGV[2]))","tonumber(ARGV[1]) - 2 * tonumber(ARGV[2]))")],T_IC,'ROLLING window'),
 ('W20-34',[(RC,"    if (!(await this.ready())) return { state: 'UNAVAILABLE' };","    if (this.client.status !== 'ready') return { state: 'UNAVAILABLE' };")],T_IC,'counts within the window'),
 ('W20-35',[(AS,"      return { verdict: 'ALLOWED', count: null };","      return { verdict: 'FLOODING', count: null };")],T_AS,'blocks nobody'),
 ('W20-36',[(AS,"""      this.degradedRecordedAt !== null &&
      nowMs""","""      false &&
      nowMs""")],T_AS,'blocks nobody'),
 ('W20-37',[(BR,"if (spam !== null && spam.verdict !== 'ALLOWED' && arrival !== 'BLOCKED') {","if (spam !== null && spam.verdict !== 'ALLOWED') {")],T_AS,'keeps an administrator'),
]

def build_contracts():
  subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True,check=True)

only=sys.argv[1:]
for mid,edits,(project,test),filt in M:
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
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  if contracts: build_contracts()
