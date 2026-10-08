/**
 * SYNTHETIC rehearsal support — the owner's legacy product review decision for the panel
 * map's `products` entries, recorded the way the Web Admin records it
 * (`container.legacyProductReviews.approveExisting`, as the authenticated `rehearsal-owner`
 * the synthetic panels helper created), for `scripts/legacy-rehearsal.sh --evidence-class
 * synthetic`.
 *
 * Since aud5 F5 = aud6 F1 an APPLY run refuses a `mapping.products` entry the approved review
 * does not export for the source's current products read, so the synthetic map's `p1` entry
 * needs the review decision `products-export` would have exported. On staging and production
 * a PERSON decides it in the Web Admin; the harness never does, and this file refuses any
 * database whose name is not a rehearsal database's. NOT EVIDENCE.
 *
 *   tsx tests/support/legacy-rehearsal-product-approval.ts --tenant SLUG --panel-map FILE
 *   (DATABASE_URL and the application configuration come from the environment)
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createContainer } from '../../apps/api/src/container';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import { adminActorFor } from '../integration/harness';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'] ?? '';
  const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  if (!/^nexa_rehearsal_[0-9]{14}$/u.test(database)) {
    throw new Error(`refusing: "${database}" is not a rehearsal database`);
  }
  const map = JSON.parse(readFileSync(arg('--panel-map'), 'utf8')) as {
    readonly products?: readonly { readonly codeProduct: string; readonly productId: string }[];
  };
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
    const decided: string[] = [];
    for (const entry of map.products ?? []) {
      const { items } = await container.legacyProductReviews.list(scope, owner, {
        q: entry.codeProduct,
      });
      const review = items.find((i) => i.review.codeProduct === entry.codeProduct)?.review;
      if (review === undefined) throw new Error(`no review row for ${entry.codeProduct}`);
      if (review.state !== 'PENDING_REVIEW') continue;
      await container.legacyProductReviews.approveExisting(scope, owner, review.id, {
        idempotencyKey: `rehearsal-review-${container.ids.uuid()}`,
        expectedFactsChecksum: review.factsChecksum,
        expectedVersion: review.version,
        productId: entry.productId,
        reason: 'SYNTHETIC rehearsal decision — not evidence',
      });
      decided.push(entry.codeProduct);
    }
    process.stdout.write(`${JSON.stringify({ decided })}\n`);
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
