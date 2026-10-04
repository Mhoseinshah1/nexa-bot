"""Issue 16 mutation driver (docs/perf/web-admin-navigation.md).

Reverts one rule of the Web Admin navigation work at a time, runs the test that names it,
and restores the file with `git checkout --`. Prints KILLED (the test failed, as it must) or
SURVIVED (it did not: the rule has no test).

The two index mutations delete an ONLINE index declaration (`online-indexes.ts`). Those
indexes are built outside the migrator, so the mutation also drops the index from the test
database before the plan test runs, and rebuilds it afterwards with the compiled migrator
(`apps/api/dist`, so run `pnpm build` first). They need TEST_DATABASE_URL pointing at a
database nothing else is using, and are SKIPPED without it; the web and unit mutations need
no database.

Refuses a dirty apps/ tree, because the restore would discard it.
Usage: TEST_DATABASE_URL=postgres://... python3 scripts/mutate-web-nav-perf.py [NP-01 ...]
"""
import os, subprocess, sys
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps']).returncode != 0:
  sys.exit('apps/ has uncommitted changes; a mutation restore would discard them')
DB = os.environ.get('TEST_DATABASE_URL')

OI = 'apps/api/src/infrastructure/persistence/online-indexes.ts'
NP = 'apps/web/src/nav-prefetch.ts'
SHELL = 'apps/web/src/shell.tsx'
APP = 'apps/web/src/app.tsx'
USERS = 'apps/web/src/pages/users.tsx'
AUDIT = 'apps/web/src/pages/audit-log.tsx'
HTML = 'apps/web/index.html'
QC = 'apps/web/src/query-client.ts'

T_NAV = ('web', 'tests/web/nav-prefetch.test.tsx')
T_PLAN = ('integration', 'tests/integration/reporting-plan.test.ts')
T_ICON = ('unit', 'tests/unit/web-index-icon.test.ts')

# The whole declaration of each online index, exactly as committed.
ORDERS_BLOCK = '  {\n    /*\n     * The sales a report counts: PAID orders by the instant they settled (Issue 16,\n     * `docs/perf/web-admin-navigation.md`).\n     *\n     * Every windowed sales aggregate in `DrizzleReportingRepository` — `salesTotals`,\n     * `trend`, `salesTrendByPurpose`, `revenueCurrencies`, `activeCustomers` — reads\n     * `tenant_id = $t AND state = \'PAID\' AND settled_at in [from, to)`, and the only index\n     * naming `state` was `(tenant_id, state)`. So each of them, 29 statements per\n     * `GET /dashboard/summary`, read the tenant\'s whole order history: a sequential scan\n     * measured at 1.2–1.6 s per dashboard request on 320 000 orders, on every visit.\n     *\n     * PARTIAL on PAID, which is the one state every one of those statements names.\n     * INCLUDE carries the columns they group, filter and sum — currency, purpose, origin,\n     * the three amounts and the customer — so a window is an index-only range scan and\n     * the heap is not touched for a visible page. Measured on that dataset: `salesTotals`\n     * 435 → 97 ms over its eight calls, `trend` 257 → 33, `salesTrendByPurpose` 65 → 16.\n     * Concurrently, because every settlement writes this table.\n     */\n    name: \'orders_tenant_paid_settled_idx\',\n    definition:\n      \'ON "orders" USING btree ("tenant_id","settled_at") \' +\n      \'INCLUDE ("currency","purpose","origin","total_amount","subtotal_amount",\' +\n      \'"discount_amount","customer_id") \' +\n      "WHERE (state = \'PAID\'::text)",\n  },\n'
PAYMENTS_BLOCK = '  {\n    /*\n     * Failed payments by the instant they were resolved: `paymentFailures`, twice per\n     * `GET /dashboard/summary` and once per `GET /reports/failures` (Issue 16).\n     *\n     * `resolved_at` is set exactly when a payment is FAILED, CANCELLED or EXPIRED\n     * (`payments_resolved_check`), so the partial predicate holds precisely the rows the\n     * statement can count, and a window on it implies the predicate. INCLUDE `state`\n     * because the statement counts by it. Measured on 320 000 payments: 114 ms → 7 ms over\n     * the three calls, which had been a sequential scan of the tenant\'s payments.\n     */\n    name: \'payments_tenant_resolved_idx\',\n    definition:\n      \'ON "payments" USING btree ("tenant_id","resolved_at") INCLUDE ("state") \' +\n      \'WHERE (resolved_at IS NOT NULL)\',\n  },\n'

# (id, edits, test, -t filter, index the mutation also drops from the test database)
M = [
 ('NP-01', [(USERS, "    staleTime: NAV_PREFETCH_FRESH_MS,\n  };\n}\n\n/** What `/users` asks",
                    "    staleTime: 0,\n  };\n}\n\n/** What `/users` asks")],
  T_NAV, 'the page arriving after it does not ask again', None),
 ('NP-02', [(SHELL, "                    onPointerEnter={() => onIntent?.(entry.path)}\n", "")],
  T_NAV, 'bare page answer a filtered one', None),
 ('NP-03', [(NP, " || !permissions.includes(entry.permission)", "")],
  T_NAV, 'own permission the actor does not hold', None),
 ('NP-04', [(APP, "<div className={`app ${collapsed ? 'collapsed' : ''}`}>",
                  "<div key={route.path} className={`app ${collapsed ? 'collapsed' : ''}`}>")],
  T_NAV, 'keeps the same sidebar and top bar', None),
 ('NP-05', [(AUDIT, "queryKey: ['audit-log', JSON.stringify(filters), cursor ?? null],",
                    "queryKey: ['audit-log', cursor ?? null],")],
  T_NAV, 'bare page answer a filtered one', None),
 ('NP-06', [(USERS, "queryKey: ['customers', searchSignature, cursor ?? null],",
                    "queryKey: ['customers', cursor ?? null],")],
  T_NAV, 'bare customer list answer a searched one', None),
 ('NP-07', [(HTML, '    <link rel="icon" href="data:," />\n', '')],
  T_ICON, 'declares an icon that needs no request', None),
 ('NP-10', [(SHELL, "                    onFocus={() => onIntent?.(entry.path)}\n", "")],
  T_NAV, 'prefetches on keyboard focus', None),
 ('NP-11', [(QC, "void client.invalidateQueries({ queryKey: ['audit-log'] });", "")],
  T_NAV, 'reads the audit log again after a write', None),
 ('NP-08', [(OI, ORDERS_BLOCK, '')],
  T_PLAN, 'orders_tenant_paid_settled_idx', 'orders_tenant_paid_settled_idx'),
 ('NP-09', [(OI, PAYMENTS_BLOCK, '')],
  T_PLAN, 'payments_tenant_resolved_idx', 'payments_tenant_resolved_idx'),
]

DROP = '''
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
c.connect()
  .then(() => c.query(`DROP INDEX IF EXISTS "${process.argv[1]}"`))
  .then(() => c.end(), (e) => { console.error(e.message); process.exit(1); });
'''

def drop_index(name):
  subprocess.run(['node', '-e', DROP, name], check=True, cwd='apps/api')

def rebuild_online_indexes():
  subprocess.run(['node', 'apps/api/dist/infrastructure/persistence/migrate.js'], check=True,
                 capture_output=True, env={**os.environ, 'DATABASE_URL': DB})

only = sys.argv[1:]
for mid, edits, (project, test), filt, index in M:
  if only and mid not in only: continue
  if index is not None and DB is None:
    print(mid, 'SKIPPED (needs TEST_DATABASE_URL)', flush=True); continue
  files = set(); ok = True
  for f, a, b in edits:
    s = open(f).read()
    if s.count(a) != 1:
      print(mid, 'ANCHOR MISSING in', f, s.count(a), flush=True); ok = False; break
    open(f, 'w').write(s.replace(a, b)); files.add(f)
  try:
    if ok:
      if index is not None: drop_index(index)
      r = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--project', project, test, '-t', filt],
                         capture_output=True, text=True)
      out = r.stdout + r.stderr
      failed = [l.strip() for l in out.splitlines() if '×' in l]
      summ = [l.strip() for l in out.splitlines() if 'Tests ' in l]
      print(mid, 'KILLED' if r.returncode != 0 else 'SURVIVED', summ, failed[:3], flush=True)
  finally:
    for f in files: subprocess.run(['git', 'checkout', '--', f])
    if index is not None and ok: rebuild_online_indexes()
