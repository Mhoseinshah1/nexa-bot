import {
  LEGACY_HISTORY_ERROR_CODES,
  errors,
  type IdGenerator,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type {
  ExplainedGap,
  ExactMatchRow,
  MaterializeContext,
  MaterializeStepOutcome,
} from './ports.js';

/**
 * What every history step shares: how the archive is read, how a Mirza value becomes a NEXA
 * one, and the one loop that applies a plan and counts what it did. Nothing in here knows a
 * table; a step supplies only the plan for one record and the repository for its table.
 */

/** Records per page: one transaction each, and a bound on what is held in memory. */
export const MATERIALIZE_PAGE = 5000;

/** The marker every row these steps write carries. */
export const MIRZA_SOURCE = 'MIRZA' as const;

/** One archived package record (`legacy_history_records`), exactly as ingested. */
export interface HistoryRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly legacyUserId: string | null;
  /** Resolved at ingest; null when the user was not an imported customer then. */
  readonly customerId: string | null;
  readonly occurredAt: Date | null;
  readonly createdAt: Date;
  readonly payload: Record<string, unknown>;
}

/** Read-only access to the archive and to the importer's map. */
export interface HistoryRecordReader {
  /** Records of one type of one package import, by id (keyset), at most `limit`. */
  page(
    scope: TenantContext,
    nxpkgImportId: string,
    recordType: string,
    afterId: string | null,
    limit: number,
    tx?: TransactionScope,
  ): Promise<readonly HistoryRecord[]>;
  /** These records by id (a step that groups records reads the groups, not whole tables). */
  byIds(
    scope: TenantContext,
    nxpkgImportId: string,
    ids: readonly string[],
    tx?: TransactionScope,
  ): Promise<readonly HistoryRecord[]>;
  /** Telegram user id -> NEXA customer id, for the users the importer imported. */
  customersByLegacyUser(
    scope: TenantContext,
    legacyUserIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;
}

export interface MaterializeDeps {
  readonly records: HistoryRecordReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly ids: IdGenerator;
}

// --- values ------------------------------------------------------------------------------

/** A whole number as the converter writes money: decimal digits, optional sign. Else null. */
export function parseMinor(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string' || !/^-?[0-9]{1,18}$/.test(value)) return null;
  return BigInt(value);
}

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** `payload.a.b.c`, or undefined when any step is not an object. */
export function at(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value;
  for (const step of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The text bounded to `max` code points; Mirza free text is kept, never invented. */
export function bounded(value: unknown, max: number): string | null {
  const t = text(value);
  if (t === null) return null;
  const points = Array.from(t);
  return points.length <= max ? t : points.slice(0, max).join('');
}

const TEHRAN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tehran',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function tehranOffsetMs(at: number): number {
  const parts = Object.fromEntries(
    TEHRAN.formatToParts(new Date(at)).map((part) => [part.type, part.value]),
  );
  const local = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return local - Math.floor(at / 1000) * 1000;
}

/**
 * A Mirza time as an instant, or null.
 *
 * Unix seconds and ISO text with `Z` or an offset are absolute. The converter's naive local
 * time (`2024-08-01T10:00:00`, no offset) is Mirza's server clock, which `index.php:3` of the
 * source sets to Asia/Tehran: it is read in that zone, which is the only zone the evidence
 * names. Anything else (empty, Jalali, out of range) is null and the caller says so — a
 * date is never invented.
 */
export function mirzaInstant(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 946_684_800 && value <= 4_102_444_800 ? new Date(value * 1000) : null;
  }
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local === null) return null;
  const [y, mo, d, h, mi, s] = local.slice(1).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 2000 || y > 2099) return null;
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  // A calendar date that does not exist (Feb 30) rolls over in `Date.UTC`: refuse it.
  const check = new Date(naive);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const first = naive - tehranOffsetMs(naive);
  return new Date(naive - tehranOffsetMs(first));
}

/** `<prefix>:<id>` as a `source_ref`; null when the id is unusable (empty, or too long). */
export function sourceRefOf(prefix: string, id: unknown): string | null {
  const raw = typeof id === 'number' ? String(id) : text(id);
  if (raw === null) return null;
  const ref = `${prefix}:${raw.trim()}`;
  return raw.trim().length === 0 || ref.length > 128 ? null : ref;
}

/** The Mirza primary key of a record: its provenance, else the key's own tail. */
export function mirzaIdOf(record: HistoryRecord, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = record.payload[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  const pk = at(record.payload, 'provenance', 'source_pk');
  if (typeof pk === 'string' && pk.length > 0) return pk;
  const tail = record.idempotencyKey.split(':').slice(2).join(':');
  return tail.length > 0 ? tail : null;
}

/** The customer of a record: the one resolved at ingest, else the importer's map. */
export function customerOf(record: HistoryRecord, map: ReadonlyMap<string, string>): string | null {
  if (record.customerId !== null) return record.customerId;
  return record.legacyUserId === null ? null : (map.get(record.legacyUserId) ?? null);
}

/** Counts of why rows were not carried. */
export class GapTally {
  private readonly gaps = new Map<string, { rows: number; sum: bigint | null }>();

  add(reason: string, sumMinor: bigint | null): void {
    this.addRows(reason, 1, sumMinor);
  }

  addRows(reason: string, rows: number, sumMinor: bigint | null = null): void {
    if (rows <= 0) return;
    const gap = this.gaps.get(reason) ?? { rows: 0, sum: null };
    gap.rows += rows;
    if (sumMinor !== null) gap.sum = (gap.sum ?? 0n) + sumMinor;
    this.gaps.set(reason, gap);
  }

  asRecord(): Readonly<Record<string, number>> {
    return Object.fromEntries(
      [...this.gaps].sort(([a], [b]) => a.localeCompare(b)).map(([r, g]) => [r, g.rows]),
    );
  }

  explained(): readonly ExplainedGap[] {
    return [...this.gaps]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, gap]) => ({ reason, rows: gap.rows, sumMinor: gap.sum }));
  }
}

// --- the plan and the loop ------------------------------------------------------------

/** A row a step intends to write: keyed, and comparable to the row already stored. */
export interface PlannedWrite {
  readonly sourceRef: string;
  /** Every column that is content, joined: equal exactly when a stored row says the same. */
  readonly fingerprint: string;
}

/**
 * What one record becomes: a row, or a counted reason it is not one. `sumMinor` is the
 * record's amount in Mirza whichever it is, so the money on both sides of a gap is known;
 * null for a table that carries no amount.
 */
export type Planned<W extends PlannedWrite> =
  | { readonly kind: 'write'; readonly write: W; readonly sumMinor: bigint | null }
  | { readonly kind: 'gap'; readonly reason: string; readonly sumMinor: bigint | null };

export const write = <W extends PlannedWrite>(
  row: W,
  sumMinor: bigint | null = null,
): Planned<W> => ({ kind: 'write', write: row, sumMinor });
export const gap = <W extends PlannedWrite>(
  reason: string,
  sumMinor: bigint | null = null,
): Planned<W> => ({ kind: 'gap', reason, sumMinor });

/** A table's writer. */
export interface PlannedRepository<W extends PlannedWrite> {
  /** `INSERT … ON CONFLICT (tenant_id, source_ref) DO NOTHING`; returns the refs it inserted. */
  insert(
    scope: TenantContext,
    rows: readonly W[],
    ctx: MaterializeContext,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  /** The fingerprint of the stored row of each of these writes, by the write's `sourceRef`. */
  fingerprints(
    scope: TenantContext,
    rows: readonly W[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;
  /** Rows and Σ amount of what the tenant holds from Mirza in this table. */
  totals(
    scope: TenantContext,
    filter: string | null,
  ): Promise<{ readonly rows: number; readonly sumMinor: bigint | null }>;
}

export interface PlannedStep<W extends PlannedWrite> {
  readonly name: string;
  readonly recordType: string;
  readonly repository: PlannedRepository<W>;
  /** One plan per record, in order. Lookups it needs may read through `tx`. */
  plan(
    records: readonly HistoryRecord[],
    ctx: MaterializeContext,
    tx: TransactionScope | undefined,
  ): Promise<readonly Planned<W>[]>;
}

async function* pages(
  deps: MaterializeDeps,
  ctx: MaterializeContext,
  recordType: string,
): AsyncGenerator<readonly HistoryRecord[]> {
  let after: string | null = null;
  for (;;) {
    const page: readonly HistoryRecord[] = await deps.records.page(
      ctx.scope,
      ctx.packageImportId,
      recordType,
      after,
      MATERIALIZE_PAGE,
    );
    if (page.length === 0) return;
    yield page;
    after = (page[page.length - 1] as HistoryRecord).id;
    if (page.length < MATERIALIZE_PAGE) return;
  }
}

/** A second plan for one `source_ref` in a run is a gap, never a second write. */
function dedupe<W extends PlannedWrite>(
  planned: readonly Planned<W>[],
  seen: Set<string>,
): Planned<W>[] {
  return planned.map((p) => {
    if (p.kind !== 'write') return p;
    if (seen.has(p.write.sourceRef)) return gap<W>('DUPLICATE_SOURCE_ID', p.sumMinor);
    seen.add(p.write.sourceRef);
    return p;
  });
}

/** Applies a step: every page in its own transaction, scope activity read inside it. */
export async function applyPlanned<W extends PlannedWrite>(
  deps: MaterializeDeps,
  step: PlannedStep<W>,
  ctx: MaterializeContext,
): Promise<MaterializeStepOutcome> {
  const skipped = new GapTally();
  let written = 0;
  let alreadyPresent = 0;
  let diverged = 0;
  const seen = new Set<string>();
  for await (const records of pages(deps, ctx, step.recordType)) {
    await deps.uow.run(ctx.scope, async (tx) => {
      await assertScopeActive(deps, ctx, tx);
      const planned = dedupe(await step.plan(records, ctx, tx), seen);
      const writes: W[] = [];
      for (const p of planned) {
        if (p.kind === 'write') writes.push(p.write);
        else skipped.add(p.reason, p.sumMinor);
      }
      if (writes.length === 0) return;
      const inserted = await step.repository.insert(ctx.scope, writes, ctx, tx);
      written += inserted.size;
      const present = writes.filter((w) => !inserted.has(w.sourceRef));
      if (present.length === 0) return;
      const stored = await step.repository.fingerprints(ctx.scope, present, tx);
      for (const w of present) {
        if (stored.get(w.sourceRef) === w.fingerprint) alreadyPresent += 1;
        else diverged += 1;
      }
    });
  }
  return { step: step.name, written, alreadyPresent, diverged, skipped: skipped.asRecord() };
}

/** Read only: what Mirza holds, what NEXA holds, and every gap with its reason. */
export async function matchPlanned<W extends PlannedWrite>(
  deps: MaterializeDeps,
  step: PlannedStep<W>,
  ctx: MaterializeContext,
  options: {
    readonly mirzaTable: string;
    readonly nexaTable: string;
    readonly hasAmount: boolean;
    /** Narrows both sides to one origin when a table holds several record types. */
    readonly nexaFilter?: string | null;
  },
): Promise<ExactMatchRow> {
  const gaps = new GapTally();
  const seen = new Set<string>();
  let mirzaRows = 0;
  let mirzaSum = 0n;
  for await (const records of pages(deps, ctx, step.recordType)) {
    const planned = dedupe(await step.plan(records, ctx, undefined), seen);
    for (const p of planned) {
      mirzaRows += 1;
      mirzaSum += p.sumMinor ?? 0n;
      if (p.kind === 'gap') gaps.add(p.reason, p.sumMinor);
    }
  }
  const nexa = await step.repository.totals(ctx.scope, options.nexaFilter ?? null);
  return {
    mirzaTable: options.mirzaTable,
    nexaTable: options.nexaTable,
    mirzaRows,
    nexaRows: nexa.rows,
    mirzaSumMinor: options.hasAmount ? mirzaSum : null,
    nexaSumMinor: options.hasAmount ? (nexa.sumMinor ?? 0n) : null,
    explained: gaps.explained(),
  };
}

export async function assertScopeActive(
  deps: Pick<MaterializeDeps, 'scopeActivity'>,
  ctx: MaterializeContext,
  tx: TransactionScope,
): Promise<void> {
  if (!(await deps.scopeActivity.scopeIsActive(ctx.scope, tx))) {
    throw errors.conflict(
      LEGACY_HISTORY_ERROR_CODES.SCOPE_STOPPED,
      'This installation has stopped accepting work.',
    );
  }
}
