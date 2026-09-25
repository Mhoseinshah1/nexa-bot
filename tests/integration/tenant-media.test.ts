import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  TENANT_MEDIA_MAX_BYTES,
  TENANT_MEDIA_ROUTES,
  type ActorContext,
  type TenantContext,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
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

/**
 * The tenant's media slots (customer UX §I): the referral banner's bytes, in the database.
 *
 * The rules under test: the bytes are what the declared type says (magic number), bounded
 * by size, replaced with a rising version, removed on clear, scoped to the tenant, written
 * under `settings.edit` only, and NEVER copied into an audit row.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function png(size = 64): Buffer {
  const bytes = Buffer.alloc(size, 0x11);
  Buffer.from(PNG_MAGIC).copy(bytes);
  return bytes;
}

function jpeg(size = 64): Buffer {
  const bytes = Buffer.alloc(size, 0x22);
  Buffer.from(JPEG_MAGIC).copy(bytes);
  return bytes;
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('tenant media: the referral banner', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let observer: ActorContext;
  let ownerB: ActorContext;
  let n = 0;
  const key = (): string => `media-key-${(n += 1)}`;

  const service = () => ctx.container.tenantMedia;

  const upload = (
    bytes: Buffer,
    mimeType: 'image/png' | 'image/jpeg' = 'image/png',
    options: { scope?: TenantContext; actor?: ActorContext; idempotencyKey?: string } = {},
  ) =>
    service().upload(options.scope ?? tenantA, options.actor ?? owner, 'REFERRAL_BANNER', {
      mimeType,
      contentBase64: bytes.toString('base64'),
      idempotencyKey: options.idempotencyKey ?? key(),
    });

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  const stored = (scope: TenantContext = tenantA) =>
    rows<{ mime_type: string; byte_length: number; version: number; sha256: string }>(
      sql`SELECT mime_type, byte_length, version, sha256 FROM tenant_media_assets
           WHERE tenant_id = ${scope.tenantId} AND purpose = 'REFERRAL_BANNER'`,
    );

  const audits = (action: string) =>
    rows<{ result: string; before: unknown; after: unknown }>(
      sql`SELECT result, before, after FROM audit_logs WHERE action = ${action} ORDER BY occurred_at, id`,
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-media', roleKeys: ['owner'] }),
    );
    observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'observer-media',
        roleKeys: ['observer'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-media-b', roleKeys: ['owner'] }),
    );
  });

  it('stores a PNG whose bytes carry the PNG magic number, with its digest, size and version 1', async () => {
    const bytes = png(1000);
    const record = await upload(bytes);

    expect(record).toMatchObject({
      purpose: 'REFERRAL_BANNER',
      mimeType: 'image/png',
      byteLength: 1000,
      sha256: sha(bytes),
      version: 1,
    });
    expect(await service().get(tenantA, owner, 'REFERRAL_BANNER')).toEqual(record);
    const content = await service().bytesFor(tenantA, 'REFERRAL_BANNER');
    expect(content?.mimeType).toBe('image/png');
    expect(Buffer.from(content?.bytes ?? []).equals(bytes)).toBe(true);
  });

  it('stores a JPEG whose bytes carry the JPEG magic number', async () => {
    const bytes = jpeg(300);
    const record = await upload(bytes, 'image/jpeg');
    expect(record).toMatchObject({ mimeType: 'image/jpeg', byteLength: 300, sha256: sha(bytes) });
  });

  it('refuses bytes that do not match the declared type as MEDIA_INVALID, and stores nothing', async () => {
    await expect(upload(jpeg(), 'image/png')).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.MEDIA_INVALID,
    });
    await expect(upload(png(), 'image/jpeg')).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.MEDIA_INVALID,
    });
    // Too short to carry the magic number at all.
    await expect(upload(Buffer.from([0x89, 0x50]), 'image/png')).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.MEDIA_INVALID,
    });
    await expect(upload(Buffer.alloc(0), 'image/png')).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.MEDIA_INVALID,
    });
    expect(await stored()).toEqual([]);
    expect(await audits('tenant_media.upload')).toEqual([]);
  });

  it('refuses a file above the bound as MEDIA_INVALID and accepts one exactly at it', async () => {
    await expect(upload(png(TENANT_MEDIA_MAX_BYTES + 1))).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.MEDIA_INVALID,
    });
    expect(await stored()).toEqual([]);
    const record = await upload(png(TENANT_MEDIA_MAX_BYTES));
    expect(record.byteLength).toBe(TENANT_MEDIA_MAX_BYTES);
  });

  it('replaces the slot with a rising version, and replays the same key without a second version', async () => {
    const first = await upload(png(100));
    const replaced = await upload(jpeg(200), 'image/jpeg', { idempotencyKey: 'media-replace' });
    const replayed = await upload(jpeg(200), 'image/jpeg', { idempotencyKey: 'media-replace' });

    expect(first.version).toBe(1);
    expect(replaced.version).toBe(2);
    expect(replayed).toEqual(replaced);
    expect(await stored()).toEqual([
      { mime_type: 'image/jpeg', byte_length: 200, version: 2, sha256: sha(jpeg(200)) },
    ]);
    const content = await service().bytesFor(tenantA, 'REFERRAL_BANNER');
    expect(Buffer.from(content?.bytes ?? []).equals(jpeg(200))).toBe(true);
  });

  it('clears the slot, says when there was nothing to clear, and replays', async () => {
    expect(
      await service().clear(tenantA, owner, 'REFERRAL_BANNER', { idempotencyKey: key() }),
    ).toEqual({
      cleared: false,
    });
    await upload(png());
    const cleared = await service().clear(tenantA, owner, 'REFERRAL_BANNER', {
      idempotencyKey: 'media-clear',
    });
    const replayed = await service().clear(tenantA, owner, 'REFERRAL_BANNER', {
      idempotencyKey: 'media-clear',
    });

    expect(cleared).toEqual({ cleared: true });
    expect(replayed).toEqual({ cleared: true });
    expect(await stored()).toEqual([]);
    expect(await service().get(tenantA, owner, 'REFERRAL_BANNER')).toBeNull();
    expect(await service().bytesFor(tenantA, 'REFERRAL_BANNER')).toBeNull();
    // One clear audited — the one that deleted something.
    expect((await audits('tenant_media.clear')).map((row) => row.result)).toEqual(['SUCCESS']);
  });

  it('keeps each tenant to its own slot', async () => {
    await upload(png(111));
    await upload(jpeg(222), 'image/jpeg', { scope: tenantB, actor: ownerB });

    expect(await service().get(tenantA, owner, 'REFERRAL_BANNER')).toMatchObject({
      mimeType: 'image/png',
      byteLength: 111,
    });
    expect(await service().get(tenantB, ownerB, 'REFERRAL_BANNER')).toMatchObject({
      mimeType: 'image/jpeg',
      byteLength: 222,
    });

    await service().clear(tenantB, ownerB, 'REFERRAL_BANNER', { idempotencyKey: key() });
    expect(await stored(tenantA)).toHaveLength(1);
    expect(await stored(tenantB)).toHaveLength(0);
  });

  it('requires settings.edit to upload or clear and settings.view to read, auditing the denial', async () => {
    // The observer role reads settings and edits nothing.
    await expect(upload(png(), 'image/png', { actor: observer })).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    await expect(
      service().clear(tenantA, observer, 'REFERRAL_BANNER', { idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PERMISSION_DENIED });
    expect(await stored()).toEqual([]);
    expect(await service().get(tenantA, observer, 'REFERRAL_BANNER')).toBeNull();
    expect((await audits('tenant_media.upload')).map((row) => row.result)).toEqual(['DENIED']);
  });

  it('writes metadata and never bytes into the audit row', async () => {
    const bytes = png(500);
    await upload(bytes);
    await upload(jpeg(700), 'image/jpeg');

    const trail = await audits('tenant_media.upload');
    expect(trail).toHaveLength(2);
    expect(trail[0]?.before).toBeNull();
    expect(trail[0]?.after).toEqual({
      mimeType: 'image/png',
      byteLength: 500,
      sha256: sha(bytes),
      version: 1,
    });
    expect(trail[1]?.before).toEqual(trail[0]?.after);
    expect(trail[1]?.after).toMatchObject({ mimeType: 'image/jpeg', byteLength: 700, version: 2 });

    const serialised = JSON.stringify(trail);
    expect(serialised).not.toContain(bytes.toString('base64'));
    expect(serialised).not.toContain(jpeg(700).toString('base64'));
    expect(serialised).not.toContain('content');
  });
});

/**
 * The upload as the Web Admin sends it: base64 inside JSON, through Fastify's own body
 * reader. The bound the schema advertises is on the DECODED bytes; the encoded form is
 * a third larger, and the adapter's default body limit is exactly one mebibyte — so a
 * banner between about 768 KiB and the bound was refused with a 413 before the schema
 * ever ran. The route carries its own ceiling now, and this is what proves it.
 */
describe('the referral banner over HTTP', () => {
  const ORIGIN = 'https://admin.example.test';
  let api: ApiApp;
  let cookie: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

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
    await createAdmin(api.container, tenantA, {
      username: 'owner-media-http',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-media-http', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  });

  const upload = (bytes: Buffer, idempotencyKey: string) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${TENANT_MEDIA_ROUTES.upload('REFERRAL_BANNER')}`,
      headers: { origin: ORIGIN, cookie },
      payload: { mimeType: 'image/png', contentBase64: bytes.toString('base64'), idempotencyKey },
    });

  it('accepts a file exactly at the advertised bound, and refuses one past it by the schema, never by the body reader', async () => {
    const atBound = await upload(png(TENANT_MEDIA_MAX_BYTES), 'http-at-bound');
    expect(atBound.statusCode, atBound.body).toBe(201);
    expect((atBound.json() as { media: { byteLength: number } }).media.byteLength).toBe(
      TENANT_MEDIA_MAX_BYTES,
    );

    const past = await upload(png(TENANT_MEDIA_MAX_BYTES + 1), 'http-past-bound');
    // 400 from the contract's own bound — a validation refusal, not the adapter's 413.
    expect(past.statusCode, past.body).toBe(400);
    expect(past.body).toContain('"kind":"VALIDATION"');
  });
});
