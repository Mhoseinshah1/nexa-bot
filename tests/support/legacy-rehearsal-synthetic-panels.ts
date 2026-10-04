/**
 * SYNTHETIC rehearsal support — the two RickPanels the synthetic legacy dataset assumes,
 * for `scripts/legacy-rehearsal.sh --evidence-class synthetic --synthetic-panels`.
 *
 * The importer refuses a panel map that names no ACTIVE RickPanel of the tenant, and it
 * reads each panel's inventory over HTTP. On a developer machine there is no RickPanel, so
 * this process stands up the same fake the integration suite uses (two of them, on
 * 127.0.0.2 and 127.0.0.3, seeded with `SYNTHETIC_PANEL_ACCOUNTS`), registers them in the
 * rehearsal database through the ordinary panel write path and the operator's real
 * connection test, adds the one public tariff the dataset's 30 GB / 30 d shapes resolve to,
 * writes the matching panel map (with its `products` entry for the fixture's `p1`), and then keeps the fakes serving until it is told to stop.
 *
 * When the stop file appears (or on SIGTERM) it writes what the fakes RECEIVED after setup — every request after the ready
 * signal, split into reads (GET, and the token exchange) and anything else — so the harness
 * can check "provider writes = 0" on the wire, independently of the importer's own count.
 *
 * NOT EVIDENCE about RickPanel or the legacy archive. It refuses any database whose name is
 * not a rehearsal database's.
 *
 *   tsx tests/support/legacy-rehearsal-synthetic-panels.ts \
 *     --tenant SLUG --mapping-out FILE --ready-file FILE --requests-out FILE --stop-file FILE
 *   (DATABASE_URL and the application configuration come from the environment)
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { createContainer } from '../../apps/api/src/container';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { adminActorFor, createAdmin } from '../integration/harness';
import { startFakeRickpanel, type FakeRickpanel } from './fake-rickpanel';

const GIB = 1024n ** 3n;

/**
 * The fixture's own panel accounts and mapping writer, from the IMPORTER's synthetic
 * dataset (`tests/fixtures/legacy/`, branch wp4/p7-importer). Loaded at run time through a
 * computed path so this file typechecks without that branch; the shape is checked here
 * instead, and a missing fixture is a precise error.
 */
interface SyntheticFixture {
  readonly accounts: { readonly A: readonly string[]; readonly B: readonly string[] };
  readonly mappingFile: (
    tenantId: string,
    panelA: string,
    panelB: string,
    p1Product?: string | null,
  ) => string;
}

async function loadFixture(): Promise<SyntheticFixture> {
  const dir = new URL('../fixtures/legacy/', import.meta.url);
  let legacy: Record<string, unknown>;
  let support: Record<string, unknown>;
  try {
    legacy = (await import(new URL('synthetic-legacy.ts', dir).href)) as Record<string, unknown>;
    support = (await import(new URL('synthetic-support.ts', dir).href)) as Record<string, unknown>;
  } catch {
    throw new Error(
      'the synthetic legacy fixture (tests/fixtures/legacy/, wp4/p7-importer) is absent',
    );
  }
  const accounts = legacy['SYNTHETIC_PANEL_ACCOUNTS'] as SyntheticFixture['accounts'] | undefined;
  const mappingFile = support['syntheticMappingFile'];
  if (
    accounts === undefined ||
    !Array.isArray(accounts.A) ||
    !Array.isArray(accounts.B) ||
    typeof mappingFile !== 'function'
  ) {
    throw new Error(
      'the synthetic legacy fixture does not export the panel accounts and mapping writer',
    );
  }
  return { accounts, mappingFile: mappingFile as SyntheticFixture['mappingFile'] };
}

function arg(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} is required`);
  return value;
}

function isRead(r: { method: string; path: string }): boolean {
  return r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token');
}

async function main(): Promise<void> {
  const tenantSlug = arg('--tenant');
  const mappingOut = arg('--mapping-out');
  const readyFile = arg('--ready-file');
  const requestsOut = arg('--requests-out');
  const stopFile = arg('--stop-file');
  const fixture = await loadFixture();

  const databaseUrl = process.env['DATABASE_URL'] ?? '';
  const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  if (!/^nexa_rehearsal_[0-9]{14}$/u.test(database)) {
    throw new Error(`refusing: "${database}" is not a rehearsal database`);
  }

  const container = createContainer(
    loadConfig({ ...process.env, PANEL_HTTP_ALLOW_LOOPBACK: 'true' }),
    'api',
  );
  const fakes: FakeRickpanel[] = [];
  try {
    const found = await container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM tenants WHERE slug = ${tenantSlug}`,
    );
    const tenantId = found.rows[0]?.id;
    if (tenantId === undefined) throw new Error(`no tenant ${tenantSlug}`);
    const scope = { tenantId: tenantId as never, botInstanceId: null };
    const owner = adminActorFor(
      await createAdmin(container, scope, {
        username: 'rehearsal-owner',
        roleKeys: ['owner'],
        password: container.ids.uuid(),
      }),
    );

    const panelIds: string[] = [];
    const seeds: Array<[string, readonly string[], string]> = [
      ['127.0.0.2', fixture.accounts.A, 'a'],
      ['127.0.0.3', fixture.accounts.B, 'b'],
    ];
    for (const [host, names, key] of seeds) {
      const fake = await startFakeRickpanel({ host });
      fakes.push(fake);
      // Live accounts with an expiry and a data limit, as the integration suite seeds them:
      // P6 adopts an account only when its expiry matches a renewable (dated) product.
      // Two of them sit past reminder thresholds, so the adoption's reminder seed has
      // something to seed — and the harness can check it sent nothing: svc_a1 expires in two
      // days, svc_a2 has used 29 of its 30 GB.
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const name of names) {
        fake.seedUser(name, {
          expire:
            name === 'svc_a1' ? nowSeconds + 2 * 86_400 : Math.floor(Date.UTC(2027, 0, 1) / 1000),
          dataLimit: 30 * 1024 ** 3,
          usedTraffic: name === 'svc_a2' ? 29 * 1024 ** 3 : 1024 ** 3,
        });
      }
      const created = await container.panels.create(scope, owner, {
        name: `Synthetic Rick ${key}`,
        providerType: 'rickpanel',
        baseUrl: fake.baseUrl,
        credentials: { username: fake.username, password: fake.password },
        activation: {},
        idempotencyKey: `rehearsal-panel-${key}`,
      });
      const id = created.view.panel.id;
      await container.panels.testConnection(scope, owner, id, {
        idempotencyKey: `rehearsal-panel-test-${key}`,
      });
      panelIds.push(id);
    }

    // The current public tariff the dataset's 30 GB / 30 d shapes resolve to — bound to panel
    // A and categorised, as a product a customer can buy today — and the product the
    // dataset's named legacy product `p1` renews as (the mapping file's `products`).
    const categoryId = container.ids.uuid();
    await container.database.db.execute(sql`
      INSERT INTO product_categories (id, tenant_id, name, sort_order)
      VALUES (${categoryId}, ${tenantId}, 'عمومی', 0)`);
    const products = new DrizzleProductRepository(container.database.db);
    const product = await products.create(scope, {
      id: container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: panelIds[0] as never,
        categoryId: categoryId as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 30n * GIB, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: container.clock.now(),
    });
    await products.setStatus(scope, product.id, 'INACTIVE', 'ACTIVE', container.clock.now());

    const [panelA, panelB] = panelIds as [string, string];
    await writeFile(mappingOut, fixture.mappingFile(tenantId, panelA, panelB, product.id), {
      mode: 0o600,
    });
  } finally {
    await container.shutdown();
  }

  // Only what arrives AFTER setup is the importer's: the connection test above is not.
  const baseline = fakes.map((f) => f.requests.length);
  await writeFile(readyFile, 'ready\n', { mode: 0o600 });

  // Stopped by a FILE, not only a signal: `tsx` sits between the harness and this process,
  // and a signal it relays races the harness's `wait`.
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
    const timer = setInterval(() => {
      if (existsSync(stopFile)) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  });
  const after = fakes.flatMap((f, i) => f.requests.slice(baseline[i]));
  await writeFile(
    requestsOut,
    `${JSON.stringify({
      synthetic: true,
      total: after.length,
      reads: after.filter(isRead).length,
      writes: after.filter((r) => !isRead(r)).length,
    })}\n`,
    { mode: 0o600 },
  );
  for (const fake of fakes) await fake.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
