import {
  EMPTY_PRODUCT_DISPLAY,
  LEGACY_PRODUCT_REVIEW_ATTENTION_STATES,
  LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS,
  LEGACY_PRODUCT_REVIEW_DECIDABLE_STATES,
  LEGACY_PRODUCT_REVIEW_DECIDED_STATES,
  LEGACY_PRODUCT_REVIEW_ERROR_CODES,
  LEGACY_PRODUCT_REVIEW_PAGE_MAX,
  errors,
  legacyProductApproveExistingRequestSchema,
  legacyProductApproveNewRequestSchema,
  legacyProductRejectRequestSchema,
  legacyProductReopenRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type LegacyProductReviewListQuery,
  type LegacyProductReviewState,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ProductService } from '../../catalog/application/product.service.js';
import type { ProductDraft } from '../../catalog/application/ports.js';
import {
  legacyProductFactsChecksum,
  parseLegacyProduct,
  type LegacyProductFactRow,
} from '../domain/legacy-product-facts.js';
import {
  decideAbsence,
  decideIngest,
  isExportable,
  type ReadObservation,
} from '../domain/review-transitions.js';
import type {
  LegacyProductReviewChange,
  LegacyProductReviewListItem,
  LegacyProductReviewRecord,
  LegacyProductReviewRepository,
  LegacyProductReviewSourceFields,
} from './ports.js';

export const LEGACY_PRODUCTS_VIEW_PERMISSION = 'legacy.products.view' satisfies PermissionKey;
export const LEGACY_PRODUCTS_DECIDE_PERMISSION = 'legacy.products.decide' satisfies PermissionKey;
/** The CLI ingest and export: SYSTEM_JOB work, charged like every importer write. */
export const LEGACY_PRODUCTS_INGEST_PERMISSION = 'maintenance.run' satisfies PermissionKey;

const ENTITY = 'LegacyProductReview';

export interface LegacyProductReviewServiceDeps {
  readonly repository: LegacyProductReviewRepository;
  /** Approve-as-new creates its draft through the ONE product write path. */
  readonly products: Pick<ProductService, 'createWithin' | 'authorizeCreate'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The read a batch belongs to: the products read set fingerprint and the v1 source it was bound to. */
export interface LegacyProductRead {
  readonly readSetFingerprint: string;
  readonly sourceFingerprint: string;
}

/** One code as a read saw it: every legacy row naming it, and its live invoice count. */
export interface LegacyProductCodeObservation {
  readonly code: string;
  readonly rows: readonly LegacyProductFactRow[];
  readonly liveInvoiceCount: number;
}

export interface LegacyProductIngestCounts {
  created: number;
  unchanged: number;
  touched: number;
  reappeared: number;
  factsUpdated: number;
  sourceChanged: number;
  markedMissing: number;
  /** Absent in an earlier read and still absent: the mark moved to this read. */
  stillAbsent: number;
}

export function emptyIngestCounts(): LegacyProductIngestCounts {
  return {
    created: 0,
    unchanged: 0,
    touched: 0,
    reappeared: 0,
    factsUpdated: 0,
    sourceChanged: 0,
    markedMissing: 0,
    stillAbsent: 0,
  };
}

/** One entry of the importer panel map's `products` section. */
export interface LegacyProductMapEntry {
  readonly codeProduct: string;
  readonly productId: string;
}

export interface LegacyProductExport {
  readonly readSetFingerprint: string;
  /** Sorted by code: exactly what goes into the panel map's `products`. */
  readonly products: readonly LegacyProductMapEntry[];
  /** Every other row, by state, so the operator sees what is NOT exported and why. */
  readonly notExported: Readonly<Record<string, number>>;
}

/**
 * Mirza migration PR2 — the legacy product review (`docs/legacy-product-review-design.md`).
 *
 * Three kinds of caller, three permissions:
 *
 * - the CLI ingest (`legacy-import products-read`, SYSTEM_JOB, `maintenance.run`) writes what
 *   an APPROVED products read saw: new codes as PENDING_REVIEW, changed facts on a decided
 *   row as SOURCE_CHANGED, a vanished code as missing (and SOURCE_CHANGED when decided).
 *   Idempotent by content: re-reading the same source writes nothing;
 * - the Web Admin reads (`legacy.products.view`);
 * - an operator's decision (`legacy.products.decide`; approve-as-new also `catalog.edit`):
 *   approve to an existing product, approve as a new DRAFT product, reject, reopen. Each
 *   takes an idempotency key, binds to the facts checksum the operator saw, is ONE
 *   conditional UPDATE naming its from-states inside a transaction that re-checks the
 *   permission and the scope's activity, and is audited (DENIED too).
 *
 * Nothing here prices, lists, activates or categorises anything, and nothing contacts a
 * provider. The historical price is copied into no product: the draft's price is `null`.
 */
export class LegacyProductReviewService {
  constructor(private readonly deps: LegacyProductReviewServiceDeps) {}

  // --- reads -----------------------------------------------------------------------------

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: LegacyProductReviewListQuery,
  ): Promise<{
    readonly items: readonly LegacyProductReviewListItem[];
    readonly nextCursor: string | null;
  }> {
    await this.deps.guard.check(scope, actor, LEGACY_PRODUCTS_VIEW_PERMISSION);
    const limit = query.limit ?? LEGACY_PRODUCT_REVIEW_PAGE_MAX;
    const states: readonly LegacyProductReviewState[] | undefined =
      query.state !== undefined
        ? [query.state]
        : query.attention === 'true'
          ? LEGACY_PRODUCT_REVIEW_ATTENTION_STATES
          : undefined;
    const rows = await this.deps.repository.list(scope, {
      ...(states === undefined ? {} : { states }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.after === undefined ? {} : { after: query.after }),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: rows.length > limit && last !== undefined ? last.review.codeProduct : null,
    };
  }

  async get(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<LegacyProductReviewListItem> {
    await this.deps.guard.check(scope, actor, LEGACY_PRODUCTS_VIEW_PERMISSION);
    return this.itemOf(scope, await this.require(scope, id));
  }

  /** Whether a row exports under its own read fingerprint (for the view). */
  exportable(record: LegacyProductReviewRecord): boolean {
    return isExportable(record, record.readFingerprint);
  }

  // --- the CLI ingest (SYSTEM_JOB, maintenance.run) ---------------------------------------

  /**
   * Writes one batch of codes an APPROVED products read saw, in ONE transaction. The caller
   * has already compared the read's fingerprint with its approval; nothing here reads the
   * legacy source.
   */
  async ingestBatch(
    scope: TenantContext,
    actor: ActorContext,
    read: LegacyProductRead,
    codes: readonly LegacyProductCodeObservation[],
  ): Promise<LegacyProductIngestCounts> {
    const counts = emptyIngestCounts();
    if (codes.length === 0) return counts;
    await this.ingestMutation(scope, actor, read.readSetFingerprint, async (tx, now) => {
      for (const observation of codes) {
        await this.ingestOne(scope, actor, read, observation, now, counts, tx);
      }
    });
    return counts;
  }

  /**
   * After a COMPLETE read: every row that read did not see is marked missing, and a decided
   * one moves to SOURCE_CHANGED. Called only once every batch of the read has committed.
   */
  async markAbsent(
    scope: TenantContext,
    actor: ActorContext,
    read: LegacyProductRead,
  ): Promise<LegacyProductIngestCounts> {
    const counts = emptyIngestCounts();
    for (;;) {
      const absent = await this.deps.repository.absentFrom(scope, read.readSetFingerprint, 200);
      if (absent.length === 0) return counts;
      await this.ingestMutation(scope, actor, read.readSetFingerprint, async (tx, now) => {
        for (const candidate of absent) {
          const row = await this.deps.repository.findById(scope, candidate.id, tx, {
            forUpdate: true,
          });
          if (row === null || row.readFingerprint === read.readSetFingerprint) continue;
          const decision = decideAbsence(row, read.readSetFingerprint);
          if (decision.kind === 'NONE') continue;
          const change: LegacyProductReviewChange =
            decision.kind === 'SOURCE_CHANGED'
              ? {
                  state: 'SOURCE_CHANGED',
                  priorState: decision.prior,
                  missingSinceReadFingerprint: read.readSetFingerprint,
                  updatedAt: now,
                }
              : { missingSinceReadFingerprint: read.readSetFingerprint, updatedAt: now };
          const after = await this.deps.repository.update(
            scope,
            row.id,
            { from: [row.state], version: row.version },
            change,
            tx,
          );
          if (after === null) throw new Error('a locked review row moved');
          if (decision.kind === 'STILL_ABSENT') counts.stillAbsent += 1;
          else counts.markedMissing += 1;
          if (decision.kind === 'SOURCE_CHANGED') counts.sourceChanged += 1;
          await this.auditRow(
            scope,
            actor,
            decision.kind === 'SOURCE_CHANGED'
              ? LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.sourceChanged
              : LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.read,
            row,
            after,
            { absentFromRead: read.readSetFingerprint },
            tx,
          );
        }
      });
    }
  }

  /**
   * The `products` section of the importer's panel map, from rows approved against the facts
   * THIS read (`readSetFingerprint`) saw. Refuses unless the review reflects that read: every
   * row was either seen by it or marked absent by it. Read-only.
   */
  async exportMapping(
    scope: TenantContext,
    actor: ActorContext,
    readSetFingerprint: string,
  ): Promise<LegacyProductExport> {
    await this.deps.guard.check(scope, actor, LEGACY_PRODUCTS_INGEST_PERMISSION);
    const rows = await this.deps.repository.all(scope);
    const stale = rows.filter(
      (row) =>
        row.readFingerprint !== readSetFingerprint &&
        row.missingSinceReadFingerprint !== readSetFingerprint,
    );
    if (rows.length === 0 || stale.length > 0) {
      throw errors.conflict(
        LEGACY_PRODUCT_REVIEW_ERROR_CODES.NOT_IN_STATE,
        rows.length === 0
          ? 'There are no legacy product review rows for this tenant: run products-read first.'
          : `${String(stale.length)} review row(s) were last written by another products read than ` +
              `${readSetFingerprint}: the review does not reflect the approved read. Run products-read ` +
              'with that approval first. Nothing was exported.',
      );
    }
    const products: LegacyProductMapEntry[] = [];
    const notExported: Record<string, number> = {};
    for (const row of rows) {
      if (isExportable(row, readSetFingerprint) && row.approvedProductId !== null) {
        products.push({ codeProduct: row.codeProduct, productId: row.approvedProductId });
      } else {
        const why =
          row.missingSinceReadFingerprint !== null
            ? 'ABSENT_FROM_READ'
            : row.sourceConflict !== null
              ? 'SOURCE_CONFLICT'
              : row.state;
        notExported[why] = (notExported[why] ?? 0) + 1;
      }
    }
    products.sort((a, b) =>
      a.codeProduct < b.codeProduct ? -1 : a.codeProduct > b.codeProduct ? 1 : 0,
    );
    return { readSetFingerprint, products, notExported };
  }

  /** Every code the review has a row for (`products-export --panel-map`'s consistency check). */
  async reviewedCodes(scope: TenantContext, actor: ActorContext): Promise<ReadonlySet<string>> {
    await this.deps.guard.check(scope, actor, LEGACY_PRODUCTS_INGEST_PERMISSION);
    return new Set((await this.deps.repository.all(scope)).map((row) => row.codeProduct));
  }

  // --- decisions (legacy.products.decide) --------------------------------------------------

  async approveExisting(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyProductReviewListItem> {
    const command = legacyProductApproveExistingRequestSchema.parse(body);
    return this.decide(scope, actor, id, {
      action: LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.approveExisting,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      catalogEdit: false,
      apply: async (before, tx, now) => {
        assertApprovable(before, command.expectedFactsChecksum, command.expectedVersion);
        if (!(await this.deps.repository.productExists(scope, command.productId, tx))) {
          throw errors.notFound(
            LEGACY_PRODUCT_REVIEW_ERROR_CODES.PRODUCT_NOT_FOUND,
            'No such product in this installation.',
          );
        }
        return this.transition(
          scope,
          before,
          command.expectedFactsChecksum,
          {
            state: 'APPROVED_EXISTING',
            priorState: null,
            approvedProductId: command.productId,
            approvedFactsChecksum: before.factsChecksum,
            decisionReason: command.reason,
            decidedByAdminId: adminIdOf(actor),
            decidedAt: now,
            updatedAt: now,
          },
          tx,
        );
      },
    });
  }

  /**
   * Creates a DRAFT product from the review — INACTIVE (the repository's only create state),
   * HIDDEN, no category, no panel, NO PRICE — and maps the code to it, in one transaction.
   * The draft is unorderable by every rule (`unorderableReason`: NOT_PURCHASABLE first),
   * including by direct reference. Pricing, a panel and activation are the operator's later,
   * ordinary product edits; the historical price is never copied.
   */
  async approveNew(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyProductReviewListItem> {
    const command = legacyProductApproveNewRequestSchema.parse(body);
    return this.decide(scope, actor, id, {
      action: LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.approveNew,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      catalogEdit: true,
      apply: async (before, tx, now) => {
        assertApprovable(before, command.expectedFactsChecksum, command.expectedVersion);
        const draft = legacyDraftProduct({
          title: command.title,
          durationDays: command.durationDays,
          trafficBytes: BigInt(command.trafficBytes),
        });
        const created = await this.deps.products.createWithin(scope, actor, draft, tx);
        return this.transition(
          scope,
          before,
          command.expectedFactsChecksum,
          {
            state: 'APPROVED_NEW',
            priorState: null,
            approvedProductId: created.id,
            approvedFactsChecksum: before.factsChecksum,
            decisionReason: command.reason,
            decidedByAdminId: adminIdOf(actor),
            decidedAt: now,
            updatedAt: now,
          },
          tx,
        );
      },
    });
  }

  async reject(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyProductReviewListItem> {
    const command = legacyProductRejectRequestSchema.parse(body);
    return this.decide(scope, actor, id, {
      action: LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.reject,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      catalogEdit: false,
      apply: async (before, tx, now) => {
        assertDecidable(before, command.expectedFactsChecksum, command.expectedVersion);
        return this.transition(
          scope,
          before,
          command.expectedFactsChecksum,
          {
            state: 'REJECTED',
            priorState: null,
            approvedProductId: null,
            approvedFactsChecksum: null,
            decisionReason: command.reason,
            decidedByAdminId: adminIdOf(actor),
            decidedAt: now,
            updatedAt: now,
          },
          tx,
        );
      },
    });
  }

  /** A decided row back to PENDING_REVIEW. A draft product created for it is left as it is. */
  async reopen(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyProductReviewListItem> {
    const command = legacyProductReopenRequestSchema.parse(body);
    return this.decide(scope, actor, id, {
      action: LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.reopen,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      catalogEdit: false,
      apply: async (before, tx, now) => {
        if (!(LEGACY_PRODUCT_REVIEW_DECIDED_STATES as readonly string[]).includes(before.state)) {
          throw notInState(before.state);
        }
        assertVersion(before, command.expectedVersion);
        const after = await this.deps.repository.update(
          scope,
          before.id,
          { from: LEGACY_PRODUCT_REVIEW_DECIDED_STATES, version: before.version },
          {
            state: 'PENDING_REVIEW',
            priorState: null,
            approvedProductId: null,
            approvedFactsChecksum: null,
            decisionReason: command.reason,
            decidedByAdminId: adminIdOf(actor),
            decidedAt: now,
            updatedAt: now,
          },
          tx,
        );
        if (after === null) throw await this.moved(scope, before.id, tx);
        return after;
      },
    });
  }

  // --- internals ---------------------------------------------------------------------------

  private async ingestOne(
    scope: TenantContext,
    actor: ActorContext,
    read: LegacyProductRead,
    observation: LegacyProductCodeObservation,
    now: Date,
    counts: LegacyProductIngestCounts,
    tx: TransactionScope,
  ): Promise<void> {
    const source = sourceFieldsOf(read, observation);
    const seen: ReadObservation = {
      factsChecksum: source.factsChecksum,
      readFingerprint: read.readSetFingerprint,
      sourceFingerprint: read.sourceFingerprint,
      liveInvoiceCount: observation.liveInvoiceCount,
    };
    const existing = await this.deps.repository.findByCode(scope, observation.code, tx, {
      forUpdate: true,
    });
    const decision = decideIngest(existing, seen);
    if (decision.kind === 'CREATE') {
      const created = await this.deps.repository.insert(
        scope,
        {
          id: this.deps.ids.uuid(),
          codeProduct: observation.code,
          ...source,
          state: 'PENDING_REVIEW',
          priorState: null,
          approvedProductId: null,
          approvedFactsChecksum: null,
          decisionReason: null,
          decidedByAdminId: null,
          decidedAt: null,
          missingSinceReadFingerprint: null,
          createdAt: now,
          updatedAt: now,
        },
        tx,
      );
      // A concurrent writer of the same code is refused by the importer's per-tenant claim;
      // were it not, the unique key turns the race into a refusal, never a second row.
      if (created === null) throw new Error(`review row ${observation.code} appeared concurrently`);
      counts.created += 1;
      await this.auditRow(
        scope,
        actor,
        LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.read,
        null,
        created,
        { read: read.readSetFingerprint },
        tx,
      );
      return;
    }
    if (existing === null) throw new Error('unreachable: an ingest decision without a row');
    if (decision.kind === 'UNCHANGED') {
      counts.unchanged += 1;
      return;
    }
    const change: LegacyProductReviewChange =
      decision.kind === 'TOUCH'
        ? {
            readFingerprint: read.readSetFingerprint,
            sourceFingerprint: read.sourceFingerprint,
            liveInvoiceCount: observation.liveInvoiceCount,
            missingSinceReadFingerprint: null,
            updatedAt: now,
          }
        : decision.kind === 'FACTS_UPDATED'
          ? { ...source, missingSinceReadFingerprint: null, updatedAt: now }
          : {
              ...source,
              state: 'SOURCE_CHANGED',
              priorState: decision.prior,
              missingSinceReadFingerprint: null,
              updatedAt: now,
            };
    const after = await this.deps.repository.update(
      scope,
      existing.id,
      { from: [existing.state], version: existing.version },
      change,
      tx,
    );
    if (after === null) throw new Error('a locked review row moved');
    if (decision.kind === 'TOUCH') {
      counts.touched += 1;
      if (!decision.reappeared) return;
      counts.reappeared += 1;
    } else if (decision.kind === 'FACTS_UPDATED') {
      counts.factsUpdated += 1;
    } else {
      counts.sourceChanged += 1;
    }
    await this.auditRow(
      scope,
      actor,
      decision.kind === 'SOURCE_CHANGED'
        ? LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.sourceChanged
        : LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.read,
      existing,
      after,
      { read: read.readSetFingerprint, decision: decision.kind },
      tx,
    );
  }

  /** The ingest's transaction: `maintenance.run`, re-checked inside, scope activity read inside. */
  private ingestMutation(
    scope: TenantContext,
    actor: ActorContext,
    readSetFingerprint: string,
    fn: (tx: TransactionScope, now: Date) => Promise<void>,
  ): Promise<void> {
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_PRODUCTS_INGEST_PERMISSION,
      {
        action: LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS.read,
        entityType: 'LegacyProductReviewRead',
        entityId: readSetFingerprint,
      },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await fn(tx, this.deps.clock.now());
      },
    );
  }

  /**
   * The decision write path, once: the early permission checks (each refusal audited), the
   * replay, then ONE transaction that re-checks session and permission, reads scope
   * activity, locks the row, applies, audits and remembers.
   */
  private async decide(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    spec: {
      readonly action: string;
      readonly idempotencyKey: string;
      readonly request: Record<string, unknown>;
      readonly catalogEdit: boolean;
      readonly apply: (
        before: LegacyProductReviewRecord,
        tx: TransactionScope,
        now: Date,
      ) => Promise<LegacyProductReviewRecord>;
    },
  ): Promise<LegacyProductReviewListItem> {
    const denial = { action: spec.action, entityType: ENTITY, entityId: id };
    try {
      await this.deps.guard.check(scope, actor, LEGACY_PRODUCTS_DECIDE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_PRODUCTS_DECIDE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    // Approve-as-new creates a product: `catalog.edit` too, refused (and audited) up front.
    if (spec.catalogEdit) await this.deps.products.authorizeCreate(scope, actor);

    const requestHash = hashRequest({ action: spec.action, reviewId: id, ...spec.request });
    const found = await this.deps.idempotency.find<{ readonly id: string }>(
      scope,
      actor.surface,
      spec.idempotencyKey,
      requestHash,
    );
    if (found !== null) {
      const replayed = await this.deps.repository.findById(scope, found.result.id);
      if (replayed !== null) return this.itemOf(scope, replayed);
    }

    const after = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_PRODUCTS_DECIDE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const before = await this.deps.repository.findById(scope, id, tx, { forUpdate: true });
        if (before === null) throw notFound();
        const decided = await spec.apply(before, tx, now);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: spec.action,
            entityType: ENTITY,
            entityId: id,
            before: decisionView(before),
            after: decisionView(decided),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          spec.idempotencyKey,
          requestHash,
          { id: decided.id },
          tx,
        );
        return decided;
      },
    );
    return this.itemOf(scope, after);
  }

  /** A decision: from PENDING_REVIEW or SOURCE_CHANGED, bound to the facts the operator saw. */
  private async transition(
    scope: TenantContext,
    before: LegacyProductReviewRecord,
    expectedFactsChecksum: string,
    change: LegacyProductReviewChange,
    tx: TransactionScope,
  ): Promise<LegacyProductReviewRecord> {
    const after = await this.deps.repository.update(
      scope,
      before.id,
      {
        from: LEGACY_PRODUCT_REVIEW_DECIDABLE_STATES,
        version: before.version,
        factsChecksum: expectedFactsChecksum,
      },
      change,
      tx,
    );
    if (after === null) throw await this.moved(scope, before.id, tx);
    return after;
  }

  private async moved(scope: TenantContext, id: string, tx: TransactionScope): Promise<Error> {
    const now = await this.deps.repository.findById(scope, id, tx);
    if (now === null) return notFound();
    return notInState(now.state);
  }

  private async auditRow(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    before: LegacyProductReviewRecord | null,
    after: LegacyProductReviewRecord,
    extra: Record<string, unknown>,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action,
        entityType: ENTITY,
        entityId: after.id,
        before: before === null ? null : sourceView(before),
        after: { ...sourceView(after), ...extra },
        result: 'SUCCESS',
      },
      tx,
    );
  }

  private async itemOf(
    scope: TenantContext,
    record: LegacyProductReviewRecord,
  ): Promise<LegacyProductReviewListItem> {
    return (
      (await this.deps.repository.findItem(scope, record.id)) ?? {
        review: record,
        approvedProductTitle: null,
      }
    );
  }

  private async require(scope: TenantContext, id: string): Promise<LegacyProductReviewRecord> {
    const found = await this.deps.repository.findById(scope, id);
    if (found === null) throw notFound();
    return found;
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        LEGACY_PRODUCT_REVIEW_ERROR_CODES.SCOPE_STOPPED,
        'This installation has stopped accepting work.',
      );
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/**
 * The draft an approve-as-new creates. Every field that could make it sellable is fixed
 * here and nowhere else: HIDDEN, no category, no panel, NO PRICE (and the repository writes
 * it INACTIVE). Exported so a test pins it.
 */
export function legacyDraftProduct(input: {
  readonly title: string;
  readonly durationDays: number;
  readonly trafficBytes: bigint;
}): ProductDraft {
  return {
    title: input.title,
    description: null,
    audience: 'HIDDEN',
    sortOrder: 0,
    panelId: null,
    categoryId: null,
    specification: {
      durationDays: input.durationDays,
      trafficBytes: input.trafficBytes,
      deviceLimit: null,
    },
    price: null,
    display: EMPTY_PRODUCT_DISPLAY,
  };
}

/** The source-derived columns of one observed code. */
function sourceFieldsOf(
  read: LegacyProductRead,
  observation: LegacyProductCodeObservation,
): LegacyProductReviewSourceFields {
  const parsed = parseLegacyProduct(observation.rows);
  const first = observation.rows[0];
  return {
    legacyProductId: first?.['id'] ?? '',
    facts: observation.rows,
    factsChecksum: legacyProductFactsChecksum(observation.rows),
    sourceConflict: parsed.sourceConflict,
    title: parsed.title,
    trafficBytes: parsed.trafficBytes,
    durationDays: parsed.durationDays,
    historicalPriceRaw: parsed.historicalPriceRaw,
    historicalPriceMinor: parsed.historicalPrice?.amountMinor ?? null,
    historicalPriceCurrency: parsed.historicalPrice?.currency ?? null,
    parseNotes: parsed.parseNotes,
    liveInvoiceCount: observation.liveInvoiceCount,
    readFingerprint: read.readSetFingerprint,
    sourceFingerprint: read.sourceFingerprint,
  };
}

/**
 * The row is at the version the operator saw. The facts checksum alone does not say so: a
 * reopen and a new decision on UNCHANGED facts leave the checksum as it was, and a stale
 * decision or reopen would then overwrite the newer one (Codex review of #231).
 */
function assertVersion(row: LegacyProductReviewRecord, expectedVersion: number): void {
  if (row.version !== expectedVersion) {
    throw errors.conflict(
      LEGACY_PRODUCT_REVIEW_ERROR_CODES.VERSION_CONFLICT,
      'This legacy product changed since you opened it. Reload it and decide again.',
      { version: row.version },
    );
  }
}

function assertDecidable(
  row: LegacyProductReviewRecord,
  expectedFactsChecksum: string,
  expectedVersion: number,
): void {
  if (!(LEGACY_PRODUCT_REVIEW_DECIDABLE_STATES as readonly string[]).includes(row.state)) {
    throw notInState(row.state);
  }
  if (row.factsChecksum !== expectedFactsChecksum) {
    throw errors.conflict(
      LEGACY_PRODUCT_REVIEW_ERROR_CODES.FACTS_CHANGED,
      'The legacy facts of this product changed since you opened it. Review them again.',
    );
  }
  assertVersion(row, expectedVersion);
}

/** A decision that MAPS the code: the source must be one clean row, present in the latest read. */
function assertApprovable(
  row: LegacyProductReviewRecord,
  expectedFactsChecksum: string,
  expectedVersion: number,
): void {
  assertDecidable(row, expectedFactsChecksum, expectedVersion);
  if (row.missingSinceReadFingerprint !== null) {
    throw errors.conflict(
      LEGACY_PRODUCT_REVIEW_ERROR_CODES.SOURCE_ABSENT,
      'The latest legacy read no longer has this product code; it can only be rejected.',
    );
  }
  if (row.sourceConflict !== null) {
    throw errors.conflict(
      LEGACY_PRODUCT_REVIEW_ERROR_CODES.SOURCE_CONFLICT,
      'More than one legacy row has this product code; it can only be rejected.',
    );
  }
}

function adminIdOf(actor: ActorContext): string {
  // The guard decides WHO may decide; this only names them. A SYSTEM_JOB holds no decide
  // permission, and the decider column is an admin of this tenant (composite foreign key).
  if (actor.id === null) {
    throw errors.permissionDenied('platform.permission_denied', 'Only an administrator decides.');
  }
  return actor.id;
}

function notFound(): Error {
  return errors.notFound(
    LEGACY_PRODUCT_REVIEW_ERROR_CODES.NOT_FOUND,
    'No such legacy product review.',
  );
}

function notInState(state: LegacyProductReviewState): Error {
  return errors.conflict(
    LEGACY_PRODUCT_REVIEW_ERROR_CODES.NOT_IN_STATE,
    `This legacy product is ${state}; that decision cannot be made from it.`,
    { state },
  );
}

/** What an ingest audit row records: codes, checksums, state. No legacy cell values. */
function sourceView(row: LegacyProductReviewRecord): Record<string, unknown> {
  return {
    codeProduct: row.codeProduct,
    state: row.state,
    priorState: row.priorState,
    factsChecksum: row.factsChecksum,
    readFingerprint: row.readFingerprint,
    sourceFingerprint: row.sourceFingerprint,
    missingSinceReadFingerprint: row.missingSinceReadFingerprint,
    version: row.version,
  };
}

/** What a decision audit row records: the before/after of the decision itself. */
function decisionView(row: LegacyProductReviewRecord): Record<string, unknown> {
  return {
    ...sourceView(row),
    approvedProductId: row.approvedProductId,
    approvedFactsChecksum: row.approvedFactsChecksum,
    decisionReason: row.decisionReason,
  };
}
