import type { CustomerTagColor, TenantContext, UserId } from '@nexa/contracts';

/**
 * Customer notes and tags (program §8, `docs/customer-notes-tags.md`) — what the CRM service
 * asks of storage. Operator-only: nothing on a customer surface holds this port.
 */

export interface CustomerTagRecord {
  readonly id: string;
  readonly label: string;
  readonly color: CustomerTagColor | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomerAssignedTagRecord extends CustomerTagRecord {
  readonly assignedAt: Date;
}

export interface CustomerNoteRecord {
  readonly id: string;
  readonly customerId: UserId;
  readonly body: string;
  readonly authorAdminId: string | null;
  readonly authorLabel: string;
  readonly createdAt: Date;
}

/** `(created_at, id)` DESCENDING; `createdAt` is PostgreSQL's own text (`CustomerCursor`). */
export interface CustomerNoteCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface CustomerNotePage {
  readonly items: readonly CustomerNoteRecord[];
  readonly nextCursor: CustomerNoteCursor | null;
}

export interface CustomerCrmRepository {
  /**
   * The tenant's catalogue lock: a transaction-scoped advisory lock every CATALOGUE write
   * (create, rename, restore) takes first, so the count against the cap and the "is this name
   * taken" read are decided one writer at a time. Assignments never take it.
   */
  lockCatalogue(scope: TenantContext, tx: unknown): Promise<void>;
  countTags(scope: TenantContext, tx: unknown): Promise<number>;
  /** Every tag of the tenant: active first, then by label, then id. Bounded by the cap. */
  listTags(scope: TenantContext, tx?: unknown): Promise<readonly CustomerTagRecord[]>;
  /**
   * One tag of THIS tenant, or null. `lock`: `UPDATE` for a catalogue write, `SHARE` for an
   * assignment — a share lock conflicts with the archive's UPDATE, so an assignment and an
   * archive racing are decided in order and never both on stale state.
   */
  findTag(
    scope: TenantContext,
    id: string,
    tx?: unknown,
    lock?: 'UPDATE' | 'SHARE',
  ): Promise<CustomerTagRecord | null>;
  /** Whether another ACTIVE tag already has this label, compared by `lower()`. */
  activeLabelTaken(
    scope: TenantContext,
    label: string,
    exceptId: string | null,
    tx: unknown,
  ): Promise<boolean>;
  insertTag(
    scope: TenantContext,
    tag: {
      readonly id: string;
      readonly label: string;
      readonly color: CustomerTagColor | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<CustomerTagRecord>;
  /** Rename/recolour; `false` when the row already holds exactly that. */
  updateTag(
    scope: TenantContext,
    id: string,
    change: { readonly label: string; readonly color: CustomerTagColor | null; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;
  /** A conditional UPDATE naming the state it expects; `false`: already so. */
  setArchived(
    scope: TenantContext,
    id: string,
    archived: boolean,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** `INSERT … ON CONFLICT DO NOTHING`; `false`: the customer already carried it. */
  assign(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly tagId: string;
      readonly adminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;
  /** `false`: the customer did not carry it. */
  unassign(scope: TenantContext, customerId: UserId, tagId: string, tx: unknown): Promise<boolean>;
  /** One customer's tags, archived ones included, active first then by label. */
  tagsOf(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<readonly CustomerAssignedTagRecord[]>;

  insertNote(
    scope: TenantContext,
    note: {
      readonly id: string;
      readonly customerId: UserId;
      readonly body: string;
      readonly authorAdminId: string | null;
      readonly authorLabel: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<CustomerNoteRecord>;
  findNote(
    scope: TenantContext,
    customerId: UserId,
    id: string,
  ): Promise<CustomerNoteRecord | null>;
  /** Newest first, keyset on `(created_at, id)`. */
  notesOf(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
    cursor: CustomerNoteCursor | null,
  ): Promise<CustomerNotePage>;
}
