import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BOT_MENU_BUILDER_AUDIT_ACTIONS,
  BOT_MENU_BUILDER_ROUTES,
  BOT_MENU_PUBLISHED_READABLE_CODE,
  BOT_MENU_PUBLISHED_UNREADABLE_CODE,
  CONTROL_ERROR_CODES,
  CONTROL_ROUTES,
  DEFAULT_EXPLICIT_MAIN_MENU,
  DEFAULT_MAIN_MENU_LAYOUT,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  botMenuBuilderResponseSchema,
  defaultMainMenuButtonConfig,
  explicitFromLegacy,
  isNexaError,
  legacyProjectionOf,
  mainMenuBuilderMutationResponseSchema,
  systemContext,
  type ActorContext,
  type BotInstanceId,
  type ExplicitMainMenu,
  type MainMenuBuilderMutationResponse,
  type MainMenuButtonId,
  type ScopeContext,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { MainMenuLayout } from '../../apps/api/src/modules/commerce/messaging/application/main-menu';
import { BotMenuBuilderService } from '../../apps/api/src/modules/control/bot-menu-builder/application/bot-menu-builder.service';
import { PublishedMainMenuSource } from '../../apps/api/src/modules/control/bot-menu-builder/application/main-menu-source';
import type { MainMenuBuilderRepository } from '../../apps/api/src/modules/control/bot-menu-builder/application/ports';
import { DrizzleMainMenuBuilderRepository } from '../../apps/api/src/modules/control/bot-menu-builder/infrastructure/drizzle-main-menu-builder.repository';
import {
  CachedAppearanceReader,
  DrizzleAppearanceRepository,
} from '../../apps/api/src/modules/control/appearance/infrastructure/drizzle-appearance.repository';
import { DrizzleSettingRepository } from '../../apps/api/src/modules/control/settings/infrastructure/drizzle-settings.repository';
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
 * Round T (T1) — the button builder's persistence, publish and revisions against a real
 * PostgreSQL (`docs/round-t-button-builder-audit.md` §13, P-1..P-6, H-1, H-2).
 *
 * Every case names a way the builder could change a customer's keyboard without a publish,
 * publish half a change, overwrite a colleague, lose history, or leak across tenants.
 */

const ORIGIN = 'https://admin.example.test';
const label = (key: TemplateKey) => (CATALOGUE_FA as Record<string, string>)[key] ?? '';

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
const key = () => `menu-builder-${String((keyCounter += 1)).padStart(8, '0')}`;

/** Three rows the legacy packing could never draw, with a style and an icon. */
function threeAcross(): ExplicitMainMenu {
  return {
    v: 1,
    rows: [['wallet', 'catalog', 'services'], ['help']],
    buttons: [
      { ...defaultMainMenuButtonConfig('wallet'), style: 'success', iconSlot: 'wallet' },
      { ...defaultMainMenuButtonConfig('catalog'), style: 'primary' },
      defaultMainMenuButtonConfig('services'),
      defaultMainMenuButtonConfig('help'),
      defaultMainMenuButtonConfig('trial'),
      defaultMainMenuButtonConfig('referral'),
      defaultMainMenuButtonConfig('apps'),
      defaultMainMenuButtonConfig('tickets'),
    ],
  };
}

const rowsOfLabels = (rows: readonly (readonly MainMenuButtonId[])[]) =>
  rows.map((row) => row.map((id) => label(`bot.menu.${id}` as TemplateKey)));

describe('the button builder (round T, T1)', () => {
  let api: ApiApp;
  let container: Container;
  let owner: ActorContext;
  let observer: ActorContext;
  let ownerB: ActorContext;

  const db = () => container.database.db;
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

  /**
   * A draft save from a page built NOW: the legacy baseline is the setting's current
   * version unless a test states the one its page was seeded from.
   */
  const saveDraft = async (
    layout: ExplicitMainMenu,
    expectedDraftVersion: number | null,
    actor = owner,
    scope: TenantContext = tenantA,
    legacyBaselineVersion?: number | null,
  ) =>
    builder().saveDraft(scope, actor, {
      idempotencyKey: key(),
      expectedDraftVersion,
      layout,
      legacyBaselineVersion:
        legacyBaselineVersion === undefined
          ? ((await settingRow(scope))?.version ?? null)
          : legacyBaselineVersion,
    });
  const publish = (
    expectedDraftVersion: number,
    expectedPublishedRevision: number | null,
    actor = owner,
    scope: TenantContext = tenantA,
  ) =>
    builder().publish(scope, actor, {
      idempotencyKey: key(),
      expectedDraftVersion,
      expectedPublishedRevision,
    });
  const reset = (expectedDraftVersion: number | null, seed: 'DEFAULT' | 'LIVE' = 'DEFAULT') =>
    builder().reset(tenantA, owner, {
      idempotencyKey: key(),
      expectedDraftVersion,
      confirm: true,
      seed,
    });
  const keyboard = (scope: ScopeContext = tenantA) => container.mainMenu.keyboardFor(scope);
  const settingRow = async (scope: TenantContext = tenantA) =>
    (
      await db().execute<{ version: number; value: unknown }>(
        sql`SELECT version, value FROM setting_values
             WHERE tenant_id = ${scope.tenantId} AND setting_key = 'bot.main_menu'`,
      )
    ).rows[0] ?? null;
  const revisionCount = async () =>
    Number(
      (await db().execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM main_menu_revisions`))
        .rows[0]?.n,
    );
  const auditActions = async (result = 'SUCCESS') =>
    (
      await db().execute<{ action: string }>(
        sql`SELECT action FROM audit_logs WHERE entity_type = 'MainMenuLayout' AND result = ${result}
             ORDER BY occurred_at, id`,
      )
    ).rows.map((row) => row.action);

  /** The keyboard a tenant that never used the builder has always had. */
  const DEFAULT_ROWS = rowsOfLabels([
    ['catalog', 'services'],
    ['wallet', 'help'],
    ['apps'],
    ['tickets'],
  ]);

  describe('a tenant that never published', () => {
    it('keeps the legacy keyboard byte for byte, styles default, no icons', async () => {
      const legacyOnly = new MainMenuLayout({
        settings: container.settingsResolver,
        features: container.featureFlagResolver,
        trials: { anyOffered: () => Promise.resolve(false) },
        templates: container.templateResolver,
      });
      expect(await container.mainMenu.rowsFor(tenantA)).toEqual(DEFAULT_ROWS);
      expect(await container.mainMenu.rowsFor(tenantA)).toEqual(await legacyOnly.rowsFor(tenantA));
      for (const button of (await keyboard()).flat()) {
        expect(button.style).toBe('default');
        expect(button.iconSlot).toBeNull();
      }
      // A stored legacy arrangement is followed exactly as before.
      await container.settingsService.set(tenantA, owner, {
        idempotencyKey: key(),
        key: 'bot.main_menu',
        value: [
          { button: 'help', enabled: true },
          { button: 'catalog', enabled: false },
        ],
        expectedVersion: null,
      });
      expect(await container.mainMenu.rowsFor(tenantA)).toEqual(await legacyOnly.rowsFor(tenantA));
      const view = await builder().view(tenantA, owner);
      expect(view.source).toBe('LEGACY');
      expect(view.superseded).toBe(false);
      expect(view.published).toBeNull();
      expect(view.draft.version).toBeNull();
      // The draft is seeded from the live arrangement, converted.
      expect(view.draft.layout).toEqual(
        explicitFromLegacy([
          { button: 'help', enabled: true },
          { button: 'catalog', enabled: false },
        ]),
      );
      botMenuBuilderResponseSchema.parse(view);
    });
  });

  describe('P-4 a draft changes nothing a customer sees', () => {
    it('saves, audits, and leaves the keyboard, the setting and the history alone', async () => {
      const before = await keyboard();
      const saved = await saveDraft(threeAcross(), null);
      expect(saved.changed).toBe(true);
      expect(saved.head.draft.version).toBe(1);
      expect(saved.head.published).toBeNull();
      expect(await keyboard()).toEqual(before);
      expect(await settingRow()).toBeNull();
      expect(await revisionCount()).toBe(0);
      expect(await auditActions()).toEqual([BOT_MENU_BUILDER_AUDIT_ACTIONS.DRAFT_SAVED]);
      // Saving the same layout again is a no-op: no version bump, no audit row.
      const again = await saveDraft(threeAcross(), 1);
      expect(again.changed).toBe(false);
      expect(again.head.draft.version).toBe(1);
      expect(await auditActions()).toHaveLength(1);
    });

    it('refuses an invalid layout with the issues, server-side', async () => {
      const bad = { ...threeAcross(), rows: [['wallet', 'wallet']] };
      expect(await codeOf(saveDraft(bad as ExplicitMainMenu, null))).toBe(
        CONTROL_ERROR_CODES.INVALID_VALUE,
      );
      const hidden = {
        ...threeAcross(),
        rows: [['trial', 'referral']],
      };
      expect(await codeOf(saveDraft(hidden as ExplicitMainMenu, null))).toBe(
        CONTROL_ERROR_CODES.INVALID_VALUE,
      );
    });
  });

  describe('publish', () => {
    it('draws the published rows, writes a projection the PREVIOUS release parses, a revision, an audit row and SettingChanged', async () => {
      await saveDraft(threeAcross(), null);
      const published = await publish(1, null);
      expect(published.changed).toBe(true);
      expect(published.head.published?.revision).toBe(1);
      expect(published.head.draft.differsFromPublished).toBe(false);

      const rows = await keyboard();
      expect(rows).toEqual([
        [
          // The icon (restored 2026-10-05) is stored, published and drawn as a SLOT; the
          // transport resolves it per sending bot.
          { text: label('bot.menu.wallet'), style: 'success', iconSlot: 'wallet' },
          { text: label('bot.menu.catalog'), style: 'primary', iconSlot: null },
          { text: label('bot.menu.services'), style: 'default', iconSlot: null },
        ],
        [{ text: label('bot.menu.help'), style: 'default', iconSlot: null }],
      ]);
      const snapshots = await db().execute<{ snapshot: ExplicitMainMenu }>(
        sql`SELECT snapshot FROM main_menu_revisions WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(
        snapshots.rows[0]?.snapshot.buttons.find((one) => one.button === 'wallet')?.iconSlot,
      ).toBe('wallet');
      expect(
        snapshots.rows[0]?.snapshot.buttons.filter((one) => one.iconSlot !== null),
      ).toHaveLength(1);
      // The text-only view the transport draws until T2 is the same rows' labels.
      expect(await container.mainMenu.rowsFor(tenantA)).toEqual(
        rowsOfLabels([['wallet', 'catalog', 'services'], ['help']]),
      );

      // The compatibility projection: exactly `legacyProjectionOf`, and accepted by the
      // previous release's parser, frozen verbatim.
      const setting = await settingRow();
      expect(setting?.version).toBe(1);
      expect(setting?.value).toEqual(legacyProjectionOf(threeAcross()));
      expect(frozenLayoutSchema.safeParse(setting?.value).success).toBe(true);
      const resolved = await container.settingsResolver.resolve(tenantA, 'bot.main_menu');
      expect(resolved.storedValueInvalid).toBe(false);

      expect(await revisionCount()).toBe(1);
      expect(await auditActions()).toEqual([
        BOT_MENU_BUILDER_AUDIT_ACTIONS.DRAFT_SAVED,
        BOT_MENU_BUILDER_AUDIT_ACTIONS.PUBLISHED,
      ]);
      const events = await db().execute<{ payload: { key: string } }>(
        sql`SELECT payload FROM outbox_messages WHERE event_type = 'SettingChanged'`,
      );
      expect(events.rows.map((row) => row.payload.key)).toEqual(['bot.main_menu']);

      // A publish of what is already published is a no-op.
      const again = await publish(1, 1);
      expect(again.changed).toBe(false);
      expect(await revisionCount()).toBe(1);

      // The read reports the explicit source.
      const view = await builder().view(tenantA, owner);
      expect(view.source).toBe('EXPLICIT');
      expect(view.live.rows).toEqual(rowsOfLabels([['wallet', 'catalog', 'services'], ['help']]));
    });

    it('P-1 is atomic: a failure after the projection write leaves nothing written', async () => {
      await saveDraft(threeAcross(), null);
      for (const failAt of ['insertRevision', 'publish'] as const) {
        const real = new DrizzleMainMenuBuilderRepository(db());
        const failing: MainMenuBuilderRepository = Object.assign(Object.create(real) as object, {
          [failAt]: () => Promise.reject(new Error(`injected failure at ${failAt}`)),
        }) as unknown as MainMenuBuilderRepository;
        const service = serviceWith(container, { repository: failing });
        await expect(
          service.publish(tenantA, owner, {
            idempotencyKey: key(),
            expectedDraftVersion: 1,
            expectedPublishedRevision: null,
          }),
        ).rejects.toThrow(`injected failure at ${failAt}`);
        expect(await settingRow()).toBeNull();
        expect(await revisionCount()).toBe(0);
        const view = await builder().view(tenantA, owner);
        expect(view.published).toBeNull();
        expect(await auditActions()).toEqual([BOT_MENU_BUILDER_AUDIT_ACTIONS.DRAFT_SAVED]);
        expect(await container.mainMenu.rowsFor(tenantA)).toEqual(DEFAULT_ROWS);
      }
    });

    it('P-2 refuses a stale draft version, a stale published revision, and a setting moved underneath', async () => {
      await saveDraft(threeAcross(), null);
      // Draft: a second first-save, and a stale version.
      expect(await codeOf(saveDraft(DEFAULT_EXPLICIT_MAIN_MENU, null))).toBe(
        CONTROL_ERROR_CODES.VERSION_CONFLICT,
      );
      expect(await codeOf(saveDraft(DEFAULT_EXPLICIT_MAIN_MENU, 7))).toBe(
        CONTROL_ERROR_CODES.VERSION_CONFLICT,
      );
      // Publish: a stale draft version, then a stale published revision.
      expect(await codeOf(publish(2, null))).toBe(CONTROL_ERROR_CODES.VERSION_CONFLICT);
      expect(await codeOf(publish(1, 3))).toBe(CONTROL_ERROR_CODES.VERSION_CONFLICT);
      // The setting written by somebody else between the read and the projection write:
      // the projection's own version predicate refuses, and nothing is published.
      const service = serviceWith(container, {
        settings: {
          resolve: async (scope, settingKey, tx) => {
            const read = await container.settingsResolver.resolve(scope, settingKey, tx);
            await db().execute(
              sql`INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
                  VALUES (${container.ids.uuid()}, ${tenantA.tenantId}, 'bot.main_menu',
                          ${JSON.stringify(DEFAULT_MAIN_MENU_LAYOUT)}::jsonb, 1, now())`,
            );
            return read;
          },
        },
      });
      expect(
        await codeOf(
          service.publish(tenantA, owner, {
            idempotencyKey: key(),
            expectedDraftVersion: 1,
            expectedPublishedRevision: null,
          }),
        ),
      ).toBe(CONTROL_ERROR_CODES.VERSION_CONFLICT);
      expect(await revisionCount()).toBe(0);
      expect((await builder().view(tenantA, owner)).published).toBeNull();
      // Nothing above wrote anything but the one draft.
      expect(await auditActions()).toEqual([BOT_MENU_BUILDER_AUDIT_ACTIONS.DRAFT_SAVED]);
    });

    it('carries the version predicate in the statement itself, whatever lock the caller holds', async () => {
      await saveDraft(threeAcross(), null);
      const repository = new DrizzleMainMenuBuilderRepository(db());
      const write = (expectedDraftVersion: number) =>
        container.uow.run(tenantA, (tx) =>
          repository.updateDraft(
            tenantA,
            {
              expectedDraftVersion,
              draft: DEFAULT_EXPLICIT_MAIN_MENU,
              now: container.clock.now(),
              adminId: null,
              restoredFromRevisionId: null,
            },
            tx,
          ),
        );
      expect(await write(2)).toBeNull();
      expect((await write(1))?.draftVersion).toBe(2);
      const publishAt = (expectedDraftVersion: number, expectedPublishedRevision: number | null) =>
        container.uow.run(tenantA, (tx) =>
          repository.publish(
            tenantA,
            {
              expectedDraftVersion,
              expectedPublishedRevision,
              published: DEFAULT_EXPLICIT_MAIN_MENU,
              revision: 1,
              now: container.clock.now(),
              adminId: null,
              projectionSettingVersion: 1,
            },
            tx,
          ),
        );
      expect(await publishAt(1, null)).toBeNull();
      expect(await publishAt(2, 1)).toBeNull();
      expect((await publishAt(2, null))?.publishedRevision).toBe(1);
    });

    it('P-3 replays the FIRST answer after a colleague’s later publish, and refuses the key with another body', async () => {
      await saveDraft(threeAcross(), null);
      const command = {
        idempotencyKey: 'menu-builder-replayed-publish',
        expectedDraftVersion: 1,
        expectedPublishedRevision: null,
      };
      const first = await builder().publish(tenantA, owner, command);
      await saveDraft(DEFAULT_EXPLICIT_MAIN_MENU, 1);
      await publish(2, 1);
      const replay = await builder().publish(tenantA, owner, command);
      expect(replay).toEqual(first);
      expect(replay.head.published?.revision).toBe(1);
      expect(await revisionCount()).toBe(2);
      expect(
        await codeOf(builder().publish(tenantA, owner, { ...command, expectedDraftVersion: 2 })),
      ).toBe(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH);
      // The draft save replays the same way.
      const draftCommand = {
        idempotencyKey: 'menu-builder-replayed-draft',
        expectedDraftVersion: 2,
        layout: threeAcross(),
        legacyBaselineVersion: null,
      };
      const saved = await builder().saveDraft(tenantA, owner, draftCommand);
      expect(await builder().saveDraft(tenantA, owner, draftCommand)).toEqual(saved);
    });

    it('P-3b refuses a draft key replayed with ANOTHER layout, and never reports the first save for it', async () => {
      // A save whose response was lost is retried under its key after the operator edited:
      // replaying the first answer would report the newer layout saved when it was not.
      const command = {
        idempotencyKey: 'menu-builder-replayed-draft-edited',
        expectedDraftVersion: null,
        layout: threeAcross(),
        legacyBaselineVersion: null,
      };
      const first = await builder().saveDraft(tenantA, owner, command);
      expect(first.head.draft.version).toBe(1);
      // Same key, same body: the first answer, nothing written twice.
      expect(await builder().saveDraft(tenantA, owner, command)).toEqual(first);
      // Same key, the operator's later layout: refused, whatever the versions say.
      expect(
        await codeOf(
          builder().saveDraft(tenantA, owner, { ...command, layout: DEFAULT_EXPLICIT_MAIN_MENU }),
        ),
      ).toBe(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH);
      const view = await builder().view(tenantA, owner);
      expect(view.draft.version).toBe(1);
      expect(view.draft.layout).toEqual(first.head.draft.layout);
      expect(await auditActions()).toEqual([BOT_MENU_BUILDER_AUDIT_ACTIONS.DRAFT_SAVED]);
    });

    it('P-5 a setting written behind the publish by an older release wins, is reported superseded, and is never overwritten unseen', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      // What a rolled-back release writes: its own shape, a new version.
      await db().execute(
        sql`UPDATE setting_values
               SET value = ${JSON.stringify([{ button: 'help', enabled: true }])}::jsonb,
                   version = version + 1
             WHERE tenant_id = ${tenantA.tenantId} AND setting_key = 'bot.main_menu'`,
      );
      expect(await container.mainMenu.rowsFor(tenantA)).toEqual(
        rowsOfLabels([['help', 'catalog'], ['services', 'wallet'], ['apps'], ['tickets']]),
      );
      const view = await builder().view(tenantA, owner);
      expect(view.superseded).toBe(true);
      expect(view.source).toBe('LEGACY');
      expect(view.draft.legacyChangedSinceDraft).toBe(true);
      // The same draft does NOT publish over the older release's write.
      expect(await codeOf(publish(1, 1))).toBe(CONTROL_ERROR_CODES.VERSION_CONFLICT);
      expect((await settingRow())?.version).toBe(2);
      // The operator adopts the live arrangement knowingly, puts revision 1 back into the
      // draft, and publishes: revision 2, current again.
      const reseeded = await reset(1, 'LIVE');
      expect(reseeded.head.draft.legacyBaselineVersion).toBe(2);
      const [revisionOne] = (await builder().revisions(tenantA, owner, {})).revisions;
      await builder().restore(tenantA, owner, revisionOne?.id ?? '', {
        idempotencyKey: key(),
        expectedDraftVersion: 2,
      });
      const republished = await publish(3, 1);
      expect(republished.changed).toBe(true);
      expect(republished.head.published?.revision).toBe(2);
      expect(republished.head.published?.layout).toEqual(revisionOne?.layout);
      expect((await settingRow())?.version).toBe(3);
      const after = await builder().view(tenantA, owner);
      expect(after.superseded).toBe(false);
      expect(after.source).toBe('EXPLICIT');
      expect(after.draft.legacyBaselineVersion).toBe(3);
    });

    it('P-7 never publishes a draft over a legacy write made after the draft was seeded, even after a reload', async () => {
      const legacy = (button: MainMenuButtonId) => [{ button, enabled: true }];
      const writeLegacy = (button: MainMenuButtonId, expectedVersion: number | null) =>
        container.settingsService.set(tenantA, owner, {
          idempotencyKey: key(),
          key: 'bot.main_menu',
          value: legacy(button),
          expectedVersion,
        });
      // Seeded from N (no row), saved, then the legacy path moves the setting to N+1.
      const loaded = await builder().view(tenantA, owner);
      expect(loaded.draft.legacyBaselineVersion).toBeNull();
      await saveDraft(threeAcross(), null, owner, tenantA, loaded.draft.legacyBaselineVersion);
      await writeLegacy('help', null);
      expect(await codeOf(publish(1, null))).toBe(CONTROL_ERROR_CODES.VERSION_CONFLICT);
      // N+1 untouched; no revision, no published head.
      expect(await settingRow()).toEqual({ version: 1, value: legacy('help') });
      expect(await revisionCount()).toBe(0);

      // A reload does not rebase the durable draft: the fresh versions still conflict.
      const reloaded = await builder().view(tenantA, owner);
      expect(reloaded.published).toBeNull();
      expect(reloaded.draft.version).toBe(1);
      expect(reloaded.draft.legacyBaselineVersion).toBeNull();
      expect(reloaded.draft.legacyChangedSinceDraft).toBe(true);
      expect(
        await codeOf(publish(reloaded.draft.version ?? 0, reloaded.published?.revision ?? null)),
      ).toBe(CONTROL_ERROR_CODES.VERSION_CONFLICT);
      expect(await settingRow()).toEqual({ version: 1, value: legacy('help') });
      expect(await revisionCount()).toBe(0);

      // The page seeded at N, then a legacy write lands BEFORE the first save: the baseline the
      // page states is stored, not today's version, so the publish still conflicts.
      await db().execute(sql`TRUNCATE main_menu_layouts`);
      const seededAt = await builder().view(tenantA, owner);
      expect(seededAt.draft.legacyBaselineVersion).toBe(1);
      await writeLegacy('wallet', 1);
      await saveDraft(threeAcross(), null, owner, tenantA, seededAt.draft.legacyBaselineVersion);
      expect(await codeOf(publish(1, null))).toBe(CONTROL_ERROR_CODES.VERSION_CONFLICT);
      expect(await settingRow()).toEqual({ version: 2, value: legacy('wallet') });

      // Reseeded from the live arrangement — knowingly — it publishes, and the projection's
      // version becomes the draft's new baseline.
      const reseeded = await reset(1, 'LIVE');
      expect(reseeded.head.draft.layout).toEqual(explicitFromLegacy(legacy('wallet')));
      expect(reseeded.head.draft.legacyBaselineVersion).toBe(2);
      expect(reseeded.head.draft.legacyChangedSinceDraft).toBe(false);
      const published = await publish(2, null);
      expect(published.head.published?.revision).toBe(1);
      expect(published.head.draft.legacyBaselineVersion).toBe(3);
      expect(published.head.settingVersion).toBe(3);
    });

    it('P-8 builds the read from ONE state read: a publish committing during it is not reported superseded', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      await saveDraft(DEFAULT_EXPLICIT_MAIN_MENU, 1);
      // A colleague's publish commits right after the builder's FIRST read of the menu state
      // — whichever read that is — so revision 2 and the setting's version 2 land between it
      // and anything the read does afterwards.
      const real = new DrizzleMainMenuBuilderRepository(db());
      let armed = true;
      const race = async () => {
        if (!armed) return;
        armed = false;
        await publish(2, 1);
      };
      const racing = Object.assign(Object.create(real) as object, {
        findLayout: async (scope: ScopeContext, tx?: unknown, forUpdate?: boolean) => {
          const found = await real.findLayout(scope, tx, forUpdate);
          await race();
          return found;
        },
        readMenuState: async (scope: ScopeContext, tx?: unknown) => {
          const found = await real.readMenuState(scope, tx);
          await race();
          return found;
        },
      }) as unknown as MainMenuBuilderRepository;
      const view = await serviceWith(container, { repository: racing }).view(tenantA, owner);
      expect(armed).toBe(false);
      expect((await settingRow())?.version).toBe(2);
      // The answer describes ONE state: revision 1 with its own projection, drawn as such.
      expect(view.published?.revision).toBe(1);
      expect(view.settingVersion).toBe(1);
      expect(view.superseded).toBe(false);
      expect(view.source).toBe('EXPLICIT');
      expect(view.live.rows).toEqual(rowsOfLabels([['wallet', 'catalog', 'services'], ['help']]));
      expect(view.items.find((item) => item.id === 'wallet')).toBeDefined();
      // And the next read sees the colleague's publish, whole.
      const after = await builder().view(tenantA, owner);
      expect(after.published?.revision).toBe(2);
      expect(after.settingVersion).toBe(2);
      expect(after.live.rows).toEqual(DEFAULT_ROWS);
    });

    it('P-6 refuses a direct bot.main_menu settings write once published, and only then', async () => {
      const write = (value: unknown, expectedVersion: number | null) =>
        container.settingsService.set(tenantA, owner, {
          idempotencyKey: key(),
          key: 'bot.main_menu',
          value,
          expectedVersion,
        });
      // Never published: the settings path is the keyboard, and still writes.
      await write([{ button: 'wallet', enabled: true }], null);
      await saveDraft(threeAcross(), null);
      // A draft alone does not close it either.
      await write([{ button: 'help', enabled: true }], 1);
      // (That write moved the setting past the draft's baseline: reseeded, knowingly.)
      await reset(1, 'LIVE');
      await publish(2, null);
      const version = (await settingRow())?.version ?? 0;
      expect(await codeOf(write(DEFAULT_MAIN_MENU_LAYOUT, version))).toBe(
        CONTROL_ERROR_CODES.INVALID_VALUE,
      );
      expect((await settingRow())?.version).toBe(version);
      expect((await builder().view(tenantA, owner)).superseded).toBe(false);
      // Writing back exactly what is stored is a no-op, never asked of the guard.
      const unchanged = await write((await settingRow())?.value, version);
      expect(unchanged.changed).toBe(false);
    });

    it('draws a layout stored WITH icons (any release) with them, through the view and the revision', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      // What v0.4.x stored (or the retiring release left unrewritten): wallet AND help iconed.
      const withIcons = {
        ...threeAcross(),
        buttons: threeAcross().buttons.map((one) =>
          one.button === 'help' ? { ...one, iconSlot: 'support' } : one,
        ),
      };
      await db().execute(
        sql`UPDATE main_menu_layouts
               SET published = ${JSON.stringify(withIcons)}::jsonb,
                   draft = ${JSON.stringify(withIcons)}::jsonb
             WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(await keyboard()).toEqual([
        [
          { text: label('bot.menu.wallet'), style: 'success', iconSlot: 'wallet' },
          { text: label('bot.menu.catalog'), style: 'primary', iconSlot: null },
          { text: label('bot.menu.services'), style: 'default', iconSlot: null },
        ],
        [{ text: label('bot.menu.help'), style: 'default', iconSlot: 'support' }],
      ]);
      const view = await builder().view(tenantA, owner);
      expect(view.source).toBe('EXPLICIT');
      expect(view.publishedUnreadable).toBe(false);
      expect(view.published?.layout?.buttons.find((one) => one.button === 'help')?.iconSlot).toBe(
        'support',
      );
      expect(view.draft.differsFromPublished).toBe(false);
      // The revision written by the publish keeps the icon it was published with.
      const [revision] = (await builder().revisions(tenantA, owner, {})).revisions;
      expect(revision?.layout?.buttons.find((one) => one.button === 'wallet')?.iconSlot).toBe(
        'wallet',
      );
    });

    it('removes an icon cleanly: the draft that drops it differs, and its publish draws the label alone', async () => {
      await saveDraft(threeAcross(), null);
      const first = await publish(1, null);
      const removed = {
        ...threeAcross(),
        buttons: threeAcross().buttons.map((one) => ({ ...one, iconSlot: null })),
      };
      const saved = await saveDraft(removed, first.head.draft.version);
      expect(saved.changed).toBe(true);
      expect(saved.head.draft.differsFromPublished).toBe(true);
      // Nothing published yet: the customer still sees the icon.
      expect((await keyboard())[0]?.[0]?.iconSlot).toBe('wallet');
      await publish(saved.head.draft.version ?? 0, first.head.published?.revision ?? null);
      expect(await keyboard()).toEqual([
        [
          { text: label('bot.menu.wallet'), style: 'success', iconSlot: null },
          { text: label('bot.menu.catalog'), style: 'primary', iconSlot: null },
          { text: label('bot.menu.services'), style: 'default', iconSlot: null },
        ],
        [{ text: label('bot.menu.help'), style: 'default', iconSlot: null }],
      ]);
      // Rows, styles and every label — what a tap routes by — are unchanged by the removal.
      expect(await container.mainMenu.rowsFor(tenantA)).toEqual(
        rowsOfLabels([['wallet', 'catalog', 'services'], ['help']]),
      );
    });

    it('falls back to the setting when the published snapshot is unreadable, says so, and a publish closes it', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      // A later release's shape, after a rollback.
      await db().execute(
        sql`UPDATE main_menu_layouts SET published = '{"v":2,"rows":[]}'::jsonb
             WHERE tenant_id = ${tenantA.tenantId}`,
      );
      // The keyboard is the projection (same order and visibility), packed the legacy way.
      expect(await container.mainMenu.rowsFor(tenantA)).toEqual(
        rowsOfLabels([
          ['wallet', 'catalog'],
          ['services', 'help'],
        ]),
      );
      const open = await db().execute<{ code: string; resolved: boolean }>(
        sql`SELECT code, resolved_at IS NOT NULL AS resolved FROM operational_events
             WHERE tenant_id = ${tenantA.tenantId} AND code = ${BOT_MENU_PUBLISHED_UNREADABLE_CODE}`,
      );
      expect(open.rows).toEqual([{ code: BOT_MENU_PUBLISHED_UNREADABLE_CODE, resolved: false }]);
      const view = await builder().view(tenantA, owner);
      expect(view.publishedUnreadable).toBe(true);
      expect(view.published?.layout).toBeNull();
      await publish(1, 1);
      const closed = await db().execute<{ resolved: boolean }>(
        sql`SELECT resolved_at IS NOT NULL AS resolved FROM operational_events
             WHERE tenant_id = ${tenantA.tenantId} AND code = ${BOT_MENU_PUBLISHED_UNREADABLE_CODE}`,
      );
      expect(closed.rows).toEqual([{ resolved: true }]);
      const recovered = await db().execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM operational_events
             WHERE code = ${BOT_MENU_PUBLISHED_READABLE_CODE}`,
      );
      expect(recovered.rows[0]?.n).toBe('1');
      expect((await builder().view(tenantA, owner)).source).toBe('EXPLICIT');
    });
  });

  describe('H-1 revisions, reset and restore', () => {
    it('keeps revisions append-only by trigger', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      await expect(
        db().execute(sql`UPDATE main_menu_revisions SET revision = 9`),
      ).rejects.toThrow();
      await expect(db().execute(sql`DELETE FROM main_menu_revisions`)).rejects.toThrow();
      expect(await revisionCount()).toBe(1);
    });

    it('restores INTO THE DRAFT only, and publishing it is revision n+1 carrying restoredFrom', async () => {
      await saveDraft(threeAcross(), null);
      const first = await publish(1, null);
      await saveDraft(DEFAULT_EXPLICIT_MAIN_MENU, 1);
      await publish(2, 1);
      const live = await keyboard();
      const { revisions } = await builder().revisions(tenantA, owner, {});
      const revisionOne = revisions.find((one) => one.revision === 1);
      expect(revisionOne?.layout).toEqual(first.head.published?.layout);

      const restored = await builder().restore(tenantA, owner, revisionOne?.id ?? '', {
        idempotencyKey: key(),
        expectedDraftVersion: 2,
      });
      expect(restored.changed).toBe(true);
      expect(restored.head.draft.restoredFrom).toEqual({ id: revisionOne?.id, revision: 1 });
      expect(restored.head.published?.revision).toBe(2);
      // Never live: the keyboard is still revision 2's.
      expect(await keyboard()).toEqual(live);

      const republished = await publish(3, 2);
      expect(republished.head.published?.revision).toBe(3);
      expect(republished.head.draft.restoredFrom).toBeNull();
      const latest = (await builder().revisions(tenantA, owner, { limit: 1 })).revisions[0];
      expect(latest?.revision).toBe(3);
      expect(latest?.restoredFrom).toEqual({ id: revisionOne?.id, revision: 1 });
      expect(await keyboard()).not.toEqual(live);
      expect(await auditActions()).toContain(BOT_MENU_BUILDER_AUDIT_ACTIONS.RESTORED);
    });

    it('names a revision’s publisher by the administrator’s display name (round-T QA-4)', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      await db().execute(
        sql`UPDATE admins SET display_name = 'Sara Ahmadi' WHERE id = ${owner.id}`,
      );
      const [revision] = (await builder().revisions(tenantA, owner, {})).revisions;
      expect(revision?.createdByAdminId).toBe(owner.id);
      expect(revision?.createdByAdminName).toBe('Sara Ahmadi');
      // (Another tenant's administrator cannot be a publisher at all: the tenant-scoped
      // foreign key `main_menu_revisions_tenant_admin_fk` refuses the row.)
    });

    it('pages revisions newest first', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      await saveDraft(DEFAULT_EXPLICIT_MAIN_MENU, 1);
      await publish(2, 1);
      await saveDraft(threeAcross(), 2);
      await publish(3, 2);
      const page = await builder().revisions(tenantA, owner, { limit: '2' });
      expect(page.revisions.map((one) => one.revision)).toEqual([3, 2]);
      expect(page.nextBefore).toBe(2);
      const rest = await builder().revisions(tenantA, owner, { before: '2', limit: '2' });
      expect(rest.revisions.map((one) => one.revision)).toEqual([1]);
      expect(rest.nextBefore).toBeNull();
      expect(await codeOf(builder().revisions(tenantA, owner, { limit: '51' }))).toBe(
        'request.invalid',
      );
    });

    it('answers another tenant’s revision as not found', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      const [revision] = (await builder().revisions(tenantA, owner, {})).revisions;
      expect(
        await codeOf(
          builder().restore(tenantB, ownerB, revision?.id ?? '', {
            idempotencyKey: key(),
            expectedDraftVersion: null,
          }),
        ),
      ).toBe(CONTROL_ERROR_CODES.MAIN_MENU_REVISION_NOT_FOUND);
      expect(
        await codeOf(
          builder().restore(tenantA, owner, 'not-a-uuid', {
            idempotencyKey: key(),
            expectedDraftVersion: 1,
          }),
        ),
      ).toBe(CONTROL_ERROR_CODES.MAIN_MENU_REVISION_NOT_FOUND);
      expect((await builder().revisions(tenantB, ownerB, {})).revisions).toEqual([]);
    });

    it('resets the DRAFT to the registry default only when confirmed, and never live', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      const live = await keyboard();
      expect(
        await codeOf(
          builder().reset(tenantA, owner, { idempotencyKey: key(), expectedDraftVersion: 1 }),
        ),
      ).toBe('request.invalid');
      expect(
        await codeOf(
          builder().reset(tenantA, owner, {
            idempotencyKey: key(),
            expectedDraftVersion: 1,
            confirm: false,
          }),
        ),
      ).toBe('request.invalid');
      const reset = await builder().reset(tenantA, owner, {
        idempotencyKey: key(),
        expectedDraftVersion: 1,
        confirm: true,
      });
      expect(reset.changed).toBe(true);
      expect(reset.head.draft.layout).toEqual(DEFAULT_EXPLICIT_MAIN_MENU);
      expect(reset.head.draft.differsFromPublished).toBe(true);
      expect(await keyboard()).toEqual(live);
      expect(await auditActions()).toContain(BOT_MENU_BUILDER_AUDIT_ACTIONS.RESET);
    });
  });

  describe('H-2 permissions, audit and scope', () => {
    it('lets settings.view read and refuses every write without settings.edit, auditing each denial', async () => {
      const view = await builder().view(tenantA, observer);
      expect(view.items.map((item) => item.id)).toHaveLength(8);
      await builder().revisions(tenantA, observer, {});
      // Thunks, run one at a time: the order of the DENIED rows is asserted below.
      const refusals = [
        () => saveDraft(threeAcross(), null, observer),
        () => publish(1, null, observer),
        () =>
          builder().reset(tenantA, observer, {
            idempotencyKey: key(),
            expectedDraftVersion: null,
            confirm: true,
          }),
        () =>
          builder().restore(tenantA, observer, container.ids.uuid(), {
            idempotencyKey: key(),
            expectedDraftVersion: null,
          }),
      ];
      for (const refusal of refusals) {
        expect(await codeOf(refusal())).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
      }
      expect(await auditActions('DENIED')).toEqual([
        BOT_MENU_BUILDER_AUDIT_ACTIONS.DRAFT_SAVED,
        BOT_MENU_BUILDER_AUDIT_ACTIONS.PUBLISHED,
        BOT_MENU_BUILDER_AUDIT_ACTIONS.RESET,
        BOT_MENU_BUILDER_AUDIT_ACTIONS.RESTORED,
      ]);
      expect(await auditActions()).toEqual([]);
    });

    it('refuses every write for a stopped tenant, inside the transaction', async () => {
      await saveDraft(threeAcross(), null);
      await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
      expect(await codeOf(saveDraft(DEFAULT_EXPLICIT_MAIN_MENU, 1))).toBe(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      );
      expect(await codeOf(publish(1, null))).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      expect(
        await codeOf(
          builder().reset(tenantA, owner, {
            idempotencyKey: key(),
            expectedDraftVersion: 1,
            confirm: true,
          }),
        ),
      ).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      expect(await revisionCount()).toBe(0);
    });

    it('isolates tenants, and serves one published layout to every bot of the tenant', async () => {
      await saveDraft(threeAcross(), null);
      await publish(1, null);
      // Tenant B: untouched, legacy, no draft.
      const viewB = await builder().view(tenantB, ownerB);
      expect(viewB.source).toBe('LEGACY');
      expect(viewB.draft.version).toBeNull();
      expect(await container.mainMenu.rowsFor(tenantB)).toEqual(DEFAULT_ROWS);
      // Tenant B cannot publish A's draft version into its own row.
      expect(await codeOf(publish(1, null, ownerB, tenantB))).toBe(
        CONTROL_ERROR_CODES.VERSION_CONFLICT,
      );
      // Both of A's bots draw A's published layout.
      const forBot = (botInstanceId: string) =>
        container.mainMenu.keyboardFor({ tenantId: tenantA.tenantId, botInstanceId } as never);
      expect(await forBot(SEED_IDS.botA1)).toEqual(await forBot(SEED_IDS.botA2));
      expect((await forBot(SEED_IDS.botA1))[0]).toHaveLength(3);
      // Icon eligibility is per bot, and lists only this tenant's bots.
      await db().execute(
        sql`UPDATE bot_instances SET custom_emoji_tested_at = now(), custom_emoji_test_outcome = 'SENT'
             WHERE id = ${SEED_IDS.botA1}`,
      );
      const view = await builder().view(tenantA, owner);
      expect(
        Object.fromEntries(view.iconEligibility.map((bot) => [bot.botInstanceId, bot.eligible])),
      ).toEqual({ [SEED_IDS.botA1]: true, [SEED_IDS.botA2]: false });
    });

    it('F-4 calls a bot eligible exactly when the runtime decorates it: a tested, refused bot is not', async () => {
      // botA1 proved custom emoji; botA2 was TESTED and refused — a recorded outcome that is
      // not SENT, which a builder answering "has a test" would call eligible.
      for (const [botId, outcome, errorCode] of [
        [SEED_IDS.botA1, 'SENT', null],
        [SEED_IDS.botA2, 'REJECTED', 'appearance.custom_emoji_refused'],
      ] as const) {
        await db().execute(
          sql`UPDATE bot_instances SET custom_emoji_tested_at = now(),
                     custom_emoji_test_outcome = ${outcome},
                     custom_emoji_test_error_code = ${errorCode}
               WHERE id = ${botId}`,
        );
      }
      await db().execute(
        sql`INSERT INTO bot_appearance_slots (id, tenant_id, slot, custom_emoji_id)
            VALUES (gen_random_uuid(), ${tenantA.tenantId}, 'wallet', '5368324170671202286')
            ON CONFLICT (tenant_id, slot) DO UPDATE SET custom_emoji_id = EXCLUDED.custom_emoji_id,
                                                        enabled = true`,
      );
      const view = await builder().view(tenantA, owner);
      const reader = new CachedAppearanceReader(
        new DrizzleAppearanceRepository(db()),
        container.clock,
      );
      for (const bot of view.iconEligibility) {
        const decorated =
          (await reader.decorationFor(tenantA, bot.botInstanceId as BotInstanceId)).customEmoji
            .size > 0;
        expect({ bot: bot.botInstanceId, eligible: bot.eligible }).toEqual({
          bot: bot.botInstanceId,
          eligible: decorated,
        });
      }
      expect(
        Object.fromEntries(view.iconEligibility.map((bot) => [bot.botInstanceId, bot.eligible])),
      ).toEqual({ [SEED_IDS.botA1]: true, [SEED_IDS.botA2]: false });
    });

    it('F-6 refuses a system scope as the pre-round-T read did, never answering the default keyboard', async () => {
      const system = systemContext('round-t-f6');
      // 25e717a read bot.main_menu through settings.find → requireTenantId: fail closed.
      for (const read of [
        () => container.mainMenu.keyboardFor(system),
        () => container.mainMenu.rowsFor(system),
        () => container.mainMenu.describeFor(system),
      ]) {
        expect(await codeOf(read())).toBe(PLATFORM_ERROR_CODES.TENANT_CONTEXT_MISSING);
      }
      // The source itself refuses, rather than handing the evaluator the registry default
      // and leaving the refusal to whichever later read happens to need a tenant.
      const source = new PublishedMainMenuSource(
        new DrizzleMainMenuBuilderRepository(db()),
        container.settingsResolver,
        container.opsLog,
      );
      expect(await codeOf(source.snapshotFor(system))).toBe(
        PLATFORM_ERROR_CODES.TENANT_CONTEXT_MISSING,
      );
    });

    it('reports each button’s gate as the server decides it, never the page', async () => {
      const view = await builder().view(tenantA, owner);
      const byId = Object.fromEntries(view.items.map((item) => [item.id, item]));
      expect(byId.trial).toMatchObject({ gate: 'TRIAL_OFFER', gateOpen: false });
      expect(byId.referral).toMatchObject({ gate: 'FEATURE', gateOpen: false });
      expect(byId.wallet).toMatchObject({ gate: null, gateOpen: null, target: 'wallet' });
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

    it('serves the read, the PUT draft and the publish, and the guard on /settings', async () => {
      const ownerCookie = await cookieFor('owner', 'the-owners-real-password');
      const observerCookie = await cookieFor('observer', 'the-observer-password');
      const read = await inject({
        method: 'GET',
        url: `${API_PREFIX}${BOT_MENU_BUILDER_ROUTES.view}`,
        headers: { cookie: observerCookie, origin: ORIGIN },
      });
      expect(read.statusCode).toBe(200);
      botMenuBuilderResponseSchema.parse(read.json());

      const body = {
        idempotencyKey: key(),
        expectedDraftVersion: null,
        layout: threeAcross(),
        legacyBaselineVersion: null,
      };
      const denied = await inject({
        method: 'PUT',
        url: `${API_PREFIX}${BOT_MENU_BUILDER_ROUTES.draft}`,
        headers: { cookie: observerCookie, origin: ORIGIN },
        payload: body,
      });
      expect(denied.statusCode).toBe(403);
      const saved = await inject({
        method: 'PUT',
        url: `${API_PREFIX}${BOT_MENU_BUILDER_ROUTES.draft}`,
        headers: { cookie: ownerCookie, origin: ORIGIN },
        payload: body,
      });
      expect(saved.statusCode).toBe(200);
      const draft: MainMenuBuilderMutationResponse = mainMenuBuilderMutationResponseSchema.parse(
        saved.json(),
      );
      expect(draft.head.draft.version).toBe(1);
      const published = await inject({
        method: 'POST',
        url: `${API_PREFIX}${BOT_MENU_BUILDER_ROUTES.publish}`,
        headers: { cookie: ownerCookie, origin: ORIGIN },
        payload: {
          idempotencyKey: key(),
          expectedDraftVersion: 1,
          expectedPublishedRevision: null,
        },
      });
      expect([200, 201]).toContain(published.statusCode);
      const [revision] = (await builder().revisions(tenantA, owner, {})).revisions;
      const restored = await inject({
        method: 'POST',
        url: `${API_PREFIX}${BOT_MENU_BUILDER_ROUTES.restore(revision?.id ?? '')}`,
        headers: { cookie: ownerCookie, origin: ORIGIN },
        payload: { idempotencyKey: key(), expectedDraftVersion: 1 },
      });
      expect([200, 201]).toContain(restored.statusCode);
      const page = await inject({
        method: 'GET',
        url: `${API_PREFIX}${BOT_MENU_BUILDER_ROUTES.revisions}?limit=5`,
        headers: { cookie: observerCookie, origin: ORIGIN },
      });
      expect(page.statusCode).toBe(200);

      const settingWrite = await inject({
        method: 'POST',
        url: `${API_PREFIX}${CONTROL_ROUTES.setting('bot.main_menu')}`,
        headers: { cookie: ownerCookie, origin: ORIGIN },
        payload: {
          idempotencyKey: key(),
          value: DEFAULT_MAIN_MENU_LAYOUT,
          expectedVersion: (await settingRow())?.version ?? null,
        },
      });
      expect(settingWrite.statusCode).toBe(409);
      expect(settingWrite.json().error.code).toBe(CONTROL_ERROR_CODES.INVALID_VALUE);
    });
  });
});

/** The builder service with some of its dependencies replaced — the container's for the rest. */
function serviceWith(
  container: Container,
  overrides: Partial<ConstructorParameters<typeof BotMenuBuilderService>[0]>,
): BotMenuBuilderService {
  const db = container.database.db;
  return new BotMenuBuilderService({
    repository: new DrizzleMainMenuBuilderRepository(db),
    guard: container.guard,
    uow: container.uow,
    audit: container.audit,
    outbox: container.outbox,
    opsLog: container.opsLogWriter,
    sessions: container.sessions,
    idempotency: container.idempotency,
    scopeActivity: container.tenants,
    clock: container.clock,
    ids: container.ids,
    settings: container.settingsResolver,
    settingRepository: new DrizzleSettingRepository(db),
    mainMenu: container.mainMenu,
    source: new PublishedMainMenuSource(
      new DrizzleMainMenuBuilderRepository(db),
      container.settingsResolver,
      container.opsLog,
    ),
    templates: container.templateResolver,
    defaultLabel: (templateKey) => label(templateKey),
    bots: new DrizzleAppearanceRepository(db),
    ...overrides,
  });
}
