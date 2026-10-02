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
 * What serialises a settings write against a racing publish is the SETTING's own version
 * predicate, not this read: both write `setting_values` under `version = expected` (a
 * first write, under the row's unique key), the publish's projection write moves that
 * version, and at READ COMMITTED the loser's predicate is re-evaluated after the winner
 * commits and matches nothing — so a settings write that this guard answered before a
 * publish committed is refused as a version conflict, never applied over the projection.
 * The builder row is ALSO read `FOR UPDATE` in the settings write's transaction; that lock
 * is defence in depth (it orders this read behind a publish holding the row), and nothing
 * above depends on it — the T4 review's M07 (the read without the lock) changes no outcome
 * (`docs/round-t-final-review.md`, F-5).
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
