import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BROADCAST_ROUTES,
  BULK_OPERATION_ROUTES,
  SESSION_COOKIE_NAME,
  audiencePreviewResponseSchema,
  broadcastListResponseSchema,
  broadcastRecipientListResponseSchema,
  broadcastResponseSchema,
  bulkItemListResponseSchema,
  bulkOperationResponseSchema,
  bulkPreviewResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * Broadcast and mass operations over HTTP (round N): every response parses against its
 * contract schema, the media route takes a file past the adapter's default body limit, and
 * the server — not the Web Admin — refuses a role without the key.
 */

const ORIGIN = 'https://admin.example.test';

describe('broadcast and mass-operation HTTP surface', () => {
  let api: ApiApp;
  let owner: string;
  let observer: string;
  let operator: string;
  let key = 0;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  async function cookieFor(username: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password: `the-${username}-password` },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const role of ['owner', 'observer', 'operator'] as const) {
      await createAdmin(api.container, tenantA, {
        username: role,
        password: `the-${role}-password`,
        roleKeys: [role],
      });
    }
    owner = await cookieFor('owner');
    observer = await cookieFor('observer');
    operator = await cookieFor('operator');
    const fixtures = new AudienceFixtures(
      { container: api.container } as never,
      tenantA.tenantId as string,
    );
    await fixtures.customer({ telegramUserId: '8101', botInstanceId: SEED_IDS.botA1 });
    await fixtures.customer({ telegramUserId: '8102', botInstanceId: SEED_IDS.botA1 });
  });

  const post = (path: string, cookie: string, payload: unknown = {}) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const idem = () => `bc-http-${(key += 1)}-${Date.now()}`;

  it('composes, stages media, previews, launches and reports a broadcast', async () => {
    const created = await post(BROADCAST_ROUTES.create, owner, {
      idempotencyKey: idem(),
      title: 'Photo',
      contentKind: 'PHOTO',
      body: 'سلام {firstName}',
      buttons: [{ label: 'Go', url: 'https://example.test' }],
      audience: { version: 1 },
    });
    expect(created.statusCode).toBe(201);
    const draft = broadcastResponseSchema.parse(created.json()).broadcast;

    // A PNG larger than the adapter's default 1 MB body, as base64 inside JSON.
    const png = Buffer.alloc(1_200_000, 7);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const media = await post(BROADCAST_ROUTES.media(draft.id), owner, {
      mimeType: 'image/png',
      fileName: 'offer.png',
      contentBase64: png.toString('base64'),
    });
    expect(media.statusCode).toBe(201);
    const withMedia = broadcastResponseSchema.parse(media.json()).broadcast;
    expect(withMedia.media).toMatchObject({ byteLength: png.length, available: true });

    const preview = audiencePreviewResponseSchema.parse(
      (await post(BROADCAST_ROUTES.preview(draft.id), owner)).json(),
    ).preview;
    expect(preview.customers).toBe(2);

    const launched = await post(BROADCAST_ROUTES.launch(draft.id), owner, {
      idempotencyKey: idem(),
      mode: 'NOW',
      scheduledAt: null,
      expectedVersion: withMedia.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      confirmed: true,
      typedCount: null,
    });
    expect(launched.statusCode).toBe(201);
    const sending = broadcastResponseSchema.parse(launched.json()).broadcast;
    expect(sending).toMatchObject({ state: 'SENDING', recipientCount: 2 });
    expect(sending.counts).toMatchObject({ total: 2, pending: 2 });

    const list = broadcastListResponseSchema.parse(
      (await get(BROADCAST_ROUTES.list, observer)).json(),
    );
    expect(list.broadcasts.map((row) => row.id)).toEqual([draft.id]);
    const recipients = broadcastRecipientListResponseSchema.parse(
      (await get(`${BROADCAST_ROUTES.recipients(draft.id)}?state=PENDING`, observer)).json(),
    );
    expect(recipients.recipients).toHaveLength(2);

    // A view-only role reads and cannot steer.
    expect((await post(BROADCAST_ROUTES.pause(draft.id), observer)).statusCode).toBe(403);
    const paused = await post(BROADCAST_ROUTES.pause(draft.id), owner);
    expect(broadcastResponseSchema.parse(paused.json()).broadcast.state).toBe('PAUSED');
  });

  it('refuses composing to a role without broadcasts.send', async () => {
    const response = await post(BROADCAST_ROUTES.create, operator, {
      idempotencyKey: idem(),
      title: 'x',
      contentKind: 'TEXT',
      body: 'x',
      buttons: [],
      audience: { version: 1 },
    });
    expect(response.statusCode).toBe(403);
  });

  it('previews and confirms a mass credit, and refuses a role without the key', async () => {
    const grant = { kind: 'WALLET_CREDIT', amountMinor: '1000', currency: 'IRT' };
    const refused = await post(BULK_OPERATION_ROUTES.preview, operator, {
      grant,
      definition: { version: 1 },
    });
    expect(refused.statusCode).toBe(403);

    const preview = bulkPreviewResponseSchema.parse(
      (
        await post(BULK_OPERATION_ROUTES.preview, owner, { grant, definition: { version: 1 } })
      ).json(),
    ).preview;
    expect(preview).toMatchObject({
      count: 2,
      totalLiability: { amountMinor: '2000', currency: 'IRT' },
    });

    const created = await post(BULK_OPERATION_ROUTES.create, owner, {
      idempotencyKey: idem(),
      grant,
      definition: { version: 1 },
      notify: false,
      note: 'gift',
      expectedDefinitionHash: preview.definitionHash,
      expectedCount: preview.count,
      expectedFingerprint: preview.fingerprint,
      expectedTotalMinor: preview.totalLiability?.amountMinor ?? null,
      confirmed: true,
      typedCount: preview.count,
      notBefore: null,
    });
    expect(created.statusCode).toBe(201);
    const operation = bulkOperationResponseSchema.parse(created.json()).operation;
    expect(operation).toMatchObject({ state: 'RUNNING', itemCount: 2 });
    const items = bulkItemListResponseSchema.parse(
      (await get(BULK_OPERATION_ROUTES.items(operation.id), observer)).json(),
    );
    expect(items.items).toHaveLength(2);
    const cancelled = await post(BULK_OPERATION_ROUTES.cancel(operation.id), owner);
    expect(bulkOperationResponseSchema.parse(cancelled.json()).operation.state).toBe('CANCELLED');
  });
});
