import type { ScopeContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingChangeGuard } from '../../settings/application/settings.service.js';
import type { MainMenuBuilderRepository } from './ports.js';

/**
 * Round T — once a tenant has PUBLISHED a layout in the button builder, `bot.main_menu` has
 * one writer: the publish, which rewrites it as the compatibility projection in the same
 * transaction (`docs/round-t-button-builder-audit.md` §11.7).
 *
 * A second write path through the generic settings endpoint would make the projection and
 * the published layout disagree — the runtime would then follow the setting and the builder
 * would report its own publish superseded by a page of the same release. So a real change
 * is refused here while a layout is published. A tenant that never published keeps the
 * legacy path, and with it the existing `/bot-buttons` save, until it does (a deliberate
 * narrowing of §11.7: before any publish the setting IS the keyboard, there is nothing for
 * it to disagree with, and refusing it would break the page that ships until round T's web
 * package replaces it). A no-op write and a replay are never asked (`SettingsService`).
 *
 * The builder row is read `FOR UPDATE`, in the settings write's own transaction, so a
 * publish committing between this answer and the write cannot slip through: the publish
 * locks the same row first, and its projection write moves the setting's version, which
 * the settings write's own predicate then refuses.
 */
export class MainMenuSettingGuard implements SettingChangeGuard {
  readonly key = 'bot.main_menu';

  constructor(private readonly repository: Pick<MainMenuBuilderRepository, 'findLayout'>) {}

  async refuseChange(
    scope: ScopeContext,
    _change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    const layout = await this.repository.findLayout(scope, tx, true);
    if (layout === null || layout.publishedRevision === null) return null;
    return 'The main menu is managed by the button builder. Change it there and publish.';
  }
}
