import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CONTROL_ERROR_CODES,
  CUSTOM_MENU_BUTTON_ROUTES,
  SESSION_COOKIE_NAME,
  customMenuButtonListResponseSchema,
  customMenuButtonMutationResponseSchema,
  CUSTOM_MENU_BUTTONS_MAX,
  CUSTOM_MENU_BUTTON_AUDIT_ACTIONS,
  CUSTOM_MENU_BUTTON_ERROR_CODES,
  CUSTOM_MENU_STORAGE_MAX_BYTES,
  PLATFORM_ERROR_CODES,
  customMenuRefOf,
  defaultMainMenuButtonConfig,
  explicitMainMenuSchema,
  isNexaError,
  mainMenuBuilderMutationResponseSchema,
  MAIN_MENU_BUTTON_IDS,
  type ActorContext,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import type { Container } from '../../apps/api/src/container';
import { frozenLayoutSchema } from '../support/frozen-main-menu-schema';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * R10 D2 — the owner's custom main-menu buttons against a real PostgreSQL: the write path
 * (permission, audit, idempotency, version, scope activity), the validation the owner sees in
 * Persian, the database's own CHECKs, and the builder's `v: 2` layout.
 *
 * Each case names a way a custom button could be created without its permission, replayed
 * into a second row, change under a colleague, take a registry label, store a hostile link or
 * file, cross a tenant, or put a layout the keyboard cannot draw behind a publish.
 */

const ORIGIN = 'https://admin.example.test';

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    if (error instanceof Error && error.name === 'ZodError') return 'request.invalid';
    throw error;
  }
  throw new Error('expected a refusal');
};

let keyCounter = 0;
const key = () => `custom-menu-${String((keyCounter += 1)).padStart(8, '0')}`;

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (extra = 16) => Buffer.concat([Buffer.from(PNG_HEAD), Buffer.alloc(extra, 1)]);
const pdf = (extra = 16) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(extra, 65)]);
const fileOf = (name: string, mimeType: string, bytes: Buffer) => ({
  fileName: name,
  mimeType,
  contentBase64: bytes.toString('base64'),
});
const photoFile = (extra = 16) => fileOf('logo.png', 'image/png', png(extra));
const pdfFile = (extra = 16) => fileOf('rules.pdf', 'application/pdf', pdf(extra));

describe('custom main-menu buttons (R10 D2)', () => {
  let api: ApiApp;
  let container: Container;
  let owner: ActorContext;
  let observer: ActorContext;
  let ownerB: ActorContext;

  const db = () => container.database.db;
  const service = () => container.customMenuButtons;
  const builder = () => container.botMenuBuilder;

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    container = api.container;
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(db());
    await seed(db(), container.cipher);
    container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(container, tenantA, {
        username: 'owner',
        password: 'the-owners-real-password',
        roleKeys: ['owner'],
      }),
    );
    observer = adminActorFor(
      await createAdmin(container, tenantA, {
        username: 'observer',
        password: 'the-observer-password',
        roleKeys: ['observer'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(container, tenantB, {
        username: 'owner-b',
        password: 'the-other-owners-password',
        roleKeys: ['owner'],
      }),
    );
  });

  const createText = (
    label: string,
    overrides: Record<string, unknown> = {},
    actor = owner,
    scope: TenantContext = tenantA,
  ) =>
    service().create(scope, actor, {
      idempotencyKey: key(),
      label,
      kind: 'TEXT',
      body: 'متن دکمه',
      ...overrides,
    });
  const createLink = (label: string, url: string, overrides: Record<string, unknown> = {}) =>
    service().create(tenantA, owner, {
      idempotencyKey: key(),
      label,
      kind: 'LINK',
      url,
      ...overrides,
    });
  const count = async (table: string) =>
    Number(
      (await db().execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${table}`)))
        .rows[0]?.n,
    );
  const auditOf = async (action: string, result = 'SUCCESS') =>
    (
      await db().execute<{ entity_id: string; before: unknown; after: unknown }>(
        sql`SELECT entity_id, before, after FROM audit_logs
             WHERE action = ${action} AND result = ${result} ORDER BY occurred_at, id`,
      )
    ).rows;

  describe('the write path', () => {
    it('creates a link, a text, a photo and a document, audited with the button as the entity', async () => {
      const link = await createLink('کانال ما', 'HTTPS://T.me/acme');
      const text = await createText('قوانین', { body: '  سلام \n دنیا ' });
      const photo = await service().create(tenantA, owner, {
        idempotencyKey: key(),
        label: 'لوگو',
        kind: 'PHOTO',
        body: 'توضیح',
        file: photoFile(),
      });
      const document = await service().create(tenantA, owner, {
        idempotencyKey: key(),
        label: 'راهنما',
        kind: 'DOCUMENT',
        file: pdfFile(),
      });
      // The link is stored NORMALISED, the text trimmed, the file under its verified name.
      expect(link.button).toMatchObject({ kind: 'LINK', url: 'https://t.me/acme', version: 1 });
      expect(text.button.body).toBe('سلام \n دنیا');
      expect(photo.button.media).toMatchObject({ mimeType: 'image/png', fileName: 'logo.png' });
      expect(document.button.media?.mimeType).toBe('application/pdf');
      const listed = await service().list(tenantA, owner);
      expect(listed.featureEnabled).toBe(false);
      expect(listed.buttons.map((one) => one.label)).toEqual([
        'کانال ما',
        'قوانین',
        'لوگو',
        'راهنما',
      ]);
      expect(listed.storage.usedBytes).toBe(
        (photo.button.media?.byteLength ?? 0) + (document.button.media?.byteLength ?? 0),
      );
      const audits = await auditOf(CUSTOM_MENU_BUTTON_AUDIT_ACTIONS.CREATED);
      expect(audits.map((row) => row.entity_id).sort()).toEqual(
        [link, text, photo, document].map((one) => one.button.id).sort(),
      );
      // The audit carries the metadata of a file, never its bytes.
      expect(JSON.stringify(audits)).not.toContain(png().toString('base64'));
    });

    it('replays an idempotent create to the first answer and a changed payload under the same key is refused', async () => {
      const idempotencyKey = key();
      const first = await service().create(tenantA, owner, {
        idempotencyKey,
        label: 'کانال ما',
        kind: 'TEXT',
        body: 'الف',
      });
      const again = await service().create(tenantA, owner, {
        idempotencyKey,
        label: 'کانال ما',
        kind: 'TEXT',
        body: 'الف',
      });
      expect(again).toEqual(first);
      expect(await count('custom_menu_buttons')).toBe(1);
      expect(
        await codeOf(
          service().create(tenantA, owner, {
            idempotencyKey,
            label: 'کانال ما',
            kind: 'TEXT',
            body: 'ب',
          }),
        ),
      ).toBe(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH);
      expect(await count('custom_menu_buttons')).toBe(1);
    });

    it('updates against the version read, reports a no-op, and refuses a stale version', async () => {
      const { button } = await createText('قوانین');
      const edit = (expectedVersion: number, extra: Record<string, unknown>) =>
        service().update(tenantA, owner, button.id, {
          idempotencyKey: key(),
          expectedVersion,
          ...extra,
        });
      const same = await edit(1, { label: 'قوانین', body: 'متن دکمه' });
      expect(same.changed).toBe(false);
      expect(same.button.version).toBe(1);
      const changed = await edit(1, { label: 'قوانین ما', body: 'متن تازه' });
      expect(changed).toMatchObject({ changed: true, button: { version: 2, label: 'قوانین ما' } });
      expect(await codeOf(edit(1, { body: 'قدیمی' }))).toBe(CONTROL_ERROR_CODES.VERSION_CONFLICT);
      const audits = await auditOf(CUSTOM_MENU_BUTTON_AUDIT_ACTIONS.UPDATED);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.before).toMatchObject({ label: 'قوانین' });
      expect(audits[0]?.after).toMatchObject({ label: 'قوانین ما' });
    });

    it('never changes a button’s kind: a link on a text button, or text with no body, is refused', async () => {
      const { button } = await createText('قوانین');
      expect(
        await codeOf(
          service().update(tenantA, owner, button.id, {
            idempotencyKey: key(),
            expectedVersion: 1,
            url: 'https://example.com',
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID);
      expect(
        await codeOf(
          service().update(tenantA, owner, button.id, {
            idempotencyKey: key(),
            expectedVersion: 1,
            body: '   ',
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID);
    });

    it('archives: the label is free again, the file is gone, a second archive is a no-op, and a row is never deleted', async () => {
      const photo = await service().create(tenantA, owner, {
        idempotencyKey: key(),
        label: 'لوگو',
        kind: 'PHOTO',
        file: photoFile(),
      });
      expect(await count('custom_menu_button_media')).toBe(1);
      const archived = await service().archive(tenantA, owner, photo.button.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
      });
      expect(archived).toMatchObject({ changed: true, button: { version: 2, media: null } });
      expect(archived.button.archivedAt).not.toBeNull();
      // The file's bytes are gone and the storage bound counts live files only.
      expect(await count('custom_menu_button_media')).toBe(0);
      const again = await service().archive(tenantA, owner, photo.button.id, {
        idempotencyKey: key(),
        expectedVersion: 99,
      });
      expect(again.changed).toBe(false);
      // The label belongs to a NEW button now; the archived row keeps its history.
      const reborn = await createText('لوگو');
      expect(reborn.button.id).not.toBe(photo.button.id);
      expect(await count('custom_menu_buttons')).toBe(2);
      // An archived button can no longer be edited.
      expect(
        await codeOf(
          service().update(tenantA, owner, photo.button.id, {
            idempotencyKey: key(),
            expectedVersion: 2,
            label: 'دیگر',
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.UNKNOWN_BUTTON);
      // And the database refuses a DELETE, whoever asks.
      const failure: unknown = await db()
        .execute(sql`DELETE FROM custom_menu_buttons WHERE id = ${photo.button.id}`)
        .then(
          () => null,
          (error: unknown) => error,
        );
      // The driver wraps the trigger's message as the failure's cause.
      expect(String((failure as { cause?: unknown } | null)?.cause)).toMatch(
        /append-only; DELETE is not permitted/u,
      );
      expect(await count('custom_menu_buttons')).toBe(2);
    });

    it('replaces a file: the old one is deleted in the same write, the kind must match', async () => {
      const photo = await service().create(tenantA, owner, {
        idempotencyKey: key(),
        label: 'لوگو',
        kind: 'PHOTO',
        file: photoFile(10),
      });
      const replaced = await service().setMedia(tenantA, owner, photo.button.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
        file: fileOf('new.png', 'image/png', png(40)),
      });
      expect(replaced).toMatchObject({
        changed: true,
        button: { version: 2, media: { fileName: 'new.png', byteLength: png(40).byteLength } },
      });
      expect(await count('custom_menu_button_media')).toBe(1);
      expect(
        await codeOf(
          service().setMedia(tenantA, owner, photo.button.id, {
            idempotencyKey: key(),
            expectedVersion: 2,
            file: pdfFile(),
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED);
      const text = await createText('قوانین');
      expect(
        await codeOf(
          service().setMedia(tenantA, owner, text.button.id, {
            idempotencyKey: key(),
            expectedVersion: 1,
            file: photoFile(),
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID);
    });

    it('denies a write without settings.edit, audits the denial and writes nothing', async () => {
      expect(await codeOf(createText('قوانین', {}, observer))).toBe(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      );
      expect(await count('custom_menu_buttons')).toBe(0);
      const denied = await auditOf(CUSTOM_MENU_BUTTON_AUDIT_ACTIONS.CREATED, 'DENIED');
      expect(denied).toHaveLength(1);
      // Reading needs settings.view, which an observer has.
      expect((await service().list(tenantA, observer)).buttons).toEqual([]);
    });

    it('refuses every write for a stopped tenant, inside the transaction', async () => {
      const { button } = await createText('قوانین');
      await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
      expect(await codeOf(createText('دیگر'))).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      expect(
        await codeOf(
          service().update(tenantA, owner, button.id, {
            idempotencyKey: key(),
            expectedVersion: 1,
            label: 'دیگر',
          }),
        ),
      ).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      expect(
        await codeOf(
          service().archive(tenantA, owner, button.id, {
            idempotencyKey: key(),
            expectedVersion: 1,
          }),
        ),
      ).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      expect(await count('custom_menu_buttons')).toBe(1);
    });

    it('isolates tenants: another tenant’s button is unknown, and labels are per tenant', async () => {
      const { button } = await createText('قوانین');
      expect(
        await codeOf(
          service().update(tenantB, ownerB, button.id, {
            idempotencyKey: key(),
            expectedVersion: 1,
            label: 'دزدی',
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.UNKNOWN_BUTTON);
      expect(
        await codeOf(
          service().archive(tenantB, ownerB, button.id, {
            idempotencyKey: key(),
            expectedVersion: 1,
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.UNKNOWN_BUTTON);
      expect((await service().list(tenantB, ownerB)).buttons).toEqual([]);
      // The same label in another tenant is another button.
      expect((await createText('قوانین', {}, ownerB, tenantB)).changed).toBe(true);
    });
  });

  describe('what the owner is refused, and why', () => {
    it('refuses a label another active button has, and one a registry button renders', async () => {
      await createText('قوانین');
      expect(await codeOf(createText('قوانین'))).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.LABEL_TAKEN);
      for (const key of [
        'bot.menu.catalog',
        'bot.menu.wallet',
        'bot.menu.admin',
      ] as TemplateKey[]) {
        const registry = (CATALOGUE_FA as Record<string, string>)[key] ?? '';
        expect(await codeOf(createText(registry)), key).toBe(
          CUSTOM_MENU_BUTTON_ERROR_CODES.LABEL_TAKEN,
        );
      }
      // Renaming onto a taken label is refused too, and onto its own is not a change.
      const other = await createText('دوم');
      expect(
        await codeOf(
          service().update(tenantA, owner, other.button.id, {
            idempotencyKey: key(),
            expectedVersion: 1,
            label: 'قوانین',
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.LABEL_TAKEN);
    });

    it('refuses an unusable label', async () => {
      for (const label of ['', '   ', '/start', 'a\nb', 'x'.repeat(65)]) {
        expect(await codeOf(createText(label)), JSON.stringify(label)).toBe(
          CUSTOM_MENU_BUTTON_ERROR_CODES.LABEL_INVALID,
        );
      }
    });

    it('refuses a link that is not an https address of a named host', async () => {
      for (const url of [
        'http://example.com',
        'tg://resolve?domain=x',
        'javascript:alert(1)',
        'data:text/html,hi',
        'https://user:pw@example.com',
        'https://example.com@evil.example',
        'https://127.0.0.1/x',
        'https://[::1]/x',
        'https://localhost/x',
        'example.com',
        '',
      ]) {
        expect(await codeOf(createLink('لینک', url)), url).toBe(
          CUSTOM_MENU_BUTTON_ERROR_CODES.URL_INVALID,
        );
      }
      expect(await count('custom_menu_buttons')).toBe(0);
    });

    it('refuses empty text, an over-long text and caption, a stray field, and a missing file', async () => {
      expect(await codeOf(createText('الف', { body: '   ' }))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID,
      );
      expect(await codeOf(createText('ب', { body: 'x'.repeat(4097) }))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID,
      );
      expect(await createText('پ', { body: 'x'.repeat(4096) })).toMatchObject({ changed: true });
      expect(
        await codeOf(
          service().create(tenantA, owner, {
            idempotencyKey: key(),
            label: 'ت',
            kind: 'PHOTO',
            body: 'x'.repeat(1025),
            file: photoFile(),
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID);
      expect(await codeOf(createText('ث', { url: 'https://example.com' }))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID,
      );
      expect(await codeOf(createText('ج', { file: photoFile() }))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.CONTENT_INVALID,
      );
      expect(
        await codeOf(
          service().create(tenantA, owner, {
            idempotencyKey: key(),
            label: 'چ',
            kind: 'PHOTO',
          }),
        ),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED);
    });

    it('refuses a file of the wrong type, size, name or content, and a photo button given a document', async () => {
      const make = (file: unknown, kind: 'PHOTO' | 'DOCUMENT' = 'PHOTO') =>
        service().create(tenantA, owner, { idempotencyKey: key(), label: `ف${key()}`, kind, file });
      // A type off the list, and bytes that are not what the type says.
      expect(await codeOf(make(fileOf('a.gif', 'image/gif', Buffer.from('GIF89a1234'))))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
      );
      expect(
        await codeOf(make(fileOf('a.png', 'image/png', Buffer.from('<html>not a png</html>')))),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED);
      // Over the photo bound (5 MiB) and an executable-looking name.
      expect(await codeOf(make(fileOf('big.png', 'image/png', png(5 * 1024 * 1024))))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
      );
      expect(await codeOf(make(fileOf('x.exe.png', 'image/png', png())))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
      );
      // A document given to a photo button, and the reverse: the kind is the button's.
      expect(await codeOf(make(pdfFile(), 'PHOTO'))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
      );
      expect(await codeOf(make(photoFile(), 'DOCUMENT'))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.FILE_REFUSED,
      );
      expect(await count('custom_menu_buttons')).toBe(0);
      expect(await count('custom_menu_button_media')).toBe(0);
    });

    it('holds the type, size and shape in the DATABASE too, whatever writes the row', async () => {
      const insertMedia = (mime: string, kind: string, bytes: number) =>
        db().execute(sql`
          INSERT INTO custom_menu_button_media
            (id, tenant_id, kind, mime_type, file_name, byte_length, sha256, content)
          VALUES (gen_random_uuid(), ${tenantA.tenantId}, ${kind}, ${mime}, 'x.bin', ${bytes},
                  repeat('a', 64), decode(repeat('00', ${bytes}), 'hex'))`);
      await expect(insertMedia('application/zip', 'DOCUMENT', 8)).rejects.toThrow();
      await expect(insertMedia('image/png', 'DOCUMENT', 8)).rejects.toThrow();
      await expect(insertMedia('image/png', 'PHOTO', 5 * 1024 * 1024 + 1)).rejects.toThrow();
      await insertMedia('image/png', 'PHOTO', 8);
      // A button whose shape does not fit its kind never gets in.
      const insertButton = (kind: string, url: string | null, body: string | null) =>
        db().execute(sql`
          INSERT INTO custom_menu_buttons (id, tenant_id, label, kind, url, body)
          VALUES (gen_random_uuid(), ${tenantA.tenantId}, ${`ل${key()}`}, ${kind}, ${url}, ${body})`);
      await expect(insertButton('LINK', null, null)).rejects.toThrow();
      await expect(insertButton('LINK', 'http://example.com', null)).rejects.toThrow();
      await expect(insertButton('TEXT', null, null)).rejects.toThrow();
      await expect(insertButton('TEXT', 'https://example.com', 'x')).rejects.toThrow();
      await expect(insertButton('PHOTO', null, null)).rejects.toThrow();
      await insertButton('LINK', 'https://example.com', null);
      await insertButton('TEXT', null, 'x');
      // A label reading as a slash command, with a newline, or untrimmed is refused.
      await expect(
        db().execute(sql`INSERT INTO custom_menu_buttons (id, tenant_id, label, kind, body)
                         VALUES (gen_random_uuid(), ${tenantA.tenantId}, '/start', 'TEXT', 'x')`),
      ).rejects.toThrow();
      await expect(
        db().execute(sql`INSERT INTO custom_menu_buttons (id, tenant_id, label, kind, body)
                         VALUES (gen_random_uuid(), ${tenantA.tenantId}, E'a\\nb', 'TEXT', 'x')`),
      ).rejects.toThrow();
    });

    it('stops at the button limit and at the storage bound', async () => {
      for (let index = 0; index < CUSTOM_MENU_BUTTONS_MAX; index += 1) {
        await db().execute(sql`
          INSERT INTO custom_menu_buttons (id, tenant_id, label, kind, body)
          VALUES (gen_random_uuid(), ${tenantA.tenantId}, ${`دکمه ${String(index)}`}, 'TEXT', 'x')`);
      }
      expect(await codeOf(createText('یکی بیشتر'))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.LIMIT_REACHED,
      );
      // One archived makes room again.
      const [first] = (await service().list(tenantA, owner)).buttons;
      if (first === undefined) throw new Error('no button');
      await service().archive(tenantA, owner, first.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
      });
      expect((await createText('یکی بیشتر')).changed).toBe(true);

      // Storage: fill it to the bound with five 10 MiB documents, then one more byte is refused.
      await db().execute(sql`
        INSERT INTO custom_menu_button_media
          (id, tenant_id, kind, mime_type, file_name, byte_length, sha256, content)
        SELECT gen_random_uuid(), ${tenantA.tenantId}, 'DOCUMENT', 'application/pdf', 'big.pdf',
               10485760, repeat('b', 64), decode(repeat('00', 10485760), 'hex')
          FROM generate_series(1, ${CUSTOM_MENU_STORAGE_MAX_BYTES / 10485760})`);
      for (const [label, kind, file] of [
        ['ص', 'PHOTO', photoFile(1)],
        ['ض', 'DOCUMENT', pdfFile(1)],
      ] as const) {
        // 20 live buttons again, so free one more slot first.
        const buttons = (await service().list(tenantA, owner)).buttons.filter(
          (one) => one.archivedAt === null,
        );
        const target = buttons[0];
        if (target !== undefined && buttons.length >= CUSTOM_MENU_BUTTONS_MAX) {
          await service().archive(tenantA, owner, target.id, {
            idempotencyKey: key(),
            expectedVersion: target.version,
          });
        }
        expect(
          await codeOf(
            service().create(tenantA, owner, { idempotencyKey: key(), label, kind, file }),
          ),
        ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.STORAGE_FULL);
      }
    }, 120_000);

    it('keeps a selected-bots button to this tenant’s bots, and an all-bots button free of bot rows', async () => {
      expect(
        await codeOf(createText('الف', { botScope: 'SELECTED', botInstanceIds: [SEED_IDS.botB1] })),
      ).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.BOT_INVALID);
      expect(await codeOf(createText('ب', { botScope: 'SELECTED', botInstanceIds: [] }))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.BOT_INVALID,
      );
      const selected = await createText('پ', {
        botScope: 'SELECTED',
        botInstanceIds: [SEED_IDS.botA2, SEED_IDS.botA1, SEED_IDS.botA1],
      });
      expect(selected.button.botInstanceIds).toEqual([SEED_IDS.botA1, SEED_IDS.botA2]);
      expect(await count('custom_menu_button_bots')).toBe(2);
      const all = await service().update(tenantA, owner, selected.button.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
        botScope: 'ALL',
      });
      expect(all.button).toMatchObject({ botScope: 'ALL', botInstanceIds: [] });
      expect(await count('custom_menu_button_bots')).toBe(0);
    });
  });

  describe('placing buttons through the builder (layout v2)', () => {
    const registryConfigs = MAIN_MENU_BUTTON_IDS.map((id) => defaultMainMenuButtonConfig(id));
    const v2Layout = (refs: readonly string[]) => ({
      v: 2,
      rows: [['catalog', 'services'], ...refs.map((ref) => [ref])],
      buttons: registryConfigs,
      customButtons: refs.map((ref) => ({ ref, enabled: true, style: 'default' })),
    });
    const settingVersion = async () =>
      (
        await db().execute<{ version: number }>(
          sql`SELECT version FROM setting_values
               WHERE tenant_id = ${tenantA.tenantId} AND setting_key = 'bot.main_menu'`,
        )
      ).rows[0]?.version ?? null;
    const save = async (layout: unknown, expectedDraftVersion: number | null) =>
      builder().saveDraft(tenantA, owner, {
        idempotencyKey: key(),
        expectedDraftVersion,
        layout,
        legacyBaselineVersion: await settingVersion(),
      });
    const publish = (expectedDraftVersion: number, expectedPublishedRevision: number | null) =>
      builder().publish(tenantA, owner, {
        idempotencyKey: key(),
        expectedDraftVersion,
        expectedPublishedRevision,
      });
    const publishedRow = async () =>
      (
        await db().execute<{ published: { v: number } | null }>(
          sql`SELECT published FROM main_menu_layouts WHERE tenant_id = ${tenantA.tenantId}`,
        )
      ).rows[0]?.published ?? null;

    it('stores a layout that places a custom button as v2, and one that places none as v1', async () => {
      const link = await createLink('کانال ما', 'https://t.me/acme');
      const ref = customMenuRefOf(link.button.id);
      const saved = await save(v2Layout([ref]), null);
      mainMenuBuilderMutationResponseSchema.parse(saved);
      expect(saved.head.draft.layout.v).toBe(2);
      await publish(1, null);
      expect((await publishedRow())?.v).toBe(2);
      // Taking the button off the layout writes v1 again — whatever shape the editor sent.
      await save(v2Layout([]), 1);
      const view = await builder().view(tenantA, owner);
      expect(view.draft.layout.v).toBe(1);
      await publish(2, 1);
      expect((await publishedRow())?.v).toBe(1);
      expect(view.customButtons.map((one) => one.label)).toEqual(['کانال ما']);
      expect(view.customMenuEnabled).toBe(false);
    });

    it('is v1 byte for byte for a tenant that never uses the feature', async () => {
      await save({ v: 1, rows: [['catalog', 'services']], buttons: registryConfigs }, null);
      await publish(1, null);
      const published = await publishedRow();
      expect(published?.v).toBe(1);
      expect(explicitMainMenuSchema.safeParse(published).success).toBe(true);
    });

    it('refuses a layout naming a button that is unknown, another tenant’s or archived, at save and at publish', async () => {
      const unknown = customMenuRefOf('01900000-0000-7000-8000-00000000dead');
      expect(await codeOf(save(v2Layout([unknown]), null))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.ARCHIVED_IN_LAYOUT,
      );
      const foreign = await createText('قوانین', {}, ownerB, tenantB);
      expect(await codeOf(save(v2Layout([customMenuRefOf(foreign.button.id)]), null))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.ARCHIVED_IN_LAYOUT,
      );
      // Saved while active, archived before the publish: the publish is refused.
      const mine = await createText('دکمهٔ من');
      await save(v2Layout([customMenuRefOf(mine.button.id)]), null);
      await service().archive(tenantA, owner, mine.button.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
      });
      expect(await codeOf(publish(1, null))).toBe(
        CUSTOM_MENU_BUTTON_ERROR_CODES.ARCHIVED_IN_LAYOUT,
      );
      expect(await publishedRow()).toBeNull();
      expect(await count('main_menu_revisions')).toBe(0);
    });

    it('refuses a layout whose only enabled button is a custom one', async () => {
      const mine = await createText('دکمهٔ من');
      const ref = customMenuRefOf(mine.button.id);
      expect(
        await codeOf(
          save(
            {
              v: 2,
              rows: [[ref]],
              buttons: registryConfigs.map((config) => ({ ...config, enabled: false })),
              customButtons: [{ ref, enabled: true, style: 'default' }],
            },
            null,
          ),
        ),
      ).toBe(CONTROL_ERROR_CODES.INVALID_VALUE);
    });

    it('projects registry buttons only into bot.main_menu, which the previous release still parses', async () => {
      const link = await createLink('کانال ما', 'https://t.me/acme');
      await save(v2Layout([customMenuRefOf(link.button.id)]), null);
      await publish(1, null);
      const setting = (
        await db().execute<{ value: unknown }>(
          sql`SELECT value FROM setting_values
               WHERE tenant_id = ${tenantA.tenantId} AND setting_key = 'bot.main_menu'`,
        )
      ).rows[0]?.value;
      expect(JSON.stringify(setting)).not.toContain('custom');
      expect(frozenLayoutSchema.safeParse(setting).success).toBe(true);
    });

    it('is read as UNREADABLE by a release that only knows v1, whose keyboard is then the projection', async () => {
      const link = await createLink('کانال ما', 'https://t.me/acme');
      await save(v2Layout([customMenuRefOf(link.button.id)]), null);
      await publish(1, null);
      const published = await publishedRow();
      // What the previous release runs over the published head: the v1 parser, untouched.
      expect(explicitMainMenuSchema.safeParse(published).success).toBe(false);
      // Its fallback — the legacy keyboard over the projection — draws registry buttons only.
      const rows = await container.mainMenu.rowsFor(tenantA);
      expect(rows.flat()).toEqual(
        expect.arrayContaining([(CATALOGUE_FA as Record<string, string>)['bot.menu.catalog']]),
      );
    });

    it('lists the owner’s buttons in the builder read, archived ones last', async () => {
      const a = await createText('اول');
      await createText('دوم');
      await service().archive(tenantA, owner, a.button.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
      });
      const view = await builder().view(tenantA, owner);
      expect(view.customButtons.map((one) => [one.label, one.archivedAt === null])).toEqual([
        ['دوم', true],
        ['اول', false],
      ]);
    });
  });

  describe('the registry label that a custom label shadows', () => {
    it('flags a registry button whose label an active custom button also carries', async () => {
      await createText('دکمهٔ من');
      // The owner renames a registry button onto the custom label afterwards.
      await container.templatesService.set(tenantA, owner, {
        idempotencyKey: key(),
        key: 'bot.menu.help',
        body: 'دکمهٔ من',
        expectedVersion: null,
        expectedRevision: null,
      });
      const view = await builder().view(tenantA, owner);
      expect(view.items.find((one) => one.id === 'help')?.duplicateLabel).toBe(true);
    });
  });

  describe('over HTTP', () => {
    const inject = (options: Record<string, unknown>) =>
      api.app
        .getHttpAdapter()
        .getInstance()
        .inject(options as never);
    async function cookieFor(username: string, password: string): Promise<string> {
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${AUTH_ROUTES.login}`,
        headers: { origin: ORIGIN },
        payload: { username, password },
      });
      const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
        String(response.headers['set-cookie'] ?? ''),
      );
      if (match === null) throw new Error(`No session for ${username}.`);
      return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
    }

    it('serves create, update, the file, archive and the list, and refuses an observer’s write', async () => {
      const ownerCookie = await cookieFor('owner', 'the-owners-real-password');
      const observerCookie = await cookieFor('observer', 'the-observer-password');
      const call = (method: string, url: string, cookie: string, payload?: unknown) =>
        inject({
          method,
          url: `${API_PREFIX}${url}`,
          headers: { cookie, origin: ORIGIN },
          ...(payload === undefined ? {} : { payload }),
        });
      const denied = await call('POST', CUSTOM_MENU_BUTTON_ROUTES.create, observerCookie, {
        idempotencyKey: key(),
        label: 'قوانین',
        kind: 'TEXT',
        body: 'متن',
      });
      expect(denied.statusCode).toBe(403);
      const created = await call('POST', CUSTOM_MENU_BUTTON_ROUTES.create, ownerCookie, {
        idempotencyKey: key(),
        label: 'لوگو',
        kind: 'PHOTO',
        file: photoFile(),
      });
      expect([200, 201]).toContain(created.statusCode);
      const button = customMenuButtonMutationResponseSchema.parse(created.json()).button;
      const updated = await call('PUT', CUSTOM_MENU_BUTTON_ROUTES.update(button.id), ownerCookie, {
        idempotencyKey: key(),
        expectedVersion: 1,
        label: 'لوگوی ما',
      });
      expect(updated.statusCode).toBe(200);
      const media = await call('PUT', CUSTOM_MENU_BUTTON_ROUTES.media(button.id), ownerCookie, {
        idempotencyKey: key(),
        expectedVersion: 2,
        file: fileOf('big.png', 'image/png', png(1_200_000)),
      });
      // A 1.2 MB file (about 1.6 MB of base64) is above Fastify's default body bound: it only
      // arrives because the route's own bound was raised.
      expect(media.statusCode).toBe(200);
      const bad = await call('POST', CUSTOM_MENU_BUTTON_ROUTES.create, ownerCookie, {
        idempotencyKey: key(),
        label: 'لینک',
        kind: 'LINK',
        url: 'http://example.com',
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe(CUSTOM_MENU_BUTTON_ERROR_CODES.URL_INVALID);
      const archived = await call(
        'POST',
        CUSTOM_MENU_BUTTON_ROUTES.archive(button.id),
        ownerCookie,
        {
          idempotencyKey: key(),
          expectedVersion: 3,
        },
      );
      expect([200, 201]).toContain(archived.statusCode);
      const list = await call('GET', CUSTOM_MENU_BUTTON_ROUTES.list, observerCookie);
      expect(list.statusCode).toBe(200);
      const parsed = customMenuButtonListResponseSchema.parse(list.json());
      expect(parsed.buttons).toHaveLength(1);
      expect(parsed.buttons[0]?.archivedAt).not.toBeNull();
    });
  });
});
