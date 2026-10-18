import type {
  LegacyBotLinkReport,
  LegacyExactMatchRow,
  LegacyMaterializeOutcome,
} from '@nexa/contracts';
import type {
  BotLinkPort,
  MaterializePort,
  MigrationStepContext,
} from '../../legacy-migration/application/ports.js';
import { LegacyMigrationStepFailure } from '../../legacy-migration/application/ports.js';
import type { CustomerBotLinkService } from '../../../commerce/customers/application/customer-bot-link.service.js';
import { exactMatchReport } from '../application/exact-match.js';
import type { LegacyMaterializeService } from '../application/materialize.service.js';
import type { MaterializeContext } from '../application/ports.js';

/** The executor's MATERIALIZE port over the steps (`LegacyMaterializeService`). */
export class LegacyMaterializePort implements MaterializePort {
  constructor(
    private readonly service: LegacyMaterializeService,
    private readonly now: () => Date,
  ) {}

  private context(step: MigrationStepContext): MaterializeContext {
    // Verification records both; before it there is no archive. The archive is keyed by THIS
    // import's row (`legacy_nxpkg_imports.id`), never by the package's own manifest id.
    if (step.packageImportId === null || step.sourceFingerprint === null) {
      // Unreachable after a verified package: verification records both.
      throw new LegacyMigrationStepFailure(
        'IMPORT_FAILED',
        'The package was not verified: there is no archive to materialize.',
      );
    }
    return {
      scope: step.scope,
      actor: step.actor,
      packageImportId: step.importId,
      sourceFingerprint: step.sourceFingerprint,
      now: this.now(),
    };
  }

  apply(step: MigrationStepContext): Promise<readonly LegacyMaterializeOutcome[]> {
    return this.service.apply(this.context(step));
  }

  async match(step: MigrationStepContext): Promise<readonly LegacyExactMatchRow[]> {
    return exactMatchReport(await this.service.match(this.context(step))).rows;
  }
}

/** The executor's BOT_LINK port: `CustomerBotLinkService.autoLinkImported`. */
export class LegacyBotLinkPort implements BotLinkPort {
  constructor(private readonly links: Pick<CustomerBotLinkService, 'autoLinkImported'>) {}

  async link(step: MigrationStepContext): Promise<LegacyBotLinkReport> {
    const r = await this.links.autoLinkImported(step.scope, step.actor);
    return {
      outcome: r.outcome,
      botInstanceId: r.botInstanceId,
      eligible: r.eligible,
      linked: r.linked,
    };
  }
}
