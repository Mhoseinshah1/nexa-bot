"""Package E (RickPanel subscription files) mutation driver (docs/package-e-falsification.md).

Reverts one rule at a time, runs the named tests, and restores the file with `git checkout`.
Needs a clean tree and, for the integration rows, TEST_DATABASE_URL and REDIS_URL pointing
at a database no other suite is using (the integration suite truncates between tests).
Run it in a separate worktree, never the implementation checkout.
Usage: python3 scripts/mutate-package-e.py [E-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

PROV='apps/api/src/modules/platform/providers/infrastructure/'
SF=PROV+'subscription-files.ts'
RP=PROV+'rickpanel.adapter.ts'
SVC='apps/api/src/modules/commerce/provisioning/application/subscription-file.service.ts'
REPO='apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository.ts'
BOT='apps/api/src/surfaces/telegram/bot-runtime.ts'
CON='packages/contracts/src/provider.ts'

U=('unit','tests/unit/subscription-files.test.ts')
A=('unit','tests/unit/rickpanel-files-adapter.test.ts')
I=('integration','tests/integration/subscription-files.test.ts')

OWNED_TAIL=("          notRefundedAway(),\n        ),\n      )\n      .limit(1);\n    const row = rows[0];\n"
            "    return row === undefined ? null : toRecord(row);\n  }\n\n  async setCustomerNote(")

# (id, [(file, before, after)], test, name filter)
M=[
 # E3 — decoding and bounds
 ('E-01',[(SF,"  if (bytes.toString('base64') !== text) return null;\n","")],U,'decodes strict Base64 only'),
 ('E-02',[(SF,"text.length % 4 !== 0 || ","")],I,'refuses malformed Base64 as a failed format'),
 ('E-03',[(SF,"if (entries === null || entries.length > SUBSCRIPTION_FILES_MAX_COUNT) return null;","if (entries === null) return null;")],U,'refuses more entries than the bound'),
 ('E-04',[(SF,"      bytes.byteLength > SUBSCRIPTION_FILE_MAX_BYTES ||\n","")],U,'refuses an empty file and one past the per-file bound'),
 ('E-05',[(SF,"      bytes.byteLength === 0 ||\n","")],U,'refuses an empty file and one past the per-file bound'),
 ('E-06',[(SF,"      total + bytes.byteLength > SUBSCRIPTION_FILES_MAX_TOTAL_BYTES\n","      false\n")],U,'stops adding files at the aggregate bound'),
 ('E-07',[(SF,"(error !== undefined && error !== null) || ","")],U,'counts a failed format and keeps the others'),
 ('E-08',[(SF,"const base = value.split(/[/\\\\]/).pop() ?? '';","const base = value;")],U,'reduces a file name to a safe base name'),
 ('E-09',[(SF,"return bounded.length === 0 || /^\\.+$/.test(bounded) ? fallback : bounded;","return bounded.length === 0 ? fallback : bounded;")],U,'reduces a file name to a safe base name'),
 ('E-10',[(SF,"  if (parameters.some((parameter) => !/^charset=[a-z0-9._-]+$/.test(parameter))) {\n    return 'application/octet-stream';\n  }\n","")],U,'maps a media type into the closed set'),
 ('E-11',[(SF,"  return (SUBSCRIPTION_FILE_MEDIA_TYPES as readonly string[]).includes(type ?? '')\n    ? (type as SubscriptionFileMediaType)\n    : 'application/octet-stream';","  void SUBSCRIPTION_FILE_MEDIA_TYPES;\n  return (type ?? 'application/octet-stream') as SubscriptionFileMediaType;")],U,'maps a media type into the closed set'),
 ('E-12',[(SF,"const cleaned = value.replace(/[\\u0000-\\u0009\\u000b-\\u001f\\u007f]/g, '').trim();","const cleaned = value.trim();")],U,'cleans and bounds a caption'),
 ('E-13',[(SF,"  return cleaned.length > SUBSCRIPTION_FILE_CAPTION_MAX_LENGTH\n    ? `${cleaned.slice(0, SUBSCRIPTION_FILE_CAPTION_MAX_LENGTH - 1)}…`\n    : cleaned;","  return cleaned;")],U,'cleans and bounds a caption'),
 ('E-14',[(SF,"entriesOf(body: unknown): readonly unknown[] | null {\n  if (Array.isArray(body)) return body;\n  if (typeof body === 'object' && body !== null) {\n    const files = (body as Record<string, unknown>)['files'];\n    if (Array.isArray(files)) return files;\n  }\n  return null;","entriesOf(body: unknown): readonly unknown[] | null {\n  if (Array.isArray(body)) return body;\n  if (typeof body === 'object' && body !== null) {\n    const files = (body as Record<string, unknown>)['files'];\n    if (Array.isArray(files)) return files;\n  }\n  return [];")],A,'refuses a 200 in no shape it knows'),
 # E4 — the rate limit
 ('E-15',[(SF,"export const SUBSCRIPTION_FILES_DEFAULT_RETRY_MS = 60_000;","export const SUBSCRIPTION_FILES_DEFAULT_RETRY_MS = 1_000;")],A,'falls back to the documented minute'),
 ('E-16',[(SF,"return Math.min(Number(header.trim()) * 1000, 3_600_000);","return Number(header.trim()) * 1000;")],U,'honours Retry-After in seconds'),
 ('E-17',[(RP,"    if (read.status === 429) {\n      return {\n        ok: false,\n        failure: 'RATE_LIMITED',\n        status: 429,\n        retryAfterMs: retryAfterMs(read.headers['retry-after']),\n      };\n    }\n","")],A,'carries a 429 Retry-After'),
 ('E-18',[(SVC,"          retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),","          retryAfterSeconds: 60,")],I,"honours the panel's 429 and Retry-After"),
 # The adapter's wire
 ('E-19',[(RP,"    if (read.status === 404) return { ok: true, found: false };\n","")],A,'answers a 404 as found:false'),
 ('E-20',[(RP,"path: `${USER_PATH}/${encodeURIComponent(ref.username)}/${SUBSCRIPTION_FILES_SUFFIX}`,","path: `${USER_PATH}/${ref.username}/${SUBSCRIPTION_FILES_SUFFIX}`,")],A,'asks the all-files route for the ENCODED username'),
 ('E-21',[(RP,"    if (parsed === null) {\n      return { ok: false, failure: 'MALFORMED_RESPONSE', status: read.status };\n    }\n    return { ok: true, found: true, files: parsed.files, failed: parsed.failed };","    if (parsed === null) return { ok: true, found: true, files: [], failed: 0 };\n    return { ok: true, found: true, files: parsed.files, failed: parsed.failed };")],A,'refuses a 200 in no shape it knows'),
 # E1 — the capability
 ('E-22',[(CON,"typeof adapter.fetchSubscriptionFiles === 'function' && adapter.supports('SUBSCRIPTION_FILES')","typeof adapter.fetchSubscriptionFiles === 'function'")],U,'requires the method AND the declaration'),
 ('E-23',[(CON,"    // `GET /api/user/{username}/files` (Package E, `docs/package-e-rickpanel-files-audit.md`).\n    'SUBSCRIPTION_FILES',\n","")],U,'is offered by RickPanel and by no other provider'),
 # E2/E3 — the service
 ('E-24',[(SVC,"    await this.deps.guard.check(scope, actor, SUBSCRIPTION_FILES_PERMISSION);\n","")],U,'checks the permission before it reads anything'),
 ('E-25',[(SVC,"    } catch {\n      return { outcome: 'NOT_FOUND' };\n    }","    } catch (error) {\n      throw error;\n    }")],I,"never sends another customer's files"),
 ('E-26',[(REPO,"          eq(services.customerId, customerId),\n"+OWNED_TAIL,OWNED_TAIL)],I,"never sends another customer's files"),
 ('E-27',[(REPO,"          eq(services.tenantId, tenantId),\n          eq(services.id, id),\n          eq(services.customerId, customerId),\n"+OWNED_TAIL,"          eq(services.id, id),\n          eq(services.customerId, customerId),\n"+OWNED_TAIL)],I,"never serves another tenant's service"),
 ('E-28',[(SVC,"    if (!SUBSCRIPTION_FILE_STATES.includes(service.state)) return { outcome: 'UNAVAILABLE' };\n","")],U,'does not offer, nor fetch, the files of a service that is not readable'),
 ('E-29',[(SVC,"    if (!SUBSCRIPTION_FILE_STATES.includes(service.state)) return false;\n","")],I,'draws no files button where the panel cannot fetch files'),
 ('E-30',[(SVC,"              status: view.panel.status,","              status: 'ACTIVE',")],U,'asks nothing of a panel the operator disabled'),
 ('E-31',[(SVC,"    if (!checkUrl(operable.baseUrl, this.deps.urlPolicy).allowed) {\n      return { outcome: 'UNAVAILABLE' };\n    }\n","")],U,'never dials a panel address the URL policy refuses'),
 ('E-32',[(SVC,"    if (credentials === null) return { outcome: 'UNAVAILABLE' };\n","")],U,'asks nothing of a panel whose stored credential cannot be read'),
 ('E-33',[(SVC,"    if (!budget.permitted) return { outcome: 'UNAVAILABLE' };\n","")],U,'asks nothing of the panel when the tenant'),
 ('E-34',[(SVC,"      if (result.outcome !== 'DELIVERED') return { outcome: 'STOPPED', sent };\n","      if (result.outcome !== 'DELIVERED') continue;\n")],I,'stops at the first send Telegram declines'),
 ('E-35',[(SVC,"    return { outcome: 'SENT', sent, failed: fetched.failed };","    return { outcome: 'SENT', sent, failed: 0 };")],I,'sends the usable formats and counts the one'),
 ('E-36',[(SVC,"    if (!fetched.found || fetched.files.length === 0) return { outcome: 'UNAVAILABLE' };","    if (!fetched.found) return { outcome: 'UNAVAILABLE' };")],I,'answers UNAVAILABLE when every format failed'),
 # E2 — the bot
 ('E-37',[(BOT,"    if (\n      this.deps.subscriptionFiles !== undefined &&\n      (await this.deps.subscriptionFiles.offered(scope, service))\n    ) {","    if (this.deps.subscriptionFiles !== undefined) {")],I,'draws no files button where the panel cannot fetch files'),
 ('E-38',[(BOT,"    const chatId = privateChatIdOf(input.update);\n    if (files === undefined || chatId === null) {","    const chatId = privateChatIdOf(input.update) ?? String(customer.telegramUserId);\n    if (files === undefined || chatId === null) {")],I,'sends nothing to a tap that did not come from a private chat'),
 ('E-39',[(BOT,"        return result.failed === 0\n          ? { key: null, values: {}, buttons: [], orderId: null }","        return (true as boolean)\n          ? { key: null, values: {}, buttons: [], orderId: null }")],I,'tells the customer how many formats could not be built'),
 ('E-40',[(BOT,"      case 'RATE_LIMITED':\n        return {\n          key: 'bot.service.files_rate_limited',","      case 'RATE_LIMITED':\n        return {\n          key: 'bot.service.files_unavailable',")],I,'tells the customer how long to wait after a 429'),
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
