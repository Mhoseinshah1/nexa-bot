import type { ActorContext, TenantContext } from '@nexa/contracts';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  buildSyntheticLegacyDataset,
  type SyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import type { TestContext } from './harness';

/**
 * aud5 F5 = aud6 F1 — the approved legacy product review an APPLY run now requires behind
 * every `mapping.products` entry (`product-map-review.ts`).
 *
 * Runs the real path: `products-read` (digest, then the approved ingest) of the synthetic
 * source, then the owner's approve-existing of `p1` onto `productId`. So the synthetic panel
 * map's `p1 → productId` entry is exactly what `products-export` would write. Returns the
 * products read set fingerprint the review now reflects.
 *
 * Test-only. Never import this from `apps/`.
 */
/**
 * `products-read` of a synthetic source: the digest, then the approved ingest. Recorded in
 * `legacy_read_set_runs` against THAT source's v1 fingerprint (insert-or-nothing), so an
 * APPLY of that snapshot finds its current products read. Returns the products fingerprint.
 */
export async function recordSyntheticProductsRead(
  ctx: TestContext,
  input: {
    readonly scope: TenantContext;
    readonly job: ActorContext;
    readonly dataset?: SyntheticLegacyDataset;
  },
): Promise<string> {
  const connector = new FixtureLegacySourceConnector(
    (input.dataset ?? buildSyntheticLegacyDataset()) as never,
  );
  const v1 = (await readImportV1Identity(await connector.open())).fingerprint;
  const read = (expectedProductsFingerprint: string | null) =>
    ctx.container.legacyImporter().readProducts({
      scope: input.scope,
      actor: input.job,
      connector,
      expectedFingerprint: v1,
      expectedProductsFingerprint,
      batchSize: 500,
      productionLikeTarget: false,
    });
  const digest = await read(null);
  await read(digest.fingerprint);
  return digest.fingerprint;
}

export async function approveSyntheticProductReview(
  ctx: TestContext,
  input: {
    readonly scope: TenantContext;
    readonly owner: ActorContext;
    readonly job: ActorContext;
    readonly productId: string;
    readonly dataset?: SyntheticLegacyDataset;
    readonly codeProduct?: string;
  },
): Promise<string> {
  const fingerprint = await recordSyntheticProductsRead(ctx, input);
  const code = input.codeProduct ?? 'p1';
  const { items } = await ctx.container.legacyProductReviews.list(input.scope, input.owner, {
    q: code,
  });
  const row = items.find((item) => item.review.codeProduct === code)?.review;
  if (row === undefined) throw new Error(`the synthetic product review has no ${code} row`);
  await ctx.container.legacyProductReviews.approveExisting(input.scope, input.owner, row.id, {
    idempotencyKey: `synthetic-review-${code}-${row.version}`,
    expectedFactsChecksum: row.factsChecksum,
    expectedVersion: row.version,
    productId: input.productId,
    reason: 'synthetic rehearsal: the panel map names this product',
  });
  return fingerprint;
}
