/**
 * SYNTHETIC rehearsal support — the owner's cutover approval, recorded the way the Web Admin
 * records it (`container.legacyCutover.approve`, as the authenticated `rehearsal-owner` the
 * synthetic panels helper created, with `legacy.cutover.approve`), for
 * `scripts/legacy-rehearsal.sh --evidence-class synthetic`.
 *
 * On staging and production a PERSON records the approval in the Web Admin; the harness never
 * does, and this file refuses any database whose name is not a rehearsal database's. Every
 * value it is given was printed by the harness's own audit, read sets, freeze proof and dump.
 * The approval it records is SYNTHETIC by construction (its read sets came from the fixture),
 * so it can never open a production-like target. NOT EVIDENCE.
 *
 *   tsx tests/support/legacy-rehearsal-cutover-approval.ts --tenant SLUG --kind CUTOVER \
 *     --source HEX --panel-map HEX --inventory HEX --products HEX --invoice-archive HEX \
 *     --freeze HEX --dump HEX [--prior HEX]
 *   (DATABASE_URL and the application configuration come from the environment)
 */
import { sql } from 'drizzle-orm';
import { createContainer } from '../../apps/api/src/container';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import { adminActorFor } from '../integration/harness';

function arg(name: string, optional = false): string {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined) {
    if (optional) return '';
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'] ?? '';
  const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  if (!/^nexa_rehearsal_[0-9]{14}$/u.test(database)) {
    throw new Error(`refusing: "${database}" is not a rehearsal database`);
  }
  const container = createContainer(loadConfig(process.env), 'api');
  try {
    const found = await container.database.db.execute<{ tenant_id: string; id: string }>(sql`
      SELECT a.tenant_id, a.id FROM admins a JOIN tenants t ON t.id = a.tenant_id
       WHERE t.slug = ${arg('--tenant')} AND a.username = 'rehearsal-owner'`);
    const row = found.rows[0];
    if (row === undefined)
      throw new Error('no rehearsal-owner admin (run with --synthetic-panels)');
    const scope = { tenantId: row.tenant_id as never, botInstanceId: null };
    const owner = adminActorFor({ id: row.id as never, username: 'rehearsal-owner', password: '' });
    const kind = arg('--kind');
    const prior = arg('--prior', true);
    const approval = await container.legacyCutover.approve(scope, owner, {
      idempotencyKey: `rehearsal-cutover-${container.ids.uuid()}`,
      kind,
      sourceFingerprint: arg('--source'),
      panelMapFingerprint: arg('--panel-map'),
      inventoryFingerprint: arg('--inventory'),
      productsFingerprint: arg('--products'),
      invoiceArchiveFingerprint: arg('--invoice-archive'),
      freezeProofSha256: arg('--freeze'),
      finalDumpSha256: arg('--dump'),
      priorSourceFingerprint: prior === '' ? null : prior,
      reason: 'SYNTHETIC rehearsal approval — not evidence',
    });
    process.stdout.write(
      `${JSON.stringify({ id: approval.id, kind: approval.kind, synthetic: approval.synthetic })}\n`,
    );
  } finally {
    await container.shutdown();
  }
}

main().catch((error: unknown) => {
  const code = (error as { code?: unknown }).code;
  process.stderr.write(
    `${typeof code === 'string' ? `${code}: ` : ''}${error instanceof Error ? error.message : 'error'}\n`,
  );
  process.exit(1);
});
