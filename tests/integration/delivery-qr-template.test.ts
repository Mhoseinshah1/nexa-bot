import { deflateSync } from 'node:zlib';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  DELIVERY_QR_ROUTES,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  type ActorContext,
  type QrTemplate,
  type TenantContext,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { encodeQrPng } from '../../apps/api/src/infrastructure/qr/qr-png';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  type TestContext,
} from './harness';
import { decodeAnyQrPng, decodeQrPng, readPngPixels } from '../support/qr-decode';
import { buildPng, chunk, gradientBackground, ihdr, pngFromChunks } from '../support/png-build';

/**
 * Phase 2 item 4 over the real container, settings and media tables: the QR background slot
 * (migration 0211), `delivery.qr_template` and its guard, the renderer the delivery lane is
 * wired with, the preview route, and tenant isolation.
 */

const URL = 'https://panel.example.com:2096/sub/aW50ZWdyYXRpb24tdGVzdC1zdWJzY3JpcHRpb24';
const TEMPLATE: QrTemplate = { x: 150, y: 120, size: 420, quietZoneModules: 4 };

function solid(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  return buildPng({ width, height, colourType: 2, pixel: () => rgb });
}

function pixelAt(png: Uint8Array, x: number, y: number): number[] {
  const image = readPngPixels(png);
  if (image === null) throw new Error('unreadable');
  const i = (y * image.width + x) * 4;
  return [image.rgba[i] ?? -1, image.rgba[i + 1] ?? -1, image.rgba[i + 2] ?? -1];
}

describe('the QR background and template (Phase 2 item 4)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let observer: ActorContext;
  let ownerB: ActorContext;
  let n = 0;
  const key = (): string => `qr-key-${(n += 1)}`;

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  const upload = (
    bytes: Buffer,
    options: {
      scope?: TenantContext;
      actor?: ActorContext;
      mimeType?: 'image/png' | 'image/jpeg';
    } = {},
  ) =>
    ctx.container.tenantMedia.upload(
      options.scope ?? tenantA,
      options.actor ?? owner,
      'QR_BACKGROUND',
      {
        mimeType: options.mimeType ?? 'image/png',
        contentBase64: bytes.toString('base64'),
        idempotencyKey: key(),
      },
    );

  const clear = (scope: TenantContext = tenantA, actor: ActorContext = owner) =>
    ctx.container.tenantMedia.clear(scope, actor, 'QR_BACKGROUND', { idempotencyKey: key() });

  const setTemplate = async (
    value: QrTemplate | null,
    scope: TenantContext = tenantA,
    actor: ActorContext = owner,
  ) => {
    const current = await ctx.container.settingsService.get(scope, actor, 'delivery.qr_template');
    return ctx.container.settingsService.set(scope, actor, {
      key: 'delivery.qr_template',
      value,
      expectedVersion: current.version,
      idempotencyKey: key(),
    });
  };

  const render = (scope: TenantContext = tenantA) =>
    ctx.container.deliveryQr.render(scope, { kind: 'PAYLOAD', text: URL });

  const isPlain = (bytes: Uint8Array) => Buffer.from(bytes).equals(Buffer.from(encodeQrPng(URL)));

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-qr', roleKeys: ['owner'] }),
    );
    observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'observer-qr',
        roleKeys: ['observer'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-qr-b', roleKeys: ['owner'] }),
    );
  });

  it('migration 0211: the purpose CHECK admits QR_BACKGROUND and still refuses an unknown slot', async () => {
    const defs = await rows<{ def: string }>(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conname = 'tenant_media_assets_purpose_check'`,
    );
    expect(defs).toHaveLength(1);
    expect(defs[0]?.def).toContain('QR_BACKGROUND');
    expect(defs[0]?.def).toContain('REFERRAL_BANNER');
    await expect(
      ctx.container.database.db.execute(
        sql`INSERT INTO tenant_media_assets (tenant_id, purpose, mime_type, content, byte_length, sha256)
            VALUES (${tenantA.tenantId}, 'NOT_A_SLOT', 'image/png', '\\x01'::bytea, 1, ${'a'.repeat(64)})`,
      ),
    ).rejects.toThrow();
  });

  it('with nothing configured, the delivery lane sends the plain QR byte for byte', async () => {
    const image = await render();
    expect(image).toMatchObject({ origin: 'NEXA_GENERATED', templated: false });
    expect(isPlain(image.bytes)).toBe(true);
    expect(decodeQrPng(image.bytes)).toBe(URL);
  });

  it('is wired into the delivery lane: the service sends through this same renderer', () => {
    const deps = (ctx.container.delivery as unknown as { deps: { qr: unknown } }).deps;
    expect(deps.qr).toBe(ctx.container.deliveryQr);
  });

  it('stores a background, places the code on it, and the QR decodes to exactly the link', async () => {
    const record = await upload(gradientBackground(800, 700));
    expect(record).toMatchObject({ purpose: 'QR_BACKGROUND', mimeType: 'image/png', version: 1 });
    expect((await setTemplate(TEMPLATE)).changed).toBe(true);

    const image = await render();
    expect(image).toMatchObject({ origin: 'NEXA_GENERATED', templated: true });
    expect(readPngPixels(image.bytes)?.width).toBe(800);
    expect(decodeAnyQrPng(image.bytes)).toBe(URL);

    // Audited as every media and settings change is: metadata and values, never the bytes.
    const audits = await rows<{ action: string; after: Record<string, unknown> }>(
      sql`SELECT action, after FROM audit_logs
           WHERE action IN ('tenant_media.upload', 'settings.set') AND result = 'SUCCESS'
           ORDER BY occurred_at, id`,
    );
    expect(audits.map((one) => one.action)).toEqual(['tenant_media.upload', 'settings.set']);
    expect(JSON.stringify(audits[0]?.after)).not.toContain('content');
    expect(audits[1]?.after).toMatchObject({ value: TEMPLATE });
  });

  it('replaces the background, and the next QR is drawn on the new one', async () => {
    await upload(solid(800, 700, [200, 10, 10]));
    await setTemplate(TEMPLATE);
    expect(pixelAt((await render()).bytes, 3, 3)).toEqual([200, 10, 10]);

    const replaced = await upload(solid(800, 700, [10, 10, 200]));
    expect(replaced.version).toBe(2);
    const image = await render();
    expect(pixelAt(image.bytes, 3, 3)).toEqual([10, 10, 200]);
    expect(decodeAnyQrPng(image.bytes)).toBe(URL);
  });

  it('a smaller replacement the region no longer fits falls back to the plain QR', async () => {
    await upload(gradientBackground(800, 700));
    await setTemplate(TEMPLATE);
    await upload(solid(400, 400, [0, 128, 0]));
    const image = await render();
    expect(image.templated).toBe(false);
    expect(isPlain(image.bytes)).toBe(true);
  });

  it('reverts to the default: the template cleared and the background removed', async () => {
    await upload(gradientBackground(800, 700));
    await setTemplate(TEMPLATE);
    expect((await render()).templated).toBe(true);
    await setTemplate(null);
    expect(isPlain((await render()).bytes)).toBe(true);
    expect(await clear()).toEqual({ cleared: true });
    expect(isPlain((await render()).bytes)).toBe(true);
    expect(await ctx.container.tenantMedia.get(tenantA, owner, 'QR_BACKGROUND')).toBeNull();
  });

  it('removing the background alone also sends the plain QR', async () => {
    await upload(gradientBackground(800, 700));
    await setTemplate(TEMPLATE);
    await clear();
    expect(isPlain((await render()).bytes)).toBe(true);
  });

  it('refuses a template with no background, or one whose region is outside it', async () => {
    await expect(setTemplate(TEMPLATE)).rejects.toMatchObject({
      code: CONTROL_ERROR_CODES.INVALID_VALUE,
    });
    await upload(gradientBackground(500, 500));
    await expect(setTemplate({ ...TEMPLATE, x: 100, size: 401 })).rejects.toMatchObject({
      code: CONTROL_ERROR_CODES.INVALID_VALUE,
    });
    // Exactly at the edge is inside.
    expect((await setTemplate({ ...TEMPLATE, x: 100, y: 80, size: 400 })).changed).toBe(true);
    // Clearing is never refused.
    expect((await setTemplate(null)).changed).toBe(true);
  });

  it('refuses a quiet zone under four modules and a fractional size at the schema', async () => {
    await upload(gradientBackground(800, 700));
    await expect(setTemplate({ ...TEMPLATE, quietZoneModules: 3 })).rejects.toMatchObject({
      code: CONTROL_ERROR_CODES.INVALID_VALUE,
    });
    await expect(setTemplate({ ...TEMPLATE, size: 300.5 })).rejects.toMatchObject({
      code: CONTROL_ERROR_CODES.INVALID_VALUE,
    });
  });

  it('refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image, storing nothing', async () => {
    const jpeg = Buffer.alloc(200, 0x22);
    Buffer.from([0xff, 0xd8, 0xff]).copy(jpeg);
    await expect(upload(jpeg, { mimeType: 'image/jpeg' })).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.MEDIA_INVALID,
      details: { reason: 'TYPE_NOT_ALLOWED' },
    });
    const damaged = Buffer.from(gradientBackground(300, 200));
    damaged.writeUInt8((damaged[70] ?? 0) ^ 0xff, 70);
    await expect(upload(damaged)).rejects.toMatchObject({
      details: { reason: 'CORRUPT' },
    });
    const bomb = pngFromChunks(
      ihdr(200, 200, 2),
      chunk('IDAT', deflateSync(Buffer.alloc(2048 * 6145))),
      chunk('IEND', Buffer.alloc(0)),
    );
    await expect(upload(bomb)).rejects.toMatchObject({
      details: { reason: 'DECOMPRESSION_BOUND' },
    });
    await expect(upload(pngFromChunks(ihdr(4096, 300, 2)))).rejects.toMatchObject({
      details: { reason: 'DIMENSIONS' },
    });
    await expect(upload(solid(100, 400, [1, 1, 1]))).rejects.toMatchObject({
      details: { reason: 'DIMENSIONS' },
    });
    expect(
      await rows(sql`SELECT 1 FROM tenant_media_assets WHERE purpose = 'QR_BACKGROUND'`),
    ).toEqual([]);
    // The referral banner keeps JPEG.
    await expect(
      ctx.container.tenantMedia.upload(tenantA, owner, 'REFERRAL_BANNER', {
        mimeType: 'image/jpeg',
        contentBase64: jpeg.toString('base64'),
        idempotencyKey: key(),
      }),
    ).resolves.toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('is the tenant’s own: tenant B keeps the plain QR, and cannot see tenant A’s slot', async () => {
    await upload(gradientBackground(800, 700));
    await setTemplate(TEMPLATE);
    expect((await render(tenantA)).templated).toBe(true);
    expect(isPlain((await render(tenantB)).bytes)).toBe(true);
    expect(await ctx.container.tenantMedia.get(tenantB, ownerB, 'QR_BACKGROUND')).toBeNull();
    // Tenant B's template is judged against tenant B's (missing) background.
    await expect(setTemplate(TEMPLATE, tenantB, ownerB)).rejects.toMatchObject({
      code: CONTROL_ERROR_CODES.INVALID_VALUE,
    });
  });

  it('writes under settings.edit only', async () => {
    await expect(upload(gradientBackground(300, 200), { actor: observer })).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    await upload(gradientBackground(800, 700));
    await expect(setTemplate(TEMPLATE, tenantA, observer)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
  });

  it('previews a draft without storing it, under settings.view', async () => {
    await upload(gradientBackground(800, 700));
    const preview = await ctx.container.deliveryQrPreview.preview(tenantA, observer, TEMPLATE);
    expect(preview).toMatchObject({ templated: true, fallback: null, width: 800, height: 700 });
    expect(preview.moduleScale).toBeGreaterThanOrEqual(4);
    expect(decodeAnyQrPng(Buffer.from(preview.pngBase64, 'base64'))).not.toBeNull();
    // Nothing stored.
    const setting = await ctx.container.settingsService.get(tenantA, owner, 'delivery.qr_template');
    expect(setting).toMatchObject({ value: null, source: 'DEFAULT' });
    const plain = await ctx.container.deliveryQrPreview.preview(tenantA, observer, null);
    expect(plain).toMatchObject({ templated: false, fallback: 'NO_TEMPLATE' });
  });
});

describe('the QR preview route', () => {
  const ORIGIN = 'https://admin.example.test';
  let api: ApiApp;

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
  });

  it('answers an authenticated operator with the rendered image', async () => {
    await createAdmin(api.container, tenantA, {
      username: 'owner-qr-http',
      roleKeys: ['owner'],
      password: 'correct horse battery staple',
    });
    const inject = (options: Record<string, unknown>) =>
      api.app
        .getHttpAdapter()
        .getInstance()
        .inject(options as never);
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-qr-http', password: 'correct horse battery staple' },
    });
    const cookie = (login.headers['set-cookie'] as string | string[] | undefined) ?? '';
    const token = (Array.isArray(cookie) ? cookie : [cookie])
      .map((one) => new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(one)?.[1])
      .find((one) => one !== undefined);
    expect(token).toBeDefined();
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${DELIVERY_QR_ROUTES.preview}`,
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${String(token)}` },
      payload: { template: null },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ templated: boolean; fallback: string; pngBase64: string }>();
    expect(body).toMatchObject({ templated: false, fallback: 'NO_TEMPLATE' });
    expect(decodeQrPng(Buffer.from(body.pngBase64, 'base64'))).not.toBeNull();
  });
});
