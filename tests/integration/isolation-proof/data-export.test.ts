import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  DATA_EXPORT_ERROR_CODES,
  DATA_EXPORT_README_NAME,
  DATA_EXPORT_ROUTES,
  DATA_EXPORT_TTL_MS,
  SESSION_COOKIE_NAME,
  type CorrelationId,
  type DataExportRequestResponse,
  type DataExportsResponse,
} from '@nexa/contracts';
import {
  DATA_EXPORT_DATASETS,
  DATA_EXPORT_FILES,
  WALLET_BALANCES_DATASET,
} from '../../../apps/api/src/modules/platform/data-export/application/data-export-inventory';
import { parseCsv, readZip } from '../../support/zip-reader';
import {
  buildWorld,
  fingerprints,
  HOSTED_1,
  HOSTED_2,
  ORIGIN,
  PASSWORD,
  type TenantWorld,
  type World,
} from './fixtures';

/**
 * Phase 6B PR-3 (ADR-0039, the open data export), extending the Phase 6A isolation proof.
 *
 * The world is the isolation proof's: the installation and two full HOSTED tenants, each with
 * the same household and a marker string of its own, over the real API as `nexa_app` with
 * row-level security on. A hosted owner asks for an export, the worker makes the ZIP through
 * the heavy-job queue, and the ZIP is unpacked and read. What it must hold, each with its
 * falsification beside it:
 *
 *   - the tenant's own rows, in CSV with a UTF-8 BOM, Persian intact, money as exact minor
 *     units beside its currency, a README for every column;
 *   - no row of another tenant, and never a secret — the bot token, the service's subscription
 *     link, the panel client id, a Telegram file id, an idempotency key, a request hash, a
 *     password hash;
 *   - the 24 h link: expiry, "not ready", one active export, idempotent requests;
 *   - the permission, the audit rows, and the installation's own tenant refused.
 */

let world: World;
let workDir: string;
const BIG = '9007199254740993'; // 2^53 + 1: a float would print 9007199254740992
const FORMULA = '=HYPERLINK("http://evil.test","x")';

const cookieOf = (t: TenantWorld) => ({ origin: ORIGIN, cookie: t.cookie });

async function staffCookie(t: TenantWorld): Promise<string> {
  const login = await world.api.container.auth.login(
    t.scope,
    { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
    { username: `staff-${t.marker}`, password: PASSWORD },
    { ip: null, userAgent: null },
  );
  return `${SESSION_COOKIE_NAME}=${login.token}`;
}

const errorCode = (response: { json(): unknown }): string | undefined =>
  (response.json() as { error?: { code?: string } }).error?.code;

let counter = 0;
const request = (t: TenantWorld, key = `de-key-${String((counter += 1))}-padding`) =>
  world.inject({
    method: 'POST',
    url: `${API_PREFIX}${DATA_EXPORT_ROUTES.own}`,
    headers: cookieOf(t),
    payload: { idempotencyKey: key },
  });
const list = (t: TenantWorld) =>
  world.inject({
    method: 'GET',
    url: `${API_PREFIX}${DATA_EXPORT_ROUTES.own}`,
    headers: cookieOf(t),
  });
const download = (t: TenantWorld, id: string) =>
  world.inject({
    method: 'GET',
    url: `${API_PREFIX}${DATA_EXPORT_ROUTES.ownDownload.replace(':id', id)}`,
    headers: cookieOf(t),
  });
const owner = () => world.api.container.database.db;
const rows = async <T>(statement: ReturnType<typeof sql>): Promise<T[]> =>
  (await owner().execute(statement)).rows as T[];

/** Asks for an export as `t` and lets the worker make it. */
async function exportOf(t: TenantWorld): Promise<{ id: string; zip: Map<string, Buffer> }> {
  const asked = await request(t);
  expect(asked.statusCode, asked.body).toBe(200);
  const id = (asked.json() as DataExportRequestResponse).export.id;
  const made = await world.api.container.dataExportRunner.tick();
  expect(made?.id).toBe(id);
  const file = await download(t, id);
  expect(file.statusCode, file.body.slice(0, 200)).toBe(200);
  expect(file.headers['content-type']).toBe('application/zip');
  expect(file.headers['cache-control']).toBe('no-store');
  const zip = readZip(Buffer.from((file as unknown as { rawPayload: Buffer }).rawPayload));
  return { id, zip };
}

const text = (zip: Map<string, Buffer>, name: string): string =>
  (zip.get(name) ?? Buffer.alloc(0)).toString('utf8');
const everything = (zip: Map<string, Buffer>): string =>
  [...zip.values()].map((buffer) => buffer.toString('utf8')).join('\n');

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'data-export-it-'));
  world = await buildWorld({ BACKUP_WORK_DIR: workDir });
  const h1 = world.tenants.HOSTED_1;
  // Persian text, a spreadsheet formula posing as a name, and a money figure past 2^53.
  await owner().execute(sql`UPDATE customers SET first_name = 'علی', last_name = 'رضایی'
                             WHERE id = ${h1.customerId}`);
  const second = world.api.container.ids.uuid();
  await owner().execute(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, first_name,
                                                   status, created_at)
    VALUES (${second}, ${HOSTED_1}, '222222222', ${FORMULA}, 'ACTIVE', now())`);
  await owner().execute(sql`INSERT INTO wallet_entries (id, tenant_id, customer_id, direction,
                                                        reason, amount, currency, reference)
    VALUES (${world.api.container.ids.uuid()}, ${HOSTED_1}, ${h1.customerId}, 'CREDIT',
            'ADMIN_CREDIT', ${BIG}::bigint, 'IRT', 'big-credit')`);
}, 180_000);

afterAll(async () => {
  await world?.close();
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

describe('a hosted owner’s data export', () => {
  it('is asked for, made by the worker through the heavy-job queue, and downloaded as a ZIP of CSV', async () => {
    const h1 = world.tenants.HOSTED_1;
    const { id, zip } = await exportOf(h1);

    // The queue: an EXPORT ticket for this tenant, and none left running.
    const tickets = await rows<{ kind: string; tenant_id: string; finished_at: Date | null }>(
      sql`SELECT kind, tenant_id, finished_at FROM heavy_job_tickets WHERE kind = 'EXPORT'`,
    );
    expect(tickets.map((t) => t.tenant_id)).toContain(HOSTED_1);
    expect(tickets.every((t) => t.finished_at !== null)).toBe(true);

    // Every file the inventory names, and the README.
    expect([...zip.keys()].sort()).toEqual([...DATA_EXPORT_FILES, DATA_EXPORT_README_NAME].sort());

    // The row: READY, a 24 h deadline, the file's SHA-256 and size.
    const [row] = await rows<{
      state: string;
      requested_at: Date;
      ready_at: Date;
      expires_at: Date;
      bytes: string;
      sha256: string;
    }>(sql`SELECT state, requested_at, ready_at, expires_at, bytes::text, sha256
             FROM tenant_data_exports WHERE id = ${id}`);
    expect(row?.state).toBe('READY');
    expect(new Date(row!.expires_at).getTime() - new Date(row!.ready_at).getTime()).toBe(
      DATA_EXPORT_TTL_MS,
    );
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const listed = (await list(h1)).json() as DataExportsResponse;
    expect(listed.exports.map((e) => [e.id, e.state, e.downloadable])).toEqual([
      [id, 'READY', true],
    ]);
  });

  it('is CSV with a UTF-8 BOM and Persian intact: the headers are the inventory’s, a row is the tenant’s', async () => {
    const h1 = world.tenants.HOSTED_1;
    const [first] = await rows<{ id: string }>(
      sql`SELECT id FROM tenant_data_exports WHERE tenant_id = ${HOSTED_1} ORDER BY requested_at LIMIT 1`,
    );
    const id = first!.id;
    const file = await download(h1, id);
    const zip = readZip(Buffer.from((file as unknown as { rawPayload: Buffer }).rawPayload));
    for (const dataset of DATA_EXPORT_DATASETS) {
      const bytes = zip.get(dataset.file) as Buffer;
      // The byte order mark, so Excel opens the file as UTF-8.
      expect([...bytes.subarray(0, 3)], dataset.file).toEqual([0xef, 0xbb, 0xbf]);
      const table = parseCsv(bytes.subarray(3).toString('utf8'));
      expect(table[0], dataset.file).toEqual(dataset.columns.map((c) => c.name));
      for (const row of table.slice(1, -1)) expect(row.length, dataset.file).toBe(table[0]?.length);
    }
    const customers = parseCsv(text(zip, 'customers.csv').slice(1));
    const names = customers.slice(1).map((r) => r[customers[0]!.indexOf('first_name')]);
    // Persian reads back as Persian; a formula is defused with a leading quote.
    expect(names).toContain('علی');
    expect(names).toContain(`'${FORMULA}`);
    expect(names).not.toContain(FORMULA);
    // The README is Persian and describes the columns.
    const readme = text(zip, DATA_EXPORT_README_NAME);
    expect(readme).toMatch(/[؀-ۿ]/);
    expect(readme).toContain('### wallet_ledger.csv');
    expect(readme).toContain('| `amount` |');
  });

  it('prints money as exact minor units beside the currency: past 2^53, never a float', async () => {
    const zip = await latestZip(world.tenants.HOSTED_1);
    const ledger = parseCsv(text(zip, 'wallet_ledger.csv').slice(1));
    const head = ledger[0]!;
    const amounts = ledger.slice(1).map((r) => r[head.indexOf('amount')]);
    expect(amounts).toContain(BIG);
    expect(amounts).toContain(world.tenants.HOSTED_1.walletAmountMinor);
    const currencies = ledger.slice(1).map((r) => r[head.indexOf('currency')]);
    expect(new Set(currencies)).toEqual(new Set(['IRT']));
    // The balance is the ledger's total, exactly: 2^53 + 1 + the fixture credit.
    const balances = parseCsv(text(zip, 'wallet_balances.csv').slice(1));
    expect(balances[0]).toEqual(WALLET_BALANCES_DATASET.columns.map((c) => c.name));
    const sum = (BigInt(BIG) + BigInt(world.tenants.HOSTED_1.walletAmountMinor)).toString();
    expect(balances.slice(1).map((r) => r[2])).toContain(sum);
    const orders = parseCsv(text(zip, 'orders.csv').slice(1));
    expect(orders[1]?.[orders[0]!.indexOf('total_amount')]).toBe(
      world.tenants.HOSTED_1.orderAmountMinor,
    );
    // No decimal point or exponent in any money column of any file.
    for (const dataset of DATA_EXPORT_DATASETS) {
      const table = parseCsv(text(zip, dataset.file).slice(1));
      dataset.columns.forEach((column, index) => {
        if (column.kind !== 'money_minor') return;
        for (const row of table.slice(1, -1)) {
          expect(row[index], `${dataset.file}.${column.name}`).toMatch(/^(-?\d+)?$/);
        }
      });
    }
  });

  it('holds NO secret: no token, subscription link, client id, file handle, key or hash', async () => {
    const h1 = world.tenants.HOSTED_1;
    const zip = await latestZip(h1);
    const all = everything(zip);
    const [secrets] = await rows<{
      bot_token_key: string;
      sub: string;
      client: string;
      sref: string;
    }>(sql`SELECT (SELECT token_ciphertext FROM bot_instances WHERE id = ${h1.botId}) AS bot_token_key,
                  (SELECT subscription_url FROM services WHERE id = ${h1.serviceId}) AS sub,
                  (SELECT provider_client_id::text FROM services WHERE id = ${h1.serviceId}) AS client,
                  (SELECT subscription_ref FROM services WHERE id = ${h1.serviceId}) AS sref`);
    expect(secrets?.sub).toContain('/sub/');
    for (const secret of [
      h1.botToken,
      secrets!.bot_token_key,
      secrets!.sub,
      secrets!.client,
      secrets!.sref,
      `doc-${h1.marker}`, // a Telegram file id
      `docu-${h1.marker}`,
      `msg-${h1.ticketMessageId}`, // an idempotency key
      `hash-${h1.ticketMessageId}`, // a request hash
      `open-${h1.ticketId}`, // the ticket-opening key
    ]) {
      expect(all.includes(secret), secret.slice(0, 24)).toBe(false);
    }
    // Not a password hash, whatever scheme, nor a key.
    expect(all).not.toMatch(/\$argon2|\$2[aby]\$|scrypt\$|pbkdf2/i);
    // No file of a table that holds credentials, and none of the excluded column names.
    expect(
      [...zip.keys()].some((name) => /credential|secret|session|admin|password/.test(name)),
    ).toBe(false);
    for (const dataset of DATA_EXPORT_DATASETS) {
      const header = parseCsv(text(zip, dataset.file).slice(1))[0]!;
      for (const excluded of Object.keys(dataset.excluded)) expect(header).not.toContain(excluded);
    }
  });

  it('holds NO row of another tenant: no marker, id, bot or payment code of PRIMARY or HOSTED_2', async () => {
    const zip = await latestZip(world.tenants.HOSTED_1);
    const all = everything(zip);
    for (const other of [world.tenants.PRIMARY, world.tenants.HOSTED_2]) {
      const found = fingerprints(other).filter((needle) => all.includes(needle));
      expect(found, other.label).toEqual([]);
    }
    // And it does hold its own — the proof is not an empty file.
    for (const own of [
      world.tenants.HOSTED_1.marker,
      world.tenants.HOSTED_1.customerId,
      world.tenants.HOSTED_1.orderId,
      world.tenants.HOSTED_1.serviceId,
      world.tenants.HOSTED_1.paymentId,
      world.tenants.HOSTED_1.ticketId,
      world.tenants.HOSTED_1.ticketMessageId,
      world.tenants.HOSTED_1.productId,
    ]) {
      expect(all.includes(own), own).toBe(true);
    }
    // The twin: every tenant's customer has the SAME Telegram id; each export has only its own row.
    const customers = parseCsv(text(zip, 'customers.csv').slice(1));
    expect(customers.length - 1).toBe(2);
  });

  it('the other hosted tenant’s export holds ITS rows and none of the first’s', async () => {
    const h2 = world.tenants.HOSTED_2;
    const { zip } = await exportOf(h2);
    const all = everything(zip);
    expect(all.includes(h2.marker)).toBe(true);
    for (const other of [world.tenants.PRIMARY, world.tenants.HOSTED_1]) {
      expect(
        fingerprints(other).filter((needle) => all.includes(needle)),
        other.label,
      ).toEqual([]);
    }
    expect(all.includes(BIG)).toBe(false);
  });
});

describe('who may see and take an export', () => {
  it('another tenant’s owner cannot see, list or download it: not found, never the file', async () => {
    const h1 = world.tenants.HOSTED_1;
    const h2 = world.tenants.HOSTED_2;
    const [first] = await rows<{ id: string }>(
      sql`SELECT id FROM tenant_data_exports WHERE tenant_id = ${HOSTED_1} AND state = 'READY' LIMIT 1`,
    );
    const id = first!.id;
    for (const attacker of [h2, world.tenants.PRIMARY]) {
      const stolen = await download(attacker, id);
      expect([404, 412], attacker.label).toContain(stolen.statusCode);
      expect(stolen.headers['content-type']).not.toBe('application/zip');
      const seen = (await list(attacker)).body;
      expect(seen.includes(id), attacker.label).toBe(false);
    }
    // The owner of the exported tenant still can.
    expect((await download(h1, id)).statusCode).toBe(200);
  });

  it('the installation’s own tenant is not exported, and its session is not shown the key', async () => {
    const primary = world.tenants.PRIMARY;
    const asked = await request(primary);
    expect(asked.statusCode).toBe(412);
    expect(errorCode(asked)).toBe(DATA_EXPORT_ERROR_CODES.NOT_HOSTED);
    const [none] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tenant_data_exports WHERE tenant_id = ${primary.tenantId}`,
    );
    expect(none?.n).toBe(0);
    const me = await world.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/session`,
      headers: cookieOf(primary),
    });
    expect(JSON.stringify(me.json())).not.toContain('data.export');
    const hosted = await world.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/session`,
      headers: cookieOf(world.tenants.HOSTED_1),
    });
    expect(JSON.stringify(hosted.json())).toContain('data.export');
  });

  it('a staff member without data.export is refused and the refusal is audited', async () => {
    const h1 = world.tenants.HOSTED_1;
    const cookie = await staffCookie(h1);
    const before = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tenant_data_exports WHERE tenant_id = ${HOSTED_1}`,
    );
    const denied = await world.inject({
      method: 'POST',
      url: `${API_PREFIX}${DATA_EXPORT_ROUTES.own}`,
      headers: { origin: ORIGIN, cookie },
      payload: { idempotencyKey: 'staff-denied-key-1' },
    });
    expect(denied.statusCode).toBe(403);
    const listed = await world.inject({
      method: 'GET',
      url: `${API_PREFIX}${DATA_EXPORT_ROUTES.own}`,
      headers: { origin: ORIGIN, cookie },
    });
    expect(listed.statusCode).toBe(403);
    const after = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tenant_data_exports WHERE tenant_id = ${HOSTED_1}`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
    const audit = await rows<{ result: string }>(
      sql`SELECT result FROM audit_logs WHERE tenant_id = ${HOSTED_1}
             AND action = 'data_export.requested' AND result = 'DENIED'`,
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('writes an audit row for the request and for the download, in the exported tenant’s own log', async () => {
    const audits = await rows<{ action: string; result: string }>(
      sql`SELECT action, result FROM audit_logs
           WHERE tenant_id = ${HOSTED_1} AND action LIKE 'data_export.%' AND result = 'SUCCESS'
           ORDER BY occurred_at`,
    );
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['data_export.requested', 'data_export.downloaded']),
    );
    // The installation's log holds none of a hosted owner's own export.
    const [installation] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs
           WHERE tenant_id = ${world.tenants.PRIMARY.tenantId} AND action LIKE 'data_export.%'`,
    );
    expect(installation?.n).toBe(0);
  });
});

describe('the request, the queue and the 24 h link', () => {
  it('is idempotent, and one export at a time: a second request is in_progress', async () => {
    const h2 = world.tenants.HOSTED_2;
    const first = await request(h2, 'idem-key-123456');
    expect(first.statusCode).toBe(200);
    const again = await request(h2, 'idem-key-123456');
    expect(again.statusCode).toBe(200);
    const a = first.json() as DataExportRequestResponse;
    const b = again.json() as DataExportRequestResponse;
    expect(b.replayed).toBe(true);
    expect(b.export.id).toBe(a.export.id);
    // Another key while the first is still being made: refused, nothing written.
    const second = await request(h2, 'another-key-1234');
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe(DATA_EXPORT_ERROR_CODES.IN_PROGRESS);
    // Not ready yet: the download says so.
    const early = await download(h2, a.export.id);
    expect(early.statusCode).toBe(412);
    expect(errorCode(early)).toBe(DATA_EXPORT_ERROR_CODES.NOT_READY);
    // Let it finish, so the next case starts clean.
    await world.api.container.dataExportRunner.tick();
  });

  it('expires after 24 h: the link answers data_export.expired and the sweep removes the file', async () => {
    const h2 = world.tenants.HOSTED_2;
    const [ready] = await rows<{ id: string; file_name: string }>(
      sql`SELECT id, file_name FROM tenant_data_exports
           WHERE tenant_id = ${HOSTED_2} AND state = 'READY' ORDER BY ready_at DESC LIMIT 1`,
    );
    const dir = join(workDir, 'data-exports', HOSTED_2);
    expect((await readdir(dir)).includes(ready!.file_name)).toBe(true);
    expect((await download(h2, ready!.id)).statusCode).toBe(200);

    // The deadline passes (the clock is the container's; the row's deadline moves instead).
    await owner().execute(
      sql`UPDATE tenant_data_exports SET expires_at = now() - interval '1 minute'
           WHERE id = ${ready!.id}`,
    );
    const gone = await download(h2, ready!.id);
    expect(gone.statusCode).toBe(412);
    expect(errorCode(gone)).toBe(DATA_EXPORT_ERROR_CODES.EXPIRED);
    const shown = (await list(h2)).json() as DataExportsResponse;
    expect(shown.exports.find((e) => e.id === ready!.id)).toMatchObject({
      state: 'EXPIRED',
      downloadable: false,
    });

    // The next pass of the worker ends it EXPIRED and removes the file.
    await world.api.container.dataExportRunner.tick();
    const [after] = await rows<{ state: string; removed_at: Date | null }>(
      sql`SELECT state, removed_at FROM tenant_data_exports WHERE id = ${ready!.id}`,
    );
    expect(after?.state).toBe('EXPIRED');
    expect(after?.removed_at).not.toBeNull();
    await expect(stat(join(dir, ready!.file_name))).rejects.toThrow();
    // Still expired, never "not found": the owner is told to ask again.
    expect((await download(h2, ready!.id)).statusCode).toBe(412);
  });

  it('a download is refused after the file vanishes from disk, as expired, never a stream of nothing', async () => {
    const h1 = world.tenants.HOSTED_1;
    const [ready] = await rows<{ id: string; file_name: string }>(
      sql`SELECT id, file_name FROM tenant_data_exports
           WHERE tenant_id = ${HOSTED_1} AND state = 'READY' LIMIT 1`,
    );
    await rm(join(workDir, 'data-exports', HOSTED_1, ready!.file_name));
    const gone = await download(h1, ready!.id);
    expect(gone.statusCode).toBe(412);
    expect(errorCode(gone)).toBe(DATA_EXPORT_ERROR_CODES.EXPIRED);
  });
});

/** The newest READY export of `t`, downloaded and unpacked (made now when there is none). */
async function latestZip(t: TenantWorld): Promise<Map<string, Buffer>> {
  const [ready] = await rows<{ id: string }>(
    sql`SELECT id FROM tenant_data_exports
         WHERE tenant_id = ${t.tenantId} AND state = 'READY' AND expires_at > now()
         ORDER BY ready_at DESC LIMIT 1`,
  );
  if (ready === undefined) {
    const made = await exportOf(t);
    return made.zip;
  }
  const file = await download(t, ready.id);
  if (file.statusCode !== 200) {
    const made = await exportOf(t);
    return made.zip;
  }
  return readZip(Buffer.from((file as unknown as { rawPayload: Buffer }).rawPayload));
}

describe('the world', () => {
  it('has the two hosted tenants this proof is about', () => {
    expect([HOSTED_1, HOSTED_2]).toEqual([
      world.tenants.HOSTED_1.tenantId,
      world.tenants.HOSTED_2.tenantId,
    ]);
  });
});
