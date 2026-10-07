"""Mirza PR3 — the legacy invoice archive: mutation driver (docs/legacy-migration/importer.md §Invoice archive).

Reverts ONE production rule at a time, runs the test that names it, and restores the file.
A mutation that leaves its test green is a rule with no test. Usage:

    python3 scripts/mutate-mirza-pr3.py [ID ...]

The integration (I-*) and database (S-*) mutations need PostgreSQL and Redis and
TEST_DATABASE_URL/DATABASE_URL pointing at a database of YOUR OWN (CLAUDE.md: agents sharing
PostgreSQL are serialised). S-* mutations change that database's schema for one run (a
trigger, a CHECK, an index) through psql and restore it afterwards. Contract mutations (C-*)
rebuild packages/contracts before and after the run.
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages', 'scripts']).returncode != 0:
    sys.exit('apps/, packages/ or scripts/ has uncommitted changes; a mutation restore would discard them')

MOD = 'apps/api/src/modules/platform/legacy-invoice-archive'
ROW = f'{MOD}/domain/invoice-archive-row.ts'
SVC = f'{MOD}/application/legacy-invoice-archive.service.ts'
REPO = f'{MOD}/infrastructure/drizzle-legacy-invoice-archive.repository.ts'
INGEST = 'apps/api/src/modules/platform/legacy-importer/application/invoice-archive-ingest.ts'
READSET = 'apps/api/src/modules/platform/legacy-importer/application/invoice-archive-read-set.ts'
CTRL = 'apps/api/src/surfaces/web/legacy-invoices.controller.ts'
PERMS = 'packages/contracts/src/permissions.ts'
ARCH = 'packages/contracts/src/legacy-invoice-archive.ts'
PAGE = 'apps/web/src/pages/legacy-invoices.tsx'
NAV = 'apps/web/src/nav.ts'

T_DOM = ('unit', 'tests/unit/legacy-invoice-archive-domain.test.ts')
T_RS = ('unit', 'tests/unit/legacy-invoice-archive-read-set.test.ts')
T_BOUND = ('unit', 'tests/unit/legacy-invoice-archive-boundary.test.ts')
T_INT = ('integration', 'tests/integration/legacy-invoice-archive.test.ts')
T_PLAN = ('integration', 'tests/integration/legacy-invoice-archive-plan.test.ts')
T_WEB = ('web', 'tests/web/legacy-invoices.test.tsx')

M = [
    # The class order is the importer's: the key shape first, then the test flag, ...
    ('D-01', [(ROW, "  if (!facts.keyShapeEvidenced) return 'KEY_SHAPE_UNRECOGNISED';\n", "")], T_DOM, 'source-derived class'),
    # ... and an empty panel code is never a candidate (owner decision 8).
    ('D-02', [(ROW, "  if (facts.panelCode === null) return 'NO_PANEL';\n", "")], T_DOM, 'source-derived class'),
    # Statuses are compared exactly, as the importer does.
    ('D-03', [(ROW, "  const live = status !== null && LIVE.has(status);", "  const live = status !== null && LIVE.has(status.trim().toLowerCase());")], T_DOM, 'exactly'),
    # A digit string outside [2015, 2100) is never an instant.
    ('D-04', [(ROW, "  if (seconds < TIME_SELL_EARLIEST_SECONDS || seconds >= TIME_SELL_LATEST_SECONDS) {", "  if (false) {")], T_DOM, 'time_sell'),
    # A revision compares the cells AND their context.
    ('D-05', [(ROW, "  if (latest.archiveChecksum === staged.archiveChecksum) return { kind: 'UNCHANGED' };", "  if (latest.rowChecksum === staged.rowChecksum) return { kind: 'UNCHANGED' };")], T_DOM, 'revision'),
    ('D-06', [(ROW, "      row: rowChecksum,\n      ownerPresent: context.ownerPresent,\n", "      row: rowChecksum,\n")], T_DOM, 'context'),
    # A NUL cell fails closed rather than being altered.
    ('D-07', [(ROW, "    if (cell !== null && cell.includes('\\u0000')) return column;\n", "")], T_DOM, 'PostgreSQL cannot hold'),
    # The read set never names a secret-bearing column.
    ('R-01', [(READSET, "        'notifctions',\n      ],", "        'notifctions',\n        'user_info',\n      ],")], T_RS, 'never names'),
    ('R-02', [(READSET, "        'notifctions',\n      ],", "        'notifctions',\n        'user_info',\n      ],")], T_INT, 'never stores'),
    # The HTTP surface writes nothing.
    ('B-01', [(CTRL, "  @Get(LEGACY_INVOICE_ARCHIVE_ROUTES.summary)", "  // @Post(\n  @Get(LEGACY_INVOICE_ARCHIVE_ROUTES.summary)")], T_BOUND, 'read-only'),
    # Any error during the read fails the run: nothing archived, staging deleted.
    ('I-01', [(INGEST, "            await deps.archive\n              .failRun(scope, actor, started.id, failureFor(error))\n              .catch(() => null);\n", "")], T_INT, 'diverges'),
    # A STAGING run left behind is discarded before a new read.
    ('I-02', [(INGEST, "    if (open?.state === 'STAGING') {", "    if (false) {")], T_INT, 'crash mid-staging'),
    # A VERIFIED run left behind is finished first, from staging.
    ('I-03', [(INGEST, "    } else if (open?.state === 'VERIFIED') {", "    } else if (false) {")], T_INT, 'crash mid-promotion'),
    # Revisions of a run that is not COMPLETED are invisible.
    ('I-04', [(REPO, "    const conditions: SQL[] = [eq(a.tenantId, tenantId), VISIBLE, LATEST_VISIBLE];", "    const conditions: SQL[] = [eq(a.tenantId, tenantId), LATEST_VISIBLE];")], T_INT, 'crash mid-promotion'),
    # An unchanged invoice writes nothing.
    ('I-05', [(SVC, "        if (decision.kind === 'UNCHANGED') {", "        if (false) {")], T_INT, 'idempotent'),
    # Personal cells are redacted without the PII key, and searching by them needs it.
    ('I-06', [(SVC, "      rows: page.map((record) => ({\n        record: pii ? record : redactRecord(record),", "      rows: page.map((record) => ({\n        record,")], T_INT, 'redacts'),
    ('I-07', [(SVC, "      await this.requirePii(scope, actor, LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.piiSearch, null);\n", "")], T_INT, 'redacts'),
    # Scope activity is read inside the transaction.
    ('I-08', [(SVC, "        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {", "        if (false) {")], T_INT, 'stopped tenant'),
    # Tenant isolation at the repository.
    ('I-09', [(REPO, "      .where(and(eq(a.tenantId, tenantId), eq(a.id, id), VISIBLE))", "      .where(and(eq(a.id, id), VISIBLE))")], T_INT, 'keeps tenants apart'),
    # Two source rows sharing a key are refused, never collapsed.
    ('I-10', [(SVC, "      if (inserted !== objects.length) {", "      if (false) {")], T_INT, 'sharing an invoice id'),
    # The staged rows must add up to the read.
    ('I-11', [(SVC, "        const agrees =\n          staged.invoice === BigInt(evidence.invoiceRows) &&", "        const agrees =\n          true ||")], T_INT, 'do not add up'),
    # The permission is MEDIUM: a LOW key is handed to every observer.
    ('C-01', [(PERMS, "  p('legacy.invoices.view', 'View the legacy invoice archive (personal data redacted)', 'MEDIUM'),", "  p('legacy.invoices.view', 'View the legacy invoice archive (personal data redacted)', 'LOW'),")], T_INT, 'operator and observer'),
    # `refral` is personal data.
    ('C-02', [(ARCH, "export const LEGACY_INVOICE_PII_COLUMNS = ['id_user', 'username', 'refral', 'note'] as const;", "export const LEGACY_INVOICE_PII_COLUMNS = ['id_user', 'username', 'note'] as const;")], T_DOM, 'redaction'),
    # The page never sends a PII search for a reader without the key.
    ('W-01', [(PAGE, "  if (mayViewPii) {", "  if (true) {")], T_WEB, 'never puts a PII filter'),
    ('W-02', [(NAV, "    permission: 'legacy.invoices.view',\n    group: 'web.navgroup_sales',", "    permission: ['orders.view', 'legacy.invoices.view'],\n    group: 'web.navgroup_sales',")], T_WEB, 'gated'),
]

# Database guards: (id, break SQL, restore SQL, test, filter).
S = [
    ('S-01', 'DROP TRIGGER legacy_invoice_archive_no_update ON legacy_invoice_archive',
     'CREATE TRIGGER legacy_invoice_archive_no_update BEFORE UPDATE ON legacy_invoice_archive '
     'FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation()', T_INT, 'append-only'),
    ('S-02', 'ALTER TABLE legacy_invoice_archive DROP CONSTRAINT legacy_invoice_archive_class_check',
     None, T_INT, 'append-only'),
    ('S-03', 'DROP INDEX legacy_invoice_archive_status_idx',
     'CREATE INDEX legacy_invoice_archive_status_idx ON legacy_invoice_archive '
     'USING btree (tenant_id, status, invoice_key)', T_PLAN, 'rare status'),
]


def rebuild_contracts():
    subprocess.run(['pnpm', '--filter', '@nexa/contracts', 'build'], capture_output=True, check=True)


def run_test(project, test, filt):
    r = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--project', project, test, '-t', filt],
                       capture_output=True, text=True)
    out = r.stdout + r.stderr
    return r.returncode, [line.strip() for line in out.splitlines() if 'Tests ' in line]


def psql(statement):
    url = os.environ.get('TEST_DATABASE_URL') or sys.exit('TEST_DATABASE_URL is required for S-*')
    subprocess.run(['psql', url, '-v', 'ON_ERROR_STOP=1', '-qc', statement], check=True)


CLASS_CHECK_SQL = None
only = sys.argv[1:]
killed = 0
ran = 0
for mid, edits, (project, test), filt in M:
    if only and mid not in only:
        continue
    originals = {}
    ok = True
    for f, a, b in edits:
        cur = open(f).read()
        originals.setdefault(f, cur)
        if cur.count(a) != 1:
            print(mid, 'ANCHOR MISSING in', f, cur.count(a), flush=True)
            ok = False
            break
        open(f, 'w').write(cur.replace(a, b))
    contract = any(f.startswith('packages/contracts') for f, _, _ in edits)
    if ok:
        if contract:
            rebuild_contracts()
        ran += 1
        code, summ = run_test(project, test, filt)
        if code != 0:
            killed += 1
        print(mid, 'KILLED' if code != 0 else 'SURVIVED', summ, flush=True)
    for f, s in originals.items():
        open(f, 'w').write(s)
    if contract:
        rebuild_contracts()

for mid, broken, restore, (project, test), filt in S:
    if only and mid not in only:
        continue
    if mid == 'S-02':
        url = os.environ.get('TEST_DATABASE_URL') or sys.exit('TEST_DATABASE_URL is required')
        definition = subprocess.run(
            ['psql', url, '-Atc', "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
             "WHERE conname = 'legacy_invoice_archive_class_check'"],
            capture_output=True, text=True, check=True).stdout.strip()
        restore = f'ALTER TABLE legacy_invoice_archive ADD CONSTRAINT legacy_invoice_archive_class_check {definition}'
    psql(broken)
    try:
        ran += 1
        code, summ = run_test(project, test, filt)
        if code != 0:
            killed += 1
        print(mid, 'KILLED' if code != 0 else 'SURVIVED', summ, flush=True)
    finally:
        # A mutated run may have left rows the restored guard would refuse: this is YOUR
        # test database (see the docstring), and the suite truncates it before every test.
        psql('TRUNCATE legacy_invoice_archive, legacy_invoice_archive_staging, '
             'legacy_invoice_archive_runs CASCADE')
        psql(restore)
print(f'{killed} of {ran} killed', flush=True)
