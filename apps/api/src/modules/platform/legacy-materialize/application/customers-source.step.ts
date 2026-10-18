import { COMMERCE_ERROR_CODES, errors, type TenantContext, type UnitOfWork } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type {
  ExactMatchRow,
  MaterializeContext,
  MaterializeStep,
  MaterializeStepOutcome,
} from './ports.js';

export interface CustomerSourceMarker {
  /**
   * Marks the customers the importer CREATED from Mirza (`legacy_import_map`, an IMPORTED
   * CUSTOMER row that is not `EXISTING_CUSTOMER`) as `source = 'MIRZA'`,
   * `source_ref = 'user:<telegram id>'`. A customer NEXA already had stays `NEXA`: it was
   * matched, not imported. Returns how many rows this call marked and how many already were.
   */
  markImported(
    scope: TenantContext,
    tx: TransactionScope,
  ): Promise<{ readonly marked: number; readonly alreadyMarked: number }>;
}

/**
 * The first MATERIALIZE step: the customers the import created say so on their own row, so
 * the normal customer list can badge and filter them. It writes provenance only — no status,
 * no profile, no money — and the importer's map stays the record of what was decided.
 */
export class CustomerSourceStep implements MaterializeStep {
  readonly name = 'customers';

  constructor(
    private readonly deps: {
      readonly marker: CustomerSourceMarker;
      readonly uow: UnitOfWork<TransactionScope>;
      readonly scopeActivity: ScopeActivityReader;
    },
  ) {}

  async apply(ctx: MaterializeContext): Promise<MaterializeStepOutcome> {
    const { marked, alreadyMarked } = await this.deps.uow.run(ctx.scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(ctx.scope, tx))) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'This installation has stopped accepting work.',
        );
      }
      return this.deps.marker.markImported(ctx.scope, tx);
    });
    return {
      step: this.name,
      written: marked,
      alreadyPresent: alreadyMarked,
      diverged: 0,
      skipped: {},
    };
  }

  /** The customers row is the importer's own (`usersRow`): nothing to add here. */
  match(): Promise<readonly ExactMatchRow[]> {
    return Promise.resolve([]);
  }
}
