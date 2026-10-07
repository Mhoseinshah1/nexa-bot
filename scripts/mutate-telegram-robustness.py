"""Roadmap D1-D5 (Telegram robustness) mutation driver.

Each mutation replaces ONE exact string, runs the named suite, expects it to FAIL, and restores
the file byte for byte (also on Ctrl-C). Integration runs need TEST_DATABASE_URL/DATABASE_URL
pointing at a dedicated database (never one another agent is using).

Usage:  python3 scripts/mutate-telegram-robustness.py [index ...]
Results are recorded in docs/telegram-robustness-audit.md (Mutation table).
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = 'apps/api/src/infrastructure/telegram/send-message.ts'
MSG = 'apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger.ts'
REPO = 'apps/api/src/modules/platform/tenancy/infrastructure/drizzle-tenant.repository.ts'
BOOT = 'apps/api/src/modules/platform/tenancy/application/bot-bootstrap.service.ts'
OPS = 'apps/api/src/modules/control/notifications/infrastructure/telegram-transport.ts'

UNIT = ['npx', 'vitest', 'run', '--project', 'unit',
        'tests/unit/telegram-send-robustness.test.ts', 'tests/unit/bot-bootstrap.test.ts',
        'tests/unit/telegram-messenger-appearance.test.ts']
INT = ['npx', 'vitest', 'run', '--project', 'integration',
       'tests/integration/telegram-multi-bot.test.ts']

M = [
    # D1 — the call core.
    ('2xx without ok is a definite refusal again', T,
     "if (response.ok && payload?.ok !== false) {",
     "if (payload === null && response.ok) {", UNIT),
    ('retry_after read unchecked (NaN reaches the lanes)', T,
     "const retryAfterMs = telegramRetryAfterMs(payload?.parameters?.retry_after);",
     "const raw = payload?.parameters?.retry_after as number | undefined;\n"
     "      const retryAfterMs = raw === undefined ? undefined : raw * 1000;", UNIT),
    ('retry_after ceiling removed', T,
     "return Math.min(Math.ceil(retryAfter * 1000), TELEGRAM_RETRY_AFTER_MAX_MS);",
     "return Math.ceil(retryAfter * 1000);", UNIT),
    ('retry_after rounded down (shorter than asked)', T,
     "return Math.min(Math.ceil(retryAfter * 1000), TELEGRAM_RETRY_AFTER_MAX_MS);",
     "return Math.min(Math.floor(retryAfter * 1000), TELEGRAM_RETRY_AFTER_MAX_MS);", UNIT),
    ('negative retry_after accepted', T,
     "!Number.isFinite(retryAfter) || retryAfter < 0) {",
     "!Number.isFinite(retryAfter)) {", UNIT),
    # D1 — the messenger never sends one message twice.
    ('decorated retry on ANY failure (blind retry of an unknown)', MSG,
     "if (!decorated || first.outcome !== 'FAILED_PERMANENT' || isMessageNotModified(first)) {",
     "if (!decorated || first.outcome === 'SUCCEEDED' || isMessageNotModified(first)) {", UNIT),
    ('429 collapsed into UNKNOWN', MSG,
     "if (result.outcome === 'FAILED_RETRYABLE' && result.errorCode === 'telegram.rate_limited') {\n"
     "      return {\n        sent: {",
     "if (false) {\n      return {\n        sent: {", UNIT),
    # D3 — a revoked token is named.
    ('401 not named TOKEN_REJECTED', MSG,
     "        : worst.errorCode !== null && TELEGRAM_TOKEN_REJECTED_CODES.includes(worst.errorCode)\n",
     "        : false\n", UNIT),
    # D2 — the right bot.
    ('a STOPPED bot still sends', REPO,
     "          eq(botInstances.id, botInstanceId),\n          eq(botInstances.status, 'ACTIVE'),\n",
     "          eq(botInstances.id, botInstanceId),\n", INT),
    ('another tenant\'s bot resolves', REPO,
     "        and(\n          eq(botInstances.tenantId, tenantId),\n          eq(botInstances.id, botInstanceId),",
     "        and(\n          eq(botInstances.id, botInstanceId),", INT),
    ('customer reply from the tenant\'s first bot, not the one written to', MSG,
     "  async send(scope: TenantContext, message: CustomerMessage): Promise<CustomerSendResult> {\n"
     "    const token = await this.bots.tokenForBotInstance(scope, message.botInstanceId);",
     "  async send(scope: TenantContext, message: CustomerMessage): Promise<CustomerSendResult> {\n"
     "    const token = await (this.bots as unknown as { activeTokenForTenant(s: unknown): Promise<string | null> }).activeTokenForTenant(scope);",
     INT),
    ('ops message ignores the bot it names', OPS,
     "        message.botInstanceId !== undefined\n          ? await this.bots.tokenForBotInstance(",
     "        false\n          ? await this.bots.tokenForBotInstance(", INT),
    # D3 — a BotFather rename.
    ('rename never reconciled', BOOT,
     "      if (identity.username !== existing.username) {\n        const usernameReconcile",
     "      if (false) {\n        const usernameReconcile", UNIT),
    ('rename overwrites a name another row holds', REPO,
     "          sql`NOT EXISTS (\n            SELECT 1 FROM ${botInstances} AS other\n             WHERE other.username = ${input.username} AND other.id <> ${id}\n          )`,\n",
     "", INT),
    ('status reports no drift', BOOT,
     "        ...(renamed\n          ? {\n              usernameDrift: {",
     "        ...(false\n          ? {\n              usernameDrift: {", UNIT),
    ('N1: status never says the name is held elsewhere', BOOT,
     "    return { ...detail, usernameDrift: { ...drift, heldByAnotherRow } };",
     "    return { ...detail, usernameDrift: { ...drift, heldByAnotherRow: false } };", UNIT),
    # D4 — icon eligibility and decoration bookkeeping never break a send.
    ('best-effort bookkeeping rethrows (a delivered message becomes an exception)', MSG,
     "      return fallback;\n",
     "      throw error;\n", UNIT),
    # PR #238 review fixes.
    ('B1: the token condition shares the generic row (its sentence goes stale)', MSG,
     "            reason === 'TOKEN_REJECTED'\n"
     "              ? customerTokenConditionKey(message.botInstanceId)\n",
     "            reason === 'TOKEN_REJECTED'\n"
     "              ? customerSendConditionKey(message.botInstanceId)\n", UNIT),
    ('B1 (integration): the token condition shares the generic row', MSG,
     "            reason === 'TOKEN_REJECTED'\n"
     "              ? customerTokenConditionKey(message.botInstanceId)\n",
     "            reason === 'TOKEN_REJECTED'\n"
     "              ? customerSendConditionKey(message.botInstanceId)\n", INT),
    ('P1: the failure record can throw over an UNKNOWN', MSG,
     "    await this.bestEffort(\n      'record the send-failure condition',",
     "    await (async (_w: string, _f: undefined, work: () => Promise<unknown>) => { await work(); })(\n      'record the send-failure condition',", UNIT),
    ('N3: the eligibility write is skipped', MSG,
     "    if (denied && appearance !== undefined) {",
     "    if (false) {", UNIT),
    ('N4: backup delivery files a 2xx without ok as definitive', 'apps/api/src/modules/platform/backup/infrastructure/telegram-backup-delivery.ts',
     "      if (response.ok && (payload as { ok?: unknown }).ok !== false) {",
     "      if (false) {", ['npx', 'vitest', 'run', '--project', 'unit', 'tests/unit/backup-delivery.test.ts']),
    ('N2: a 23505 during the rename is UNRESOLVED, not TAKEN', BOOT,
     "code === '23505' ? 'TAKEN' : 'UNRESOLVED'",
     "'UNRESOLVED' as BotUsernameReconcile", UNIT),
    ('N5: a not-Bot-API 2xx from getMe is UNREACHABLE', 'apps/api/src/modules/platform/tenancy/infrastructure/telegram-bot-bootstrap.gateway.ts',
     "        return outcome.notBotApiAnswer === true",
     "        return false", ['npx', 'vitest', 'run', '--project', 'unit', 'tests/unit/telegram-bootstrap-gateway.test.ts']),
    ('an unreadable decoration fails the send', MSG,
     "    return this.bestEffort('read the bot\\u2019s decoration', NO_DECORATION, () =>\n"
     "      appearance.decorationFor(scope, botInstanceId),\n    );",
     "    return appearance.decorationFor(scope, botInstanceId);", UNIT),
]


def run(index):
    name, path, old, new, command = M[index]
    full = os.path.join(ROOT, path)
    with open(full, encoding='utf-8') as handle:
        original = handle.read()
    if original.count(old) != 1:
        return f'M{index + 1} {name}: SKIPPED (anchor found {original.count(old)} times)'
    try:
        with open(full, 'w', encoding='utf-8') as handle:
            handle.write(original.replace(old, new, 1))
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        verdict = 'KILLED' if result.returncode != 0 else 'SURVIVED'
    finally:
        with open(full, 'w', encoding='utf-8') as handle:
            handle.write(original)
    return f'M{index + 1} {name}: {verdict}'


if __name__ == '__main__':
    chosen = [int(arg) - 1 for arg in sys.argv[1:]] or range(len(M))
    for index in chosen:
        print(run(index), flush=True)
