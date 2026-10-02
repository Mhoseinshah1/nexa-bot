import {
  BOT_MENU_PUBLISHED_UNREADABLE_CODE,
  explicitMainMenuSchema,
  normalizeExplicitMainMenu,
  type ExplicitMainMenu,
  type MainMenuLayoutEntry,
  type OperationalEventRecorder,
  type ScopeContext,
} from '@nexa/contracts';
import type {
  MainMenuSnapshot,
  MainMenuSource,
  MainMenuSourceAnswer,
} from '../../../commerce/messaging/application/main-menu.js';
import type {
  ResolvedSetting,
  SettingsResolver,
} from '../../settings/application/settings-resolver.js';
import type {
  MainMenuBuilderRepository,
  MainMenuStateRead,
  PublishedMainMenuHead,
} from './ports.js';

/**
 * The dedupe key of a tenant's "published layout unreadable" condition. Operational events
 * are already tenant-scoped, so the key names the subject — the published head — not the
 * tenant.
 */
export const PUBLISHED_UNREADABLE_DEDUPE_KEY = `${BOT_MENU_PUBLISHED_UNREADABLE_CODE}:published`;

/** What a published head means, decided in one place for the runtime and the builder read. */
export interface PublishedHeadReading {
  /** The layout, when it parses. */
  readonly layout: ExplicitMainMenu | null;
  /** `bot.main_menu` was written after this publish (by an older release). */
  readonly superseded: boolean;
}

export function readPublishedHead(head: PublishedMainMenuHead): PublishedHeadReading {
  const parsed = explicitMainMenuSchema.safeParse(head.published);
  return {
    layout: parsed.success ? normalizeExplicitMainMenu(parsed.data) : null,
    superseded: head.settingVersion !== head.projectionSettingVersion,
  };
}

/**
 * Round T — the ONE selection of what the customer keyboard is drawn from
 * (`docs/round-t-button-builder-audit.md` §11.5), shared by the runtime and the builder's
 * read.
 *
 * Decided from ONE statement (`readMenuState`: the builder row and the `bot.main_menu` row
 * together), so the head, the projection version, the setting version and the legacy value
 * all come from the same commit. The PUBLISHED layout, only while the projection it wrote is
 * still the setting's current version; a draft is never read. Anything else is the legacy
 * path over that same setting value:
 *
 * - nothing published — today's keyboard, byte for byte;
 * - `bot.main_menu` written behind the publish (an older release during a rollback) — the
 *   setting is the operator's latest act, and the builder reports the layout superseded;
 * - a snapshot this release cannot parse (a later release wrote it) — recorded as
 *   `bot_menu.published_unreadable`, deduplicated per tenant, and closed by the next publish.
 *
 * The setting row is resolved by the settings resolver's own rule (`resolveStored`: the same
 * parse, the same default, the same invalid-value event), never a second copy of it.
 */
export class PublishedMainMenuSource implements MainMenuSource {
  constructor(
    private readonly repository: Pick<MainMenuBuilderRepository, 'readMenuState'>,
    private readonly settings: Pick<SettingsResolver, 'resolveStored'>,
    private readonly opsLog: OperationalEventRecorder,
  ) {}

  /**
   * A system scope is refused with `TENANT_CONTEXT_MISSING` by the state read
   * (`requireTenantId`), exactly as the pre-round-T settings read refused it: a keyboard
   * belongs to a tenant, and answering the registry default for no tenant would fail open.
   */
  async snapshotFor(scope: ScopeContext): Promise<MainMenuSnapshot> {
    return (await this.fromState(scope, await this.repository.readMenuState(scope))).snapshot;
  }

  /**
   * The snapshot a state read means — what the builder's read calls with the SAME state it
   * builds its draft and heads from, so its `source`, `superseded` and `live` are the
   * runtime's answer for that state.
   */
  async fromState(
    scope: ScopeContext,
    state: MainMenuStateRead,
  ): Promise<{ readonly snapshot: MainMenuSnapshot; readonly setting: ResolvedSetting }> {
    const setting = await this.settings.resolveStored(scope, 'bot.main_menu', state.setting);
    const layout = state.layout;
    const head =
      layout === null ||
      layout.published === null ||
      layout.publishedRevision === null ||
      layout.projectionSettingVersion === null
        ? null
        : {
            published: layout.published,
            publishedRevision: layout.publishedRevision,
            projectionSettingVersion: layout.projectionSettingVersion,
            settingVersion: state.setting?.version ?? null,
          };
    const answer = sourceAnswerOf(head);
    if (head !== null && answer.kind === 'LEGACY' && answer.publishedUnreadable) {
      await this.opsLog.record(scope, {
        code: BOT_MENU_PUBLISHED_UNREADABLE_CODE,
        severity: 'WARN',
        message:
          'The published main-menu layout cannot be read by this release; the keyboard follows bot.main_menu.',
        context: { revision: head.publishedRevision },
        dedupeKey: PUBLISHED_UNREADABLE_DEDUPE_KEY,
      });
    }
    return {
      snapshot: { source: answer, legacy: setting.value as readonly MainMenuLayoutEntry[] },
      setting,
    };
  }
}

/**
 * THE decision of what a published head means for the keyboard, over a head and setting
 * version read together.
 */
export function sourceAnswerOf(head: PublishedMainMenuHead | null): MainMenuSourceAnswer {
  if (head === null) return legacy(false, false);
  const reading = readPublishedHead(head);
  if (reading.layout === null) return legacy(reading.superseded, true);
  if (reading.superseded) return legacy(true, false);
  return { kind: 'EXPLICIT', layout: reading.layout, revision: head.publishedRevision };
}

function legacy(superseded: boolean, publishedUnreadable: boolean): MainMenuSourceAnswer {
  return { kind: 'LEGACY', superseded, publishedUnreadable };
}
