import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJsonString } from '../../apps/api/src/infrastructure/nxpkg/canonical-json';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  paymentRecords,
  rigExecutor,
  writeMigrationPackage,
} from '../support/legacy-migration-rig';
import { createTestContext, type TestContext } from './harness';

/**
 * Mirza `.nxpkg` import — the SPEED WORK MUST NOT CHANGE A RESULT (Track 1 Part B).
 *
 * One fixed synthetic package (edge cases on purpose: DEBIT, zero and credit openings, users
 * blocked in Mirza, users whose trial was spent, usernames, live and removed invoices, payment
 * history) goes through the whole executor — dry run, apply, history, materialize, bot link,
 * reconcile, report — and what it wrote is reduced to a digest per section, keyed by LEGACY
 * identity (Telegram id, invoice key, reference) and never by a generated id or a timestamp.
 *
 * The digests below were captured on the importer BEFORE the batched writers replaced the
 * per-row ones (`fix/mirza-import-attach-and-speed` at 118949c6). A batched writer that wrote
 * one row more or less, a different reference, another audit action, an outbox event out of
 * sequence or a different idempotency record changes its section's digest.
 *
 * One digest per section, so a deliberate change to one section (the services adoption
 * rework, for one) re-pins that section alone and leaves the others standing as evidence.
 *
 * SYNTHETIC data only. NOT EVIDENCE.
 */

const USERS = 360;
// More than one 200-row slice of the services section, whose audit is counted per slice.
const INVOICES = 450;

/** The digests captured before the speed work. */
const PINNED: Record<string, string> = {
  dryRunReport: '7bfda0b23617014ebb8ca9879b0baff9a7bfb836deede0f88873f5fa85cda7b5',
  applyCounts: '1fdc6591c9f884a55b322a0c815973f4d1b48f27b69c0506a37f07ef20cdda44',
  customers: '1795829b5ff6e48d250360a90fedcbb326f433e36a47f59b16460a502bfe1393',
  wallet: '75a385e8b3e2d0757651d8ba72a53de012a355f0eaa4dbd454541d79ff734d3b',
  trials: '559b0781174574a505585078a6692341553dbc4666b0cffa0e746614da1ef3ee',
  importMap: '4a0d73f6ee1646f9e431053b5396d7cd15d76091885452f0f7d8cbd292803ab6',
  audit: 'b71cb66189c8719adec16f99c24a94927ce9a0e135319a6d5e5da239b42c2f30',
  outbox: 'e2615b8d0c5d373c9df2d6914c06baecc754a8b3101e7b7a49a4861f2ed9b043',
  aggregateSequences: 'bb2d305752089dd2e885db2ee5917498f23a042490da4822b0cb2f3b734a4d1c',
  idempotency: '9c2f50df9573ee59f3dd540600387326ab0c37096ea8a6bb5e2565dff39307c5',
  services: '2a0ee48ad33c0fe900fd7e756650579b5c2f93a0d5c3596570c525efbeb373d6',
  orders: '73978c181f0c7b35ded662d22d855d84e600b33bc463220700b8a1072762da2d',
  payments: 'fea44bf614ec8e726c02f9bd96958919f727ecdd709ce9a2a627afd783ba0665',
  history: '03feecc26487a7c0ecd6f6434809336a054a1f2cf110a6ce91759c00b752c054',
  candidates: 'dbec493afb42de2b30de09a68b340f42dad997a3b995f88ecd5c2cc830169517',
  invoiceArchive: '2fe38032bcbb79542e416610c7687e11dbbe7cf27d6bb0acc3b1e33e9bb00c4a',
  runs: '1c6d1c56c6005d1e4bc1841dc7b4026408671a3dda979198957bcc6a121f7a5c',
};

/** Dates as ISO text, bigints as decimal text: what the database rows carry, made plain. */
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as unknown;

const sha = (value: unknown): string =>
  createHash('sha256')
    .update(canonicalJsonString(plain(value)), 'utf8')
    .digest('hex');

/** A report with every generated id, digest of a random value, time and duration removed. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'string') {
    return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<id>');
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(^id$|Id$|Ids$|At$|^at$|Ms$|^durationMs|^startedAt|^finishedAt|Fingerprint$|Sha256$|Digest$|^digest$|^baseUrl$)/u.test(
        key,
      )
    ) {
      continue;
    }
    out[key] = stable(v);
  }
  return out;
}

/** Rows as a sorted multiset of their stable canonical form (no generated id, no time). */
const multiset = (list: readonly unknown[]): string[] =>
  list.map((r) => canonicalJsonString(plain(stable(plain(r))))).sort();

describe('legacy migration: the speed work writes exactly what the per-row importer wrote', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-eq-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-eq-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    rig = new MigrationRig(ctx, migrationRoot);
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  const rows = async (query: string): Promise<unknown[]> =>
    (await ctx.container.database.db.execute(sql.raw(query))).rows;

  it('every section of the synthetic import matches its pinned digest', async () => {
    const generated = generateDataset({ users: USERS, invoices: INVOICES });
    // Edge cases the plain generator leaves out, decided by index so the package is fixed.
    generated.users.forEach((user, i) => {
      const row = user as Record<string, string | null>;
      if (i % 17 === 5) row['User_Status'] = 'block';
      if (i % 11 === 4) row['limit_usertest'] = '0';
      if (i % 13 === 6) row['username'] = `legacy_user_${String(i)}`;
    });
    const pkg = await writeMigrationPackage(join(work, 'equivalence.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      history: { 'records/payments.jsonl': paymentRecords(generated.users, 3) },
      manifest: { import_id: '0123456789abcdef0123456789abcdef' },
    });
    await rig.freshTenant(generated.liveAccounts);
    const executor = rigExecutor(ctx);
    const id = await rig.prepare(pkg, executor);
    const dry = await rig.detail(id);
    await executor.tick();
    const view = await rig.detail(id);
    expect(view.status, String(view.errorCode)).toBe('COMPLETED');

    const t = `tenant_id = '${TENANT}'`;
    const tg = (column: string) =>
      `(SELECT telegram_user_id FROM customers c WHERE c.id = ${column})`;
    const sections: Record<string, unknown> = {
      dryRunReport: stable(dry.dryRunReport),
      applyCounts: {
        importerVerdict: view.progress.importerVerdict,
        reconcileVerdict: view.progress.reconcileVerdict,
        history: view.progress.history,
        materialize: view.progress.materialize,
        botLink: stable(view.progress.botLink),
        report: stable(view.applyReport),
      },
      customers: await rows(
        `SELECT telegram_user_id, username, status, (blocked_at IS NOT NULL) AS blocked,
                first_bot_instance_id IS NOT NULL AS bot
           FROM customers WHERE ${t} ORDER BY telegram_user_id`,
      ),
      wallet: await rows(
        `SELECT ${tg('customer_id')} AS tg, direction, reason, amount::text, currency, reference,
                note, actor_admin_id
           FROM wallet_entries WHERE ${t} ORDER BY reference, direction, amount`,
      ),
      trials: {
        records: await rows(
          `SELECT ${tg('customer_id')} AS tg, legacy_limit_usertest, legacy_had_trial, decision,
                  override_before, override_after, input_hash
             FROM legacy_trial_eligibility WHERE ${t} ORDER BY 1`,
        ),
        overrides: await rows(
          `SELECT ${tg('customer_id')} AS tg, trial_limit FROM trial_limit_overrides WHERE ${t} ORDER BY 1`,
        ),
      },
      importMap: await rows(
        `SELECT legacy_table, legacy_id, checksum, status, reason_code, entity_type,
                (entity_id IS NOT NULL) AS has_entity, review_state, attempts
           FROM legacy_import_map WHERE ${t} ORDER BY legacy_table, legacy_id`,
      ),
      // Every row, generated ids and times removed, as a sorted multiset.
      audit: multiset(
        await rows(
          `SELECT action, entity_type, result, actor_type, actor_label, source_surface, reason,
                  before, after, (entity_id IS NOT NULL) AS has_entity
             FROM audit_logs WHERE ${t}`,
        ),
      ),
      outbox: multiset(
        await rows(
          `SELECT event_type, aggregate_type, sequence, event_version, payload, actor,
                  causation_id IS NOT NULL AS caused
             FROM outbox_messages WHERE ${t}`,
        ),
      ),
      aggregateSequences: await rows(
        `SELECT aggregate_type, last_sequence::text, count(*)::int AS n
           FROM aggregate_sequences GROUP BY 1, 2 ORDER BY 1, 2`,
      ),
      // A key or a result names generated ids, the rig's own clock-stamped keys and digests
      // over them: reduced to its shape, sorted after the reduction.
      idempotency: (
        (await rows(`SELECT scope_ref, key, result FROM request_idempotency WHERE ${t}`)) as {
          scope_ref: string;
          key: string;
          result: unknown;
        }[]
      )
        .map((r) =>
          canonicalJsonString({
            scope: r.scope_ref,
            key: r.key
              .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<id>')
              .replace(/[0-9a-f]{32,64}/gu, '<h>')
              .replace(/[0-9]{10,}/gu, '<n>'),
            result: stable(r.result),
          }),
        )
        .sort(),
      services: await rows(
        `SELECT s.provider_username, p.name AS panel, ${tg('s.customer_id')} AS tg, s.state,
                s.source, s.source_ref, s.expires_at, s.traffic_limit_bytes::text,
                s.traffic_used_bytes::text, s.is_trial, s.is_test, s.delivery_state,
                s.order_id IS NOT NULL AS has_order, s.product_id IS NOT NULL AS has_product
           FROM services s JOIN panels p ON p.id = s.panel_id
          WHERE s.${t} ORDER BY s.provider_username, p.name, s.state, s.source_ref`,
      ),
      orders: await rows(
        `SELECT ${tg('customer_id')} AS tg, origin, state, total_amount::text, currency, source,
                source_ref, purpose, line_title, line_duration_days, line_traffic_bytes::text,
                line_unit_price_amount::text, subtotal_amount::text
           FROM orders WHERE ${t} ORDER BY 1, 7, 2, 3, 4`,
      ),
      payments: await rows(
        `SELECT ${tg('customer_id')} AS tg, state, method, amount::text, currency, source,
                source_ref, order_id IS NOT NULL AS has_order
           FROM payments WHERE ${t} ORDER BY 1, 7, 2, 4`,
      ),
      history: await rows(
        `SELECT record_type, idempotency_key, legacy_user_id, customer_id IS NOT NULL AS linked,
                occurred_at, payload
           FROM legacy_history_records WHERE ${t} ORDER BY idempotency_key`,
      ),
      candidates: await rows(
        `SELECT invoice_key, invoice_checksum, outcome, blocker, panel_code,
                product_code, review_state, decision_reason, archive_id IS NOT NULL AS archived,
                service_id IS NOT NULL AS has_service, version
           FROM legacy_service_candidates WHERE ${t} ORDER BY invoice_key`,
      ),
      invoiceArchive: await rows(
        `SELECT invoice_key, revision, revision_reason, key_shape_evidenced, raw_row,
                row_checksum, archive_checksum, classification, live, status, is_test,
                legacy_user_id, owner_present, username, panel_code, product_code, product_ref,
                product_name, price_raw, price_minor::text, price_currency, price_note,
                sold_at_raw, sold_at, sold_at_note, normalization_version
           FROM legacy_invoice_archive WHERE ${t} ORDER BY invoice_key, revision`,
      ),
      runs: await rows(
        `SELECT mode, status, failure_code, rows_seen, rows_imported, rows_skipped,
                rows_manual_review, rows_failed
           FROM legacy_import_runs WHERE ${t} ORDER BY started_at`,
      ),
    };
    const digests = Object.fromEntries(
      Object.entries(sections).map(([name, value]) => [name, sha(value)]),
    );
    const dump = process.env['NEXA_EQUIVALENCE_DUMP'];
    if (dump !== undefined && dump !== '') {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(dump, canonicalJsonString(plain(sections)));
    }
    process.stderr.write(`\nLEGACY_MIGRATION_EQUIVALENCE ${JSON.stringify(digests, null, 1)}\n`);
    expect(digests).toEqual(PINNED);
  }, 600_000);
});
