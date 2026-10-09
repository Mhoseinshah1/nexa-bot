"""Phase 2 item 4 (QR background / template) mutation driver (docs/phase2/item4-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
A mutant in packages/contracts rebuilds the package before the run and again after the
restore, because the test projects import @nexa/contracts from its dist.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
A SQL mutant (FIX-06's migration 0239 CHECK) replaces the live constraint in the TEST database,
runs the named test, then deletes that database's `delivery.qr_template` rows and re-applies the
constraint from apps/api/drizzle/0239_qr_template_quiet_zone_check.sql. It needs `psql`, a
database whose name starts with `nexa_test`, and 0239 already applied (run the integration
file once first); otherwise it is reported NOT RUN.
Usage: python3 scripts/mutate-p2-item4.py [Q-01 ...]
"""
import subprocess, sys, os, re
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

PKG={'packages/contracts/':'@nexa/contracts'}
QT='apps/api/src/infrastructure/qr/qr-template.ts'
PC='apps/api/src/infrastructure/qr/png-codec.ts'
DS='apps/api/src/modules/commerce/provisioning/application/delivery.service.ts'
MS='apps/api/src/modules/control/media/application/tenant-media.service.ts'
GS='apps/api/src/modules/control/media/application/qr-template.service.ts'
CN='apps/api/src/container.ts'
CT='packages/contracts/src/delivery-qr.ts'
WP='apps/web/src/pages/qr-template.tsx'
T_U=('unit','tests/unit/delivery-qr-template.test.ts')
T_C=('unit','tests/unit/delivery-qr-contract.test.ts')
T_I=('integration','tests/integration/delivery-qr-template.test.ts')
T_W=('web','tests/web/qr-template.test.tsx')
T_P=('unit','tests/unit/qr-png.test.ts')
QP='apps/api/src/infrastructure/qr/qr-png.ts'
SQL='SQL'  # a mutant of the live CHECK in the test database, not of a file
MIG='apps/api/drizzle/0239_qr_template_quiet_zone_check.sql'
QZ_CHECK=("setting_key <> 'delivery.qr_template' OR jsonb_typeof(value) = 'null' OR (CASE WHEN "
  "jsonb_typeof(value -> 'quietZoneModules') = 'number' THEN ({}) ELSE false END)")
QZ="(value ->> 'quietZoneModules')::numeric"

# The import a "bypass the port" mutant needs, added above the delivery service's first import.
BYPASS_IMPORT=(DS,"import {\n  COMMERCE_ERROR_CODES,","import { encodeQrPng } from '../../../../infrastructure/qr/qr-png.js';\nimport {\n  COMMERCE_ERROR_CODES,")

M=[
 # --- composition: placement, scale, quiet zone ---------------------------------------------
 ('Q-01',[(QT,"  const scale = qrModuleScale(template.size, count, template.quietZoneModules);","  const scale = Math.round(template.size / (count + 2 * template.quietZoneModules));")],T_U,'never rounds the module up'),
 ('Q-02',[(QT,"    rgb.fill(0xff, y * stride + white.x * 3, y * stride + (white.x + white.side) * 3);","    void y;")],T_U,'quiet zone white'),
 ('Q-03',[(QT,"  const left = template.x + Math.floor((template.size - side) / 2);","  const left = template.x;")],T_U,'exact scale'),
 ('Q-04',[(QT,"  if (qrEffectiveModulePx(scale, background) < QR_TEMPLATE_MODULE_MIN_PX) {","  if (qrEffectiveModulePx(scale, background) < 1) {")],T_U,'too small for this link'),
 ('Q-05',[(QT,"  if (qrTemplatePlacementProblem(template, background) !== null) {","  if (false) {")],T_U,'does not lie inside the background'),
 ('Q-06',[(QT,"        rgb.fill(0x00, at, at + scale * 3);","        rgb.fill(0x00, at, at + scale * 3 - 3);")],T_U,'exact scale'),
 # --- the renderer: default, fallback, item 6 seam -----------------------------------------
 ('Q-07',[(QT,"    bytes: encodeQrModulesPng(modules, { scale: PLAIN_SCALE, margin: PLAIN_MARGIN }),","    bytes: encodeQrModulesPng(modules, { scale: 9, margin: PLAIN_MARGIN }),")],T_U,'byte for byte the plain QR'),
 ('Q-08',[(QT,"      return { bytes: source.bytes, origin: 'PROVIDER_ORIGINATED', templated: false };","      return { bytes: Uint8Array.from([0]), origin: 'PROVIDER_ORIGINATED', templated: false };")],T_U,'provider-originated image'),
 ('Q-09',[(QT,"    if (!('image' in loaded.decoded)) {","    if (false) {")],T_U,'for every template it cannot use'),
 ('Q-10',[(QT,"      this.onFallback(scope, 'CONFIG_UNREADABLE', error);\n      return plain(modules, 'CONFIG_UNREADABLE');","      throw error;")],T_U,'reading the configuration throws'),
 ('Q-12',[(QT,"      template = draft === undefined ? await sources.template(scope) : draft;","      template = await sources.template(scope);")],T_U,'previews a draft'),
 # --- the decoder ---------------------------------------------------------------------------
 ('Q-13',[(PC,"    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });","    raw = inflateSync(Buffer.concat(idat));")],T_U,'decompression bomb'),
 ('Q-14',[(PC,"    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0 !== crc) {","    if (false) {")],T_U,'ancillary chunk'),
 ('Q-15',[(PC,"        rgb[t] = overWhite(lines[s] as number, alpha);","        rgb[t] = lines[s] as number;")],T_U,'alpha flattened'),
 ('Q-16',[(PC,"    } else if ((type.charCodeAt(0) & 0x20) === 0) {","    } else if (false) {")],T_U,'unknown critical chunk'),
 ('Q-17',[(PC,"  if (!sawEnd) throw corrupt('there is no IEND');","")],T_U,'refuses damage as CORRUPT'),
 ('Q-18',[(PC,"        case 4:\n          value = x + paeth(a, b, c);","        case 4:\n          value = x + b;")],T_U,'all five scanline filters'),
 # --- the contract's header rules (shared by the server and the Web Admin) -----------------
 ('Q-19',[(CT,"    interlace !== 0\n","    false\n")],T_C,'interlaced'),
 ('Q-20',[(CT,"    width > QR_BACKGROUND_MAX_SIDE ||","")],T_C,'over the maximum'),
 # Q-21 rewritten by FIX-06: the old rule (a minimum of 4) is gone; the quiet zone is WHOLE.
 ('Q-21',[(CT,"    quietZoneModules: z\n      .number()\n      .int()\n","    quietZoneModules: z\n      .number()\n")],T_C,'accepts a quiet zone of 0..16'),
 ('Q-22',[(CT,"  return template.x + template.size <= background.width &&","  return template.x <= background.width &&")],T_I,'outside it'),
 # --- the three delivery sites go through the port --------------------------------------------
 ('Q-23',[BYPASS_IMPORT,(DS,"    const png = (await this.deps.qr.render(scope, { kind: 'PAYLOAD', text: sentUrl })).bytes;","    const png = encodeQrPng(sentUrl);")],T_U,'the delivery card'),
 ('Q-24',[BYPASS_IMPORT,(DS,"        bytes: (await this.deps.qr.render(scope, { kind: 'PAYLOAD', text: sentUrl })).bytes,\n        fileName: 'subscription.png',\n        mimeType: 'image/png' as const,","        bytes: encodeQrPng(sentUrl),\n        fileName: 'subscription.png',\n        mimeType: 'image/png' as const,")],T_U,'changed link'),
 ('Q-25',[BYPASS_IMPORT,(DS,"      bytes = (await this.deps.qr.render(scope, { kind: 'PAYLOAD', text: sentUrl })).bytes;\n    } catch {","      bytes = encodeQrPng(sentUrl);\n    } catch {")],T_U,'the link photo of'),
 ('Q-26',[(DS,"    const png = (await this.deps.qr.render(scope, { kind: 'PAYLOAD', text: sentUrl })).bytes;","    const png = (await this.deps.qr.render(scope, { kind: 'PAYLOAD', text: `${sentUrl}#` })).bytes;")],T_U,'the delivery card'),
 # --- upload and save validation --------------------------------------------------------------
 ('Q-27',[(MS,"    if (!TENANT_MEDIA_PURPOSE_MIME_TYPES[purpose].includes(input.mimeType)) {","    if (false) {")],T_I,'refuses a JPEG'),
 ('Q-28',[(MS,"    if (refusal !== null) {\n      throw errors.validation(COMMERCE_ERROR_CODES.MEDIA_INVALID, refusal.message, {","    if (false) {\n      throw errors.validation(COMMERCE_ERROR_CODES.MEDIA_INVALID, refusal.message, {")],T_I,'refuses a JPEG'),
 ('Q-29',[(QT,"    if (purpose !== 'QR_BACKGROUND') return null;","    if (purpose !== 'REFERRAL_BANNER') return null;")],T_U,'refuses what cannot be drawn on'),
 ('Q-30',[(GS,"    if (stored === null) {\n      return 'Upload a QR background before placing the code on it.';\n    }","")],T_I,'with no background'),
 ('Q-31',[(GS,"    if (qrTemplatePlacementProblem(template, header) !== null) {","    if (false) {")],T_I,'with no background'),
 ('Q-32',[(GS,"      { tenantId: scope.tenantId, botInstanceId: null },\n      'QR_BACKGROUND',","      { tenantId: scope.tenantId, botInstanceId: null },\n      'REFERRAL_BANNER',")],T_I,'with no background'),
 # --- the composition root ----------------------------------------------------------------------
 ('Q-33',[(CN,"      // Phase 2 item 4: a QR template needs a background its region lies inside.\n      new QrTemplateGuard(tenantMediaRepository, probeQrTemplate),\n","")],T_I,'with no background'),
 ('Q-34',[(CN,"    qr: deliveryQrRenderer,","    qr: new PngDeliveryQrRenderer(),")],T_I,'wired into the delivery lane'),
 ('Q-35',[(CN,"      background: (scope) => tenantMediaRepository.content(scope, 'QR_BACKGROUND'),","      background: (scope) => tenantMediaRepository.content(scope, 'REFERRAL_BANNER'),")],T_I,'places the code on it'),
 ('Q-36',[(CN,"    contentCheck: new QrBackgroundContentCheck(),","    contentCheck: { refusal: () => null },")],T_I,'refuses a JPEG'),
 # --- the Web Admin -------------------------------------------------------------------------------
 ('Q-37',[(WP,"        : placement !== null\n          ? t('web.qrt_outside')\n          : tooSmall","        : tooSmall")],T_W,'validates the region'),
 ('Q-38',[(WP,"      const header = inspectQrBackgroundPng(bytes);\n      if (!header.ok) {","      const header = inspectQrBackgroundPng(bytes);\n      if (!header.ok && header.problem === 'EMPTY') {")],T_W,'before uploading anything'),
 ('Q-39',[(WP,"      if (current !== null) {\n        await clearTenantMedia({","      if (current === null) {\n        await clearTenantMedia({")],T_W,'reverts to the default'),
 # --- review of PR #218 --------------------------------------------------------------------------
 ('Q-40',[(QT,"export const QR_COMPOSITE_MAX_BYTES = 1.5 * 1024 * 1024;","export const QR_COMPOSITE_MAX_BYTES = 10 * 1024 * 1024;")],T_U,'composite over 1.5 MiB'),
 ('Q-41',[(QT,"  if (qrEffectiveModulePx(scale, background) < QR_TEMPLATE_MODULE_MIN_PX) {","  if (scale < QR_TEMPLATE_MODULE_MIN_PX) {")],T_U,'after Telegram’s downscale'),
 ('Q-42',[(CT,"  return scale * Math.min(1, QR_TELEGRAM_PHOTO_MAX_SIDE / longest);","  return scale;")],T_C,'as the customer receives it'),
 ('Q-43',[(GS,"    if (unusable !== null) return PROBE_REFUSAL[unusable];","")],T_I,'refuses at save'),
 ('Q-44',[(QT,"    const hit = this.decoded.get(`${scope.tenantId}:${digest}`);","    const hit = undefined;")],T_U,'decodes a background once'),
 ('Q-45',[(QT,"    const cached = this.composed.get(key);","    const cached = undefined;")],T_U,'decodes a background once'),
 ('Q-46',[(PC,"      if (offset !== SIGNATURE_LENGTH + 25) throw corrupt('a second IHDR');","")],T_U,'second IHDR'),
 ('Q-47',[(PC,"    if (length > bytes.length - offset - 12) throw corrupt('a chunk is longer than the file');","")],T_U,'runs past the end'),
 ('Q-48',[(PC,"        if (index * 3 + 2 >= plte.length)\n","        if (false)\n")],T_U,'palette entry past the end'),
 ('Q-49',[(PC,"      if (colourType === 3) paletteAlpha = Buffer.from(data);","")],T_U,'palette tRNS'),
 ('Q-50',[(GS,"    await this.guard.check(scope, actor, MEDIA_VIEW);","")],T_U,'charged settings.view'),
 ('Q-51',[(QT,"      this.onFallback(scope, 'CONFIG_UNREADABLE', error);\n      return plain(modules, 'CONFIG_UNREADABLE');","      this.onFallback(scope, 'BACKGROUND_UNREADABLE', error);\n      return plain(modules, 'BACKGROUND_UNREADABLE');")],T_U,'reading the configuration throws'),
 ('Q-52',[(WP,"          : tooSmall\n            ? t('web.qrt_too_small')\n            : undefined;","          : undefined;")],T_W,'shrink under 4 px'),
 ('Q-53',[(GS,"      describeBackground: true,","      describeBackground: false,")],T_I,'previews a draft'),
 ('Q-54',[(CN,"      backgroundDigest: async (scope) =>\n        (await tenantMediaRepository.find(scope, 'QR_BACKGROUND'))?.sha256 ?? null,","      backgroundDigest: async () => null,")],T_I,'places the code on it'),

 # --- FIX-06 (2026-10-09): the quiet zone is 0..16 whole modules, and 0 is no margin ---------
 ('F06-01',[(CT,"export const QR_TEMPLATE_QUIET_ZONE_MIN = 0;","export const QR_TEMPLATE_QUIET_ZONE_MIN = 4;")],T_C,'accepts a quiet zone of 0..16'),
 ('F06-02',[(CT,"      .min(QR_TEMPLATE_QUIET_ZONE_MIN)\n      .max(QR_TEMPLATE_QUIET_ZONE_MAX),","      .min(QR_TEMPLATE_QUIET_ZONE_MIN),")],T_I,'refuses a quiet zone outside 0..16'),
 ('F06-03',[(CT,"export const QR_TEMPLATE_QUIET_ZONE_DEFAULT = 4;","export const QR_TEMPLATE_QUIET_ZONE_DEFAULT = 0;")],T_W,'proposes the recommended 4'),
 ('F06-04',[(QP,"  const margin = options.margin ?? DEFAULT_MARGIN;","  const margin = options.margin || DEFAULT_MARGIN;")],T_P,'margin 0 with no white border'),
 ('F06-05',[(QP,"  if (!Number.isInteger(margin) || margin < 0 || margin > QR_TEMPLATE_QUIET_ZONE_MAX) {","  if (!Number.isInteger(margin) || margin < 0) {")],T_P,'refuses 17'),
 ('F06-06',[(QT,"    template.quietZoneModules > 0\n","    true\n")],T_U,'leaves its remainder as background'),
 ('F06-07',[(QT,"    template.quietZoneModules > 0\n","    template.quietZoneModules > 4\n")],T_U,'byte for byte as it did'),
 ('F06-08',[(QT,"  const scale = qrModuleScale(template.size, count, template.quietZoneModules);","  const scale = qrModuleScale(template.size, count, template.quietZoneModules || 4);")],T_U,'fills a region of exactly its size'),
 ('F06-09',[(QT,"      : { x: left, y: top, side };","      : { x: left - 1, y: top - 1, side: side + 2 };")],T_U,'fills a region of exactly its size'),
 ('F06-10',[(QT,"    bytes: encodeQrModulesPng(modules, { scale: PLAIN_SCALE, margin: PLAIN_MARGIN }),","    bytes: encodeQrModulesPng(modules, { scale: PLAIN_SCALE, margin: 0 }),")],T_U,'byte for byte the plain QR'),
 ('F06-11',[(WP,"    quietZoneModules: QR_TEMPLATE_QUIET_ZONE_DEFAULT,\n  };","    quietZoneModules: QR_TEMPLATE_QUIET_ZONE_MIN,\n  };")],T_W,'proposes the recommended 4'),
 ('F06-12',[(WP,"    parsedDraft !== null && parsedDraft.quietZoneModules < QR_TEMPLATE_QUIET_ZONE_DEFAULT;","    parsedDraft !== null && !!parsedDraft.quietZoneModules && parsedDraft.quietZoneModules < QR_TEMPLATE_QUIET_ZONE_DEFAULT;")],T_W,'accepts a white margin of 0'),
 ('F06-13',[(WP,"    quietZoneModules: whole(draft.quiet),","    quietZoneModules: whole(draft.quiet) || QR_TEMPLATE_QUIET_ZONE_DEFAULT,")],T_W,'accepts a white margin of 0'),
 ('F06-14',[(WP,"  quiet: String(template.quietZoneModules),","  quiet: String(template.quietZoneModules || QR_TEMPLATE_QUIET_ZONE_DEFAULT),")],T_W,'shows a stored 0 as 0'),
 ('F06-15',[(SQL,QZ_CHECK.format(f"{QZ} BETWEEN 0 AND 17 AND {QZ} = trunc({QZ})"),None)],T_I,'migration 0239'),
 ('F06-16',[(SQL,QZ_CHECK.format(f"{QZ} BETWEEN -1 AND 16 AND {QZ} = trunc({QZ})"),None)],T_I,'migration 0239'),
 ('F06-17',[(SQL,QZ_CHECK.format(f"{QZ} BETWEEN 1 AND 16 AND {QZ} = trunc({QZ})"),None)],T_I,'migration 0239'),
 ('F06-18',[(SQL,QZ_CHECK.format(f"{QZ} BETWEEN 0 AND 16"),None)],T_I,'migration 0239'),
]

DB_URL=os.environ.get('TEST_DATABASE_URL') or os.environ.get('DATABASE_URL') or 'postgres://nexa:nexa@127.0.0.1:5432/nexa_test'

def psql(sql):
  r=subprocess.run(['psql',DB_URL,'-v','ON_ERROR_STOP=1','-qc',sql],capture_output=True,text=True)
  return r.returncode==0, r.stderr.strip()

def sql_mutant(check):
  """Replaces the live 0239 CHECK with `check`. Returns an error string, or None."""
  if not re.search(r'/nexa_test[^/]*$', DB_URL.split('?')[0]):
    return 'the database is not a nexa_test* database'
  ok,err=psql("DELETE FROM setting_values WHERE setting_key = 'delivery.qr_template'; "
    "ALTER TABLE setting_values DROP CONSTRAINT setting_values_qr_template_quiet_zone_check; "
    f"ALTER TABLE setting_values ADD CONSTRAINT setting_values_qr_template_quiet_zone_check CHECK ({check})")
  return None if ok else err

def sql_restore():
  ok,err=psql("DELETE FROM setting_values WHERE setting_key = 'delivery.qr_template'; "
    "ALTER TABLE setting_values DROP CONSTRAINT IF EXISTS setting_values_qr_template_quiet_zone_check; "
    + open(MIG,encoding='utf-8').read())
  if not ok: sys.exit('could not restore the 0239 CHECK: '+err)

def build_package(name):
  return subprocess.run(['pnpm','--filter',name,'build'],capture_output=True).returncode==0

only=sys.argv[1:]
killed=0; ran=0
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  originals={}; ok=True; pkgs=[]; sql=False
  try:
    for f,a,b in edits:
      if f==SQL:
        sql=True; err=sql_mutant(a)
        if err is not None:
          print(mid,'NOT RUN',err,flush=True); ok=False; break
        continue
      s=originals.get(f) or open(f,encoding='utf-8').read()
      originals.setdefault(f,s)
      cur=open(f,encoding='utf-8').read()
      if cur.count(a)!=1:
        print(mid,'ANCHOR MISSING in',f,cur.count(a),flush=True); ok=False; break
      open(f,'w',encoding='utf-8').write(cur.replace(a,b))
    pkgs=sorted({PKG[p] for p in PKG for f in originals if f.startswith(p)})
    if ok and not all(build_package(p) for p in pkgs):
      print(mid,'DOES NOT COMPILE',flush=True); ok=False
    if ok:
      ran+=1
      r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
      out=r.stdout+r.stderr
      failed=[l.strip() for l in out.splitlines() if '×' in l]
      summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
      ran_any=any('passed' in l or 'failed' in l for l in summ)
      # KILLED only when a named test FAILED: a non-zero exit with no × line is a broken run.
      dead=r.returncode!=0 and ran_any and len(failed)>0
      if dead: killed+=1
      print(mid,'KILLED' if dead else 'SURVIVED',summ,failed[:2],flush=True)
  finally:
    for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
    if sql: sql_restore()
    for p in pkgs: build_package(p)
print(f'{killed} of {ran} killed',flush=True)
