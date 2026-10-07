#!/usr/bin/env python3
"""Mutation check for roadmap B5 (Customer 360 workspace) and B6 (attention-first dashboard).

Each mutation reverts ONE rule in the source, runs the suites that name it, and expects at
least one test to FAIL; the file is restored whatever happens. A mutation that leaves the
suite green is reported as SURVIVED and the script exits non-zero.

    python3 scripts/mutate-customer360-dashboard.py            # web mutations only
    python3 scripts/mutate-customer360-dashboard.py --api      # also the API ones (needs
                                                               # TEST_DATABASE_URL and
                                                               # DATABASE_URL on your own DB)

Run it from the repository root on a clean tree. It never commits anything.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WEB_TESTS = [
    'tests/web/customer-workspace.test.tsx',
    'tests/web/tickets.test.tsx',
    'tests/unit/dashboard-aggregates.test.ts',
    'tests/web/dashboard-attention.test.tsx',
    'tests/web/dashboard.test.tsx',
]
API_TESTS = [
    'tests/integration/customer-workspace.test.ts',
    'tests/integration/dashboard.test.ts',
]

SERVICE = 'apps/api/src/modules/commerce/customers/application/customer-insight.service.ts'
READER = 'apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer-insight.reader.ts'
OVERVIEW = 'apps/api/src/modules/commerce/reporting/infrastructure/drizzle-operations-overview.repository.ts'
VIEW = 'apps/web/src/attention-view.ts'
QUEUE = 'apps/web/src/pages/dashboard-attention.tsx'
WORKSPACE = 'apps/web/src/pages/customer-360-workspace.tsx'
PAGE = 'apps/web/src/pages/customer-360.tsx'
APP = 'apps/web/src/app.tsx'
NAV = 'apps/web/src/nav-counters.ts'

# (name, kind, file, before, after)
MUTATIONS = [
    # --- API -----------------------------------------------------------------------------
    ('A1 tickets section computed without tickets.view', 'api', SERVICE,
     "may('tickets') ? reader.tickets", "true ? reader.tickets"),
    ('A2 payments section computed without payments.view', 'api', SERVICE,
     "may('payments')\n        ? Promise.all", "true\n        ? Promise.all"),
    ('A3 handoffs section computed without business_chats.view', 'api', SERVICE,
     "may('businessHandoffs') ? reader", "true ? reader"),
    ('A4 workspace does not charge users.view', 'api', SERVICE,
     "    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);\n    const parsed",
     "    const parsed"),
    ('A5 tickets awaiting support include WAITING_FOR_CUSTOMER', 'api', READER,
     "AND k.status = ANY(${textArray(TICKET_AWAITING_SUPPORT_STATUSES)})",
     "AND k.status <> 'CLOSED'"),
    ('A6 handoffs not scoped to the customer', 'api', READER,
     "WHERE c.tenant_id = ${tenantId} AND c.customer_id = ${customerId}\n                 AND c.state = 'HANDOFF_REQUIRED'`,",
     "WHERE c.tenant_id = ${tenantId}\n                 AND c.state = 'HANDOFF_REQUIRED'`,"),
    ('A11 the named handoff is the oldest, not the newest', 'api', READER,
     "ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC",
     "ORDER BY COALESCE(c.last_message_at, c.created_at) ASC, c.id ASC"),
    ('A12 the awaiting-support facet ignored by the ticket list', 'api',
     'apps/api/src/surfaces/web/tickets.controller.ts',
     "      ...(input.awaiting === 'support' ? { awaitingSupport: true } : {}),\n", ""),
    ('A7 latest orders oldest first', 'api', READER,
     "      FROM orders\n      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}\n      ORDER BY created_at DESC, id DESC",
     "      FROM orders\n      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}\n      ORDER BY created_at ASC, id ASC"),
    ('A8 latest payments tie-broken the wrong way', 'api', READER,
     "      FROM payments\n      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}\n      ORDER BY created_at DESC, id DESC",
     "      FROM payments\n      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}\n      ORDER BY created_at DESC, id ASC"),
    ('A9 a workspace count reads every row', 'api', READER,
     "return sql`SELECT count(*)::int AS n FROM (${rows} LIMIT ${cap}) capped`;",
     "return sql`SELECT count(*)::int AS n FROM (${rows}) capped`;"),
    ('A10 handoff counter counts every conversation', 'api', OVERVIEW,
     "WHERE c.tenant_id = ${t} AND (c.state = 'HANDOFF_REQUIRED')`",
     "WHERE c.tenant_id = ${t}`"),
    # --- Web -----------------------------------------------------------------------------
    ('W1 diagnostics asked without opslog.view', 'web', QUEUE,
     "    refetchInterval: pollUnlessFinal(DIAGNOSTICS_REFRESH_MS),\n    enabled: mayViewOps,",
     "    refetchInterval: pollUnlessFinal(DIAGNOSTICS_REFRESH_MS),\n    enabled: asked,"),
    ('W2 payment queues asked without payments.view', 'web', QUEUE,
     "    refetchInterval: pollUnlessFinal(BUSINESS_REFRESH_MS),\n    enabled: mayViewPayments,",
     "    refetchInterval: pollUnlessFinal(BUSINESS_REFRESH_MS),\n    enabled: asked,"),
    ('W3 the queue drawn for a viewer holding none of its permissions', 'web', QUEUE,
     "  if (!asked) return null;\n", ""),
    ('W4 "empty" claimed over a failed source', 'web', QUEUE,
     "failed || pending ? null : (", "pending ? null : ("),
    ('W5 a zero drawn as a row', 'web', VIEW,
     "    if (count === null || count === undefined || count <= 0) return;\n    items.push({ key, label, count, atLeast",
     "    if (count === null || count === undefined || count < 0) return;\n    items.push({ key, label, count, atLeast"),
    ('W6 a capped counter drawn as exact', 'web', VIEW,
     "atLeast: cap !== null && count >= cap", "atLeast: false"),
    ('W7 a retrying operation counted as stuck', 'web', VIEW,
     "counts.LEASE_EXPIRED + counts.UNANNOUNCED,", "counts.LEASE_EXPIRED + counts.UNANNOUNCED + counts.RETRYING,"),
    ('W8 customer attention link loses the customer filter', 'web', VIEW,
     "`/payments?q=${q}&queue=UNKNOWN`", "'/payments?queue=UNKNOWN'"),
    ('W9 customer tickets asked without tickets.view', 'web', WORKSPACE,
     "    queryFn: () => fetchTickets({ customer: customerId, limit: CUSTOMER_TICKETS_SHOWN }),\n    enabled: mayView,",
     "    queryFn: () => fetchTickets({ customer: customerId, limit: CUSTOMER_TICKETS_SHOWN }),\n    enabled: true,"),
    ('W10 payments shortcut offered without payments.view', 'web', WORKSPACE,
     "      allowed: may.payments,", "      allowed: true,"),
    ('W11 route derives tickets from users.view', 'web', APP,
     "mayViewTickets={may('tickets.view')}", "mayViewTickets={may('users.view')}"),
    ('W12 route derives the handoff shortcut from users.view', 'web', APP,
     "mayViewBusinessChats={may('business_chats.view')}", "mayViewBusinessChats={may('users.view')}"),
    ('W13 sidebar drops the handoff badge', 'web', NAV,
     "  one('business-chats', c.businessHandoffs, 'warn');\n", ""),
    ('W15 B1: the handoff counter required on the wire again', 'web',
     'packages/contracts/src/dashboard.ts',
     "businessHandoffs: counter.optional().transform((value) => value ?? null),",
     "businessHandoffs: counter,"),
    ('W16 N3: "nothing waits" drawn over a withheld counting section', 'web', WORKSPACE,
     "workspaceWithheld(data) ? null : <AttentionClear", "false ? null : <AttentionClear"),
    ('W17 N3: the latest orders reported as a withheld count', 'web', VIEW,
     "const COUNTING_SECTIONS: readonly CountingSection[] = [\n  'tickets',",
     "const COUNTING_SECTIONS: readonly (CountingSection | 'orders')[] = [\n  'orders',\n  'tickets',"),
    ('W18 N1: the tickets row links to every status', 'web', VIEW,
     "    '/tickets?awaiting=support',", "    '/tickets',"),
    ('W19 N2: a single handoff links to the tenant inbox', 'web', VIEW,
     "handoffs === 1 && conversation !== null", "false"),
    ('W20 N1: the inbox drops the awaiting facet', 'web', 'apps/web/src/pages/tickets.tsx',
     "    ...(awaiting === null ? {} : { awaiting }),\n", ""),
    ('W21 N5: the sidebar counters asked one after another', 'web',
     'apps/api/src/modules/commerce/reporting/application/operations-overview.service.ts',
     "    const values = await Promise.all(\n      NAV_COUNTER_KEYS.map((key) =>\n"
     "        held.has(NAV_COUNTER_PERMISSIONS[key])\n"
     "          ? this.deps.repository.navCounter(scope, key, this.deps.counterCap)\n"
     "          : null,\n      ),\n    );",
     "    const values: (number | null)[] = [];\n    for (const key of NAV_COUNTER_KEYS) {\n"
     "      values.push(held.has(NAV_COUNTER_PERMISSIONS[key])\n"
     "        ? await this.deps.repository.navCounter(scope, key, this.deps.counterCap)\n"
     "        : null);\n    }"),
    ('W14 the latest card links a withheld half to its list', 'web', WORKSPACE,
     "                {data.payments !== null && (\n                  <a href={`/payments?q=${q}`}",
     "                {(\n                  <a href={`/payments?q=${q}`}"),
]


def build_contracts(env):
    # Tests import `@nexa/contracts` from its dist, so a contract mutant needs a rebuild.
    subprocess.run(['pnpm', '--filter', '@nexa/contracts', 'build'], cwd=ROOT, env=env,
                   capture_output=True, text=True, check=True)


def run(tests, env):
    command = ['pnpm', '-s', 'vitest', 'run', *tests]
    result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True)
    return result.returncode


def main():
    with_api = '--api' in sys.argv
    env = dict(os.environ)
    if with_api and ('TEST_DATABASE_URL' not in env or 'DATABASE_URL' not in env):
        print('--api needs TEST_DATABASE_URL and DATABASE_URL set to your own database')
        return 2
    survived = []
    for name, kind, path, before, after in MUTATIONS:
        if kind == 'api' and not with_api:
            continue
        full = os.path.join(ROOT, path)
        original = open(full, encoding='utf-8').read()
        if original.count(before) != 1:
            print(f'SKIP?  {name}: anchor found {original.count(before)} times in {path}')
            survived.append(name)
            continue
        contract = path.startswith('packages/contracts/')
        try:
            open(full, 'w', encoding='utf-8').write(original.replace(before, after, 1))
            if contract:
                build_contracts(env)
            code = run(API_TESTS if kind == 'api' else WEB_TESTS, env)
        finally:
            open(full, 'w', encoding='utf-8').write(original)
            if contract:
                build_contracts(env)
        verdict = 'KILLED' if code != 0 else 'SURVIVED'
        print(f'{verdict:8} {name}', flush=True)
        if code == 0:
            survived.append(name)
    if survived:
        print('\nSurvived or not applied:', *survived, sep='\n  ')
        return 1
    print('\nEvery mutation was killed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
