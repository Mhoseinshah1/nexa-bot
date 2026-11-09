#!/usr/bin/env bash
# data-export-mutation.sh - the mutation check of the phase 6B PR-3 open data export.
#
#   TEST_DATABASE_URL=... DATABASE_URL=... bash scripts/claude/data-export-mutation.sh [name...]
#
# Each mutation breaks ONE rule of the export in the source, runs the tests that guard the
# rule through run-gate.sh, and passes only when they go RED; the files are restored from git
# afterwards (so they must have no uncommitted change). With no name it runs every mutation.
# Exit 0 only when every mutation was caught. The integration mutations run the suite, so the
# two URLs must name a PRIVATE database.
#
#   inventory-secret    a bearer link (services.subscription_url) becomes an exported column
#   no-bom              the CSV loses its UTF-8 byte order mark
#   no-formula-guard    a text cell can start a spreadsheet formula
#   money-float         money is printed through a float
#   no-tenant-filter    the SELECTs lose `tenant_id = $1` AND the customers policy is gone
#   link-never-expires  the 24 h deadline is not checked on download
#   installation-ok     the installation's own tenant can be exported
#   short-deadline      the worker's deadline is no longer 24 h
#   never-class         tenant_data_exports loses its NEVER classification
#   host-tenant-bound   the host door's insert binds the hosted tenant instead of the system path
set -uo pipefail

if [[ -z "${TEST_DATABASE_URL:-}" || "${TEST_DATABASE_URL}" != "${DATABASE_URL:-}" ]]; then
  echo "data-export-mutation: set TEST_DATABASE_URL and DATABASE_URL to the same private database" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2
exec python3 - "$@" <<'PY'
import os, subprocess, sys

DX = "apps/api/src/modules/platform/data-export"
UNIT = ["pnpm", "exec", "vitest", "run", "--project", "unit",
        "tests/unit/data-export-inventory.test.ts", "tests/unit/data-export-files.test.ts",
        "tests/unit/data-export-runner.test.ts", "tests/unit/tenant-archive-inventory.test.ts"]
INT = ["pnpm", "exec", "vitest", "run", "--project", "integration",
       "tests/integration/isolation-proof/data-export.test.ts",
       "tests/integration/data-export-host.test.ts"]

# name -> (kind, env, [(file, old, new), ...])
MUTATIONS = {
    "inventory-secret": ("unit", {}, [
        (f"{DX}/application/data-export-inventory.ts",
         "      subscription_url: 'a bearer link: whoever holds it uses the service',\n", ""),
        (f"{DX}/application/data-export-inventory.ts",
         "      col('provider_username', 'text', 'نام کاربری سرویس در پنل.'),\n",
         "      col('provider_username', 'text', 'نام کاربری سرویس در پنل.'),\n"
         "      col('subscription_url', 'text', 'x'),\n"),
    ]),
    "no-bom": ("unit", {}, [
        (f"{DX}/infrastructure/csv.ts", "export const UTF8_BOM = String.fromCharCode(0xfeff);", "export const UTF8_BOM = '';"),
    ]),
    "no-formula-guard": ("unit", {}, [
        (f"{DX}/infrastructure/csv.ts",
         "return /^[=+\\-@\\t\\r]/u.test(text) ? `'${text}` : text;", "return text;"),
    ]),
    "money-float": ("integration", {}, [
        (f"{DX}/infrastructure/data-export-writer.ts",
         "    : sql`${name}::text`;",
         "    : column.kind === 'money_minor'\n"
         "      ? sql`(${name}::float8)::numeric(40,0)::text`\n"
         "      : sql`${name}::text`;"),
    ]),
    "no-tenant-filter": ("integration",
        {"NEXA_ISOLATION_MUTATION_DROP_POLICY": "customers", "NEXA_ISOLATION_MUTATION_DISABLE_RLS": "1"}, [
        (f"{DX}/infrastructure/data-export-writer.ts",
         "WHERE tenant_id = ${tenantId}::uuid ORDER BY ${sql.join(\n    dataset.orderBy",
         "WHERE ${tenantId}::uuid IS NOT NULL ORDER BY ${sql.join(\n    dataset.orderBy"),
    ]),
    "link-never-expires": ("integration", {}, [
        (f"{DX}/application/data-export.service.ts",
         "row.state === 'EXPIRED' ||", "false &&"),
    ]),
    "installation-ok": ("integration", {}, [
        (f"{DX}/application/data-export.service.ts",
         "installation === null || scope.tenantId.toLowerCase() === installation.toLowerCase()",
         "installation === null"),
    ]),
    "short-deadline": ("unit", {}, [
        (f"{DX}/application/data-export.runner.ts",
         "expiresAt: new Date(now.getTime() + DATA_EXPORT_TTL_MS),",
         "expiresAt: new Date(now.getTime() + 60_000),"),
    ]),
    "host-tenant-bound": ("integration", {}, [
        (f"{DX}/infrastructure/drizzle-data-export.repository.ts",
         "  return open === undefined ? withSystemScope(reason, fn) : withSystemScopeIn(open, reason, fn);",
         "  return open === undefined ? withSystemScope(reason, fn) : fn();"),
    ]),
    "never-class": ("unit", {}, [
        ("apps/api/src/modules/platform/backup/application/tenant-archive-inventory.ts",
         "  tenant_data_exports:", "  tenant_data_exports_mutated:"),
    ]),
}

wanted = sys.argv[1:]
unknown = [name for name in wanted if name not in MUTATIONS]
if unknown:
    print("data-export-mutation: unknown mutation:", ", ".join(unknown), file=sys.stderr)
    sys.exit(2)
failed = False
for name, (kind, env, edits) in MUTATIONS.items():
    if wanted and name not in wanted:
        continue
    files = sorted({file for file, _old, _new in edits})
    if subprocess.run(["git", "diff", "--quiet", "--", *files]).returncode != 0:
        print(f"data-export-mutation: {', '.join(files)} has uncommitted changes; commit first", file=sys.stderr)
        sys.exit(2)
    try:
        for file, old, new in edits:
            text = open(file, encoding="utf-8").read()
            if text.count(old) != 1:
                print(f"== {name}: the mutation did not apply (the source moved): {old[:50]!r}")
                raise SystemExit(1)
            open(file, "w", encoding="utf-8").write(text.replace(old, new))
        print(f"== data-export-mutation: {name} ({kind})", flush=True)
        gate = ["bash", "scripts/claude/run-gate.sh"] + (["--integration"] if kind == "integration" else [])
        done = subprocess.run(gate + (INT if kind == "integration" else UNIT),
                              env={**os.environ, **env}, capture_output=True, text=True)
        for line in done.stdout.splitlines():
            if line.startswith(("passed=", "exit=")):
                print(line)
        if done.returncode == 0:
            print(f"== {name}: NOT CAUGHT (the tests stayed green)")
            failed = True
        else:
            print(f"== {name}: caught")
    except SystemExit:
        failed = True
    finally:
        subprocess.run(["git", "checkout", "-q", "--", *files])
sys.exit(1 if failed else 0)
PY
