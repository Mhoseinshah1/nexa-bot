/**
 * The rehearsal's equation P4 (WP-D4): every production panel's accounts are the same
 * after the import as before it — the STAGING equivalent of the synthetic run's
 * `wire_provider_writes_zero`, which only a fake panel can count.
 *
 *   tsx tests/support/legacy-rehearsal-panel-state.ts snapshot \
 *     --tenant SLUG --panel-map FILE --key-file FILE --out FILE
 *   tsx tests/support/legacy-rehearsal-panel-state.ts compare PRE.json POST.json
 *   (DATABASE_URL and the application configuration come from the environment)
 *
 * `snapshot` walks each `productionPanels` panel of the map through the importer's OWN
 * read-only inventory port (`LegacyImporterService.readPanelInventory`: GETs and the token
 * exchange, nothing else can be sent) and writes, per panel, aggregates only:
 *
 * - `controlHash` over every account's ADMIN-CONTROLLED facts — lower(username), data
 *   limit, expiry, and the sha256 of its subscription link (a revoked or rotated token is
 *   a different link). Only a write changes these, so P4 compares THIS hash.
 * - `runtimeHash` adds state and used bytes, which a live panel moves by itself (traffic,
 *   expiry). Reported, never compared: on a real panel it differs with zero writes.
 * - `accounts`: HMAC(username) → HMAC(control facts), keyed by a per-run random key the
 *   harness keeps in its private scratch directory and deletes on exit — enough to count
 *   added, removed and changed accounts, and unlinkable to any username once the key is
 *   gone. No username, link or usage figure is written.
 *
 * NOT detected: a `sub_updated_at` bump that leaves the link unchanged — the read-only
 * inventory does not expose that field (docs/legacy-migration/reconciliation.md P4).
 *
 * `compare` prints `unchanged`, or one line naming what changed, and exits 0 either way;
 * the harness's check decides.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createContainer } from '../../apps/api/src/container';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';

export const PANEL_STATE_SCHEMA = 'nexa-legacy-panel-state/v1';

export interface PanelState {
  readonly panelId: string;
  readonly complete: boolean;
  readonly reason: string | null;
  readonly accounts: number;
  readonly controlHash: string | null;
  readonly runtimeHash: string | null;
  readonly accountKeys: Readonly<Record<string, string>>;
}

export interface PanelStateSnapshot {
  readonly schema: typeof PANEL_STATE_SCHEMA;
  readonly panels: readonly PanelState[];
  readonly requests: { readonly reads: number; readonly refusedWrites: number };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** One panel's state from one complete read; pure, so it is tested without a database. */
export function panelState(panelId: string, read: LegacyInventoryRead, key: Buffer): PanelState {
  if (!read.ok || !read.complete) {
    return {
      panelId,
      complete: false,
      reason: read.ok ? read.reason : read.failure,
      accounts: 0,
      controlHash: null,
      runtimeHash: null,
      accountKeys: {},
    };
  }
  const hmac = (text: string) => createHmac('sha256', key).update(text).digest('hex');
  const rows = [...read.runtime].map(([username, runtime]) => {
    const control = [
      username.toLowerCase(),
      runtime.usage === null || runtime.usage.totalBytes === null
        ? 'null'
        : String(runtime.usage.totalBytes),
      runtime.usage === null || runtime.usage.expiresAt === null
        ? 'null'
        : runtime.usage.expiresAt.toISOString(),
      runtime.subscriptionUrl === null ? 'null' : sha256(runtime.subscriptionUrl),
    ];
    const live = [
      ...control,
      runtime.state,
      runtime.usage === null ? 'null' : String(runtime.usage.usedBytes),
    ];
    return {
      key: hmac(username.toLowerCase()),
      control: JSON.stringify(control),
      live: JSON.stringify(live),
    };
  });
  rows.sort((a, b) => (a.control < b.control ? -1 : a.control > b.control ? 1 : 0));
  return {
    panelId,
    complete: true,
    reason: null,
    accounts: rows.length,
    controlHash: sha256(rows.map((r) => r.control).join('\n')),
    runtimeHash: sha256(
      rows
        .map((r) => r.live)
        .sort()
        .join('\n'),
    ),
    accountKeys: Object.fromEntries(
      rows.map((r) => [r.key, hmac(r.control)] as const).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
}

/** `unchanged`, or what changed — counts only. */
export function comparePanelStates(pre: PanelStateSnapshot, post: PanelStateSnapshot): string {
  const problems: string[] = [];
  const after = new Map(post.panels.map((p) => [p.panelId, p]));
  if (pre.panels.length === 0) problems.push('no panel was walked');
  for (const before of pre.panels) {
    const now = after.get(before.panelId);
    after.delete(before.panelId);
    if (now === undefined) {
      problems.push(`${before.panelId}: not walked afterwards`);
      continue;
    }
    if (!before.complete || !now.complete) {
      problems.push(
        `${before.panelId}: inventory incomplete (${before.reason ?? 'complete'} -> ${now.reason ?? 'complete'})`,
      );
      continue;
    }
    if (before.controlHash === now.controlHash && before.accounts === now.accounts) continue;
    const added = Object.keys(now.accountKeys).filter((k) => !(k in before.accountKeys)).length;
    const removed = Object.keys(before.accountKeys).filter((k) => !(k in now.accountKeys)).length;
    const changed = Object.keys(before.accountKeys).filter(
      (k) => k in now.accountKeys && now.accountKeys[k] !== before.accountKeys[k],
    ).length;
    problems.push(
      `${before.panelId}: accounts ${before.accounts}->${now.accounts}, added ${added}, removed ${removed}, changed ${changed}`,
    );
  }
  for (const extra of after.keys()) problems.push(`${extra}: walked afterwards only`);
  return problems.length === 0 ? 'unchanged' : `changed: ${problems.join('; ')}`;
}

// --- CLI ----------------------------------------------------------------------------------

function arg(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} is required`);
  return value;
}

async function snapshot(): Promise<void> {
  const tenantSlug = arg('--tenant');
  const map = JSON.parse(readFileSync(arg('--panel-map'), 'utf8')) as {
    productionPanels?: unknown;
  };
  const key = Buffer.from(readFileSync(arg('--key-file'), 'utf8').trim(), 'hex');
  if (key.length < 16) throw new Error('the key file holds fewer than 16 random bytes');
  const out = arg('--out');
  const panelIds = map.productionPanels;
  if (!Array.isArray(panelIds) || panelIds.some((p) => typeof p !== 'string')) {
    throw new Error('the panel map has no productionPanels list');
  }

  const databaseUrl = process.env['DATABASE_URL'] ?? '';
  const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  if (!/^nexa_rehearsal_[0-9]{14}$/u.test(database)) {
    throw new Error(`refusing: "${database}" is not a rehearsal database`);
  }
  const container = createContainer(loadConfig(process.env), 'api');
  try {
    const found = await container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM tenants WHERE slug = ${tenantSlug}`,
    );
    const tenantId = found.rows[0]?.id;
    if (tenantId === undefined) throw new Error(`no tenant ${tenantSlug}`);
    const scope = { tenantId: tenantId as never, botInstanceId: null };
    const importer = container.legacyImporter({});
    const panels: PanelState[] = [];
    let requests = { reads: 0, refusedWrites: 0 };
    for (const panelId of [...(panelIds as string[])].sort()) {
      const result = await importer.readPanelInventory(scope, panelId);
      panels.push(panelState(panelId, result.read, key));
      requests = result.requests;
    }
    const doc: PanelStateSnapshot = { schema: PANEL_STATE_SCHEMA, panels, requests };
    writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  } finally {
    await container.shutdown();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'snapshot') return snapshot();
  if (command === 'compare') {
    const [pre, post] = [process.argv[3], process.argv[4]];
    if (pre === undefined || post === undefined) throw new Error('compare PRE.json POST.json');
    const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as PanelStateSnapshot;
    process.stdout.write(`${comparePanelStates(read(pre), read(post))}\n`);
    return;
  }
  throw new Error('usage: snapshot --tenant … | compare PRE POST');
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('legacy-rehearsal-panel-state.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
