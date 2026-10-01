import {
  BOT_MENU_PUBLISHED_UNREADABLE_CODE,
  explicitMainMenuSchema,
  isSystemContext,
  normalizeExplicitMainMenu,
  type ExplicitMainMenu,
  type OperationalEventRecorder,
  type ScopeContext,
} from '@nexa/contracts';
import type {
  MainMenuSource,
  MainMenuSourceAnswer,
} from '../../../commerce/messaging/application/main-menu.js';
import type { MainMenuBuilderRepository, PublishedMainMenuHead } from './ports.js';

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
 * Round T — the runtime's answer to "what is the customer keyboard drawn from"
 * (`docs/round-t-button-builder-audit.md` §11.5).
 *
 * The PUBLISHED layout, only while the compatibility projection it wrote is still the
 * setting's current version. A draft is never read here. Anything else is the legacy path:
 *
 * - nothing published — today's keyboard, byte for byte;
 * - `bot.main_menu` written behind the publish (an older release during a rollback, the
 *   only writer left once the builder's guard is in place) — the setting is the operator's
 *   latest act, and the builder reports the layout superseded;
 * - a snapshot this release cannot parse (a later release wrote it) — recorded as
 *   `bot_menu.published_unreadable`, deduplicated per tenant, and closed by the next publish.
 */
export class PublishedMainMenuSource implements MainMenuSource {
  constructor(
    private readonly repository: Pick<MainMenuBuilderRepository, 'publishedHead'>,
    private readonly opsLog: OperationalEventRecorder,
  ) {}

  async currentFor(scope: ScopeContext): Promise<MainMenuSourceAnswer> {
    // A system scope draws no customer's keyboard and has no builder row.
    if (isSystemContext(scope)) return legacy(false, false);
    const head = await this.repository.publishedHead(scope);
    if (head === null) return legacy(false, false);
    const reading = readPublishedHead(head);
    if (reading.layout === null) {
      await this.opsLog.record(scope, {
        code: BOT_MENU_PUBLISHED_UNREADABLE_CODE,
        severity: 'WARN',
        message:
          'The published main-menu layout cannot be read by this release; the keyboard follows bot.main_menu.',
        context: { revision: head.publishedRevision },
        dedupeKey: PUBLISHED_UNREADABLE_DEDUPE_KEY,
      });
      return legacy(reading.superseded, true);
    }
    if (reading.superseded) return legacy(true, false);
    return { kind: 'EXPLICIT', layout: reading.layout, revision: head.publishedRevision };
  }
}

function legacy(superseded: boolean, publishedUnreadable: boolean): MainMenuSourceAnswer {
  return { kind: 'LEGACY', superseded, publishedUnreadable };
}
