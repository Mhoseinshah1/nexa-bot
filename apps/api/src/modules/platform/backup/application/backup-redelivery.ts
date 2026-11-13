import {
  BACKUP_LOCAL_ONLY_REASONS,
  type BackupDeliveryReason,
  type BackupDeliveryState,
  type Clock,
} from '@nexa/contracts';
import type {
  BackupDeliveryChannel,
  BackupDeliveryResolution,
  BackupRedeliveryStore,
  BackupRunPartRow,
  BackupRunPartStore,
  BackupRunRepository,
  BackupRunRow,
} from './ports.js';
import { deliverPartsInOrder, type DeliverablePart } from './backup-part-delivery.js';
import { backupRedeliveredPartCaption } from './backup-caption.js';

/**
 * «ارسال دوبارهٔ بخش‌های نرسیده» (NEXA-BACKUP-DELIVERY): sends the parts of a FINISHED run
 * that carry no Telegram message id — and only those, in order — from the archive still on
 * this host. The Web Admin's button and the legacy compaction's retry before its gate both
 * come here; the loop is the run's own (`deliverPartsInOrder`), so the same bounded resend
 * rule applies.
 *
 * WHAT IT NEVER DOES. Touch a running, failed or unverified run; send a run kept on this
 * server by design (`LOCAL_ONLY_*`: a Mirza import's backups, a server-move member); send a
 * part that already carries a message id (the store refuses to overwrite one, too); or send
 * the same part twice at once — the run's re-delivery LEASE is one conditional UPDATE, so a
 * double press or a press racing the compaction is `BUSY`, never two uploads.
 *
 * Where it sends is decided now, like a run's (`resolveDelivery`): the parts that already
 * arrived were sent wherever the run decided then. When the operations group and the
 * dedicated chat are both configured and the group became unusable in between, the missing
 * parts land in the fallback chat — the operator joins parts from two chats. Rare, and said
 * here rather than hidden.
 */

export type BackupRedeliveryOutcome =
  /** Every part now carries a Telegram message id. */
  | { readonly kind: 'DELIVERED' }
  /** Some part still does not; the parts' rows say which and why. */
  | { readonly kind: 'NOT_DELIVERED'; readonly reason: BackupDeliveryReason | null }
  /** Another re-delivery of this run holds the lease. */
  | { readonly kind: 'BUSY' }
  | {
      readonly kind: 'REFUSED';
      readonly why: 'MISSING' | 'NOT_FINISHED' | 'LOCAL_ONLY' | 'NO_PARTS' | 'ARCHIVE_GONE';
    };

export interface BackupRedeliveryDeps {
  readonly runs: Pick<BackupRunRepository, 'byId'> &
    Pick<BackupRunPartStore, 'parts'> &
    BackupRedeliveryStore;
  /** The pipeline's own destination decision, summary and delivery conditions. */
  readonly pipeline: {
    resolveDelivery(): Promise<BackupDeliveryResolution>;
    sendSummary(
      channel: Pick<BackupDeliveryChannel, 'sendMessage'>,
      input: {
        readonly id: string;
        readonly takenAt: string;
        readonly totalBytes: number;
        readonly parts: readonly { readonly filename: string; readonly sha256: string }[];
        readonly sevenZip: boolean;
        readonly dumpChecksum: string;
        readonly title?: string;
      },
    ): Promise<{
      readonly detail: string | null;
      readonly summaryState: BackupDeliveryState | null;
    }>;
    reportDelivery(
      id: string,
      state: BackupDeliveryState,
      delivered: number,
      partCount: number,
    ): Promise<void>;
  };
  /** The run's archive on this host, or null when the id cannot name one. */
  readonly archivePathOf: (run: BackupRunRow) => string | null;
  /** Whether that file is there (the surface's `stat`). */
  readonly archiveExists: (path: string) => Promise<boolean>;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
  /** This process's identity: the lease owner. */
  readonly owner: string;
  /**
   * How long one claim of the lease lasts, renewed before every send: one send's deadline
   * (`BACKUP_DELIVERY_TIMEOUT_MS`) plus the longest pause between sends, with margin.
   */
  readonly leaseMs: number;
  readonly formatTakenAt?: (at: Date) => string;
}

export class BackupRedelivery {
  constructor(private readonly deps: BackupRedeliveryDeps) {}

  /**
   * Whether a run's undelivered parts may be re-delivered at all, without looking at the
   * disk (the list's `redeliverable` adds the archive's presence).
   */
  static eligible(
    run: BackupRunRow,
    parts: readonly BackupRunPartRow[],
  ): 'YES' | 'ALREADY_DELIVERED' | Extract<BackupRedeliveryOutcome, { kind: 'REFUSED' }>['why'] {
    if ((run.subjectTenantId ?? null) !== null) return 'MISSING';
    if (run.state !== 'SUCCEEDED' || run.verifiedAt === null) return 'NOT_FINISHED';
    if (run.archivePrunedAt !== null) return 'ARCHIVE_GONE';
    const reason = run.deliveryReason ?? null;
    if (reason !== null && (BACKUP_LOCAL_ONLY_REASONS as readonly string[]).includes(reason)) {
      return 'LOCAL_ONLY';
    }
    if (parts.length === 0) return 'NO_PARTS';
    return parts.every((part) => part.telegramMessageId !== null) ? 'ALREADY_DELIVERED' : 'YES';
  }

  async redeliver(
    id: string,
    options: {
      /** No new send starts after this instant (the compaction's bound). */
      readonly deadline?: Date | null;
      /** The headline instead of «بکاپ» (the compaction's «آرشیو ربات قبلی»). */
      readonly title?: string;
    } = {},
  ): Promise<BackupRedeliveryOutcome> {
    const run = await this.deps.runs.byId(id);
    if (run === null) return { kind: 'REFUSED', why: 'MISSING' };
    const parts = await this.deps.runs.parts(id);
    const eligible = BackupRedelivery.eligible(run, parts);
    if (eligible === 'ALREADY_DELIVERED') return { kind: 'DELIVERED' };
    if (eligible !== 'YES') return { kind: 'REFUSED', why: eligible };
    const archivePath = this.deps.archivePathOf(run);
    if (archivePath === null || !(await this.deps.archiveExists(archivePath))) {
      return { kind: 'REFUSED', why: 'ARCHIVE_GONE' };
    }

    const owner = this.deps.owner;
    const claimed = await this.deps.runs.claimRedelivery({
      id,
      owner,
      now: this.deps.clock.now(),
      leaseUntil: this.leaseUntil(),
    });
    if (!claimed) return { kind: 'BUSY' };

    try {
      return await this.deliverClaimed(run, archivePath, options);
    } catch (error) {
      // The run's delivery columns are untouched; the lease goes back so a later press can
      // try. Each part's row already says what it learned.
      await this.deps.runs.releaseRedelivery({ id, owner });
      throw error;
    }
  }

  private leaseUntil(): Date {
    return new Date(this.deps.clock.now().getTime() + this.deps.leaseMs);
  }

  private async deliverClaimed(
    run: BackupRunRow,
    archivePath: string,
    options: { readonly deadline?: Date | null; readonly title?: string },
  ): Promise<BackupRedeliveryOutcome> {
    const { id } = run;
    const owner = this.deps.owner;
    // Re-read under the lease: a part another re-delivery sent since the first read is done.
    const parts = await this.deps.runs.parts(id);
    const count = parts.length;
    const attemptedAt = this.deps.clock.now();
    const keep = {
      deliveryState: run.deliveryState,
      summaryDeliveryState: run.summaryDeliveryState,
    };

    let resolution: BackupDeliveryResolution;
    try {
      resolution = await this.deps.pipeline.resolveDelivery();
    } catch (error) {
      resolution = {
        kind: 'UNAVAILABLE',
        detail: `The backup destination could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (resolution.kind !== 'READY') {
      // Nothing was sent: the run keeps its delivery state, and says why this try did not go.
      const reason: BackupDeliveryReason =
        resolution.kind === 'NONE' ? 'NO_DESTINATION' : 'DESTINATION_UNAVAILABLE';
      await this.deps.runs.finishRedelivery({
        id,
        owner,
        ...keep,
        deliveryAttemptedAt: attemptedAt,
        deliveryDetail:
          resolution.kind === 'NONE' ? 'No backup destination is configured.' : resolution.detail,
        deliveryReason: reason,
      });
      return { kind: 'NOT_DELIVERED', reason };
    }

    const created = run.startedAt;
    const takenAt = this.deps.formatTakenAt?.(created) ?? created.toISOString();
    // Each part's range: recorded on its row; derived from the sizes before it otherwise.
    let offset = 0;
    const planned = parts.map((part) => {
      const start = part.rangeStart === undefined ? offset : Number(part.rangeStart);
      const end = start + Number(part.bytes);
      offset = end;
      return { row: part, start, end };
    });
    const pending: (DeliverablePart & { readonly sha256: string; readonly bytes: number })[] =
      planned
        .filter((one) => one.row.telegramMessageId === null)
        .map((one) => ({
          partNumber: one.row.partNumber,
          start: one.start,
          end: one.end,
          filename: one.row.filename,
          attemptsSoFar: one.row.deliveryAttempts ?? 0,
          sha256: one.row.sha256,
          bytes: Number(one.row.bytes),
        }));
    this.deps.logger.info(
      { backupId: id, parts: count, pending: pending.map((part) => part.partNumber) },
      'redelivering the backup parts that did not arrive',
    );

    const pass = await deliverPartsInOrder(
      {
        backupId: id,
        channel: resolution.channel,
        archivePath,
        whole: count === 1,
        parts: pending,
        deadline: options.deadline ?? null,
        caption: async (part, resend) => {
          const facts = pending.find((one) => one.partNumber === part.partNumber);
          return backupRedeliveredPartCaption({
            id,
            takenAt,
            partNumber: part.partNumber,
            partCount: count,
            filename: part.filename,
            bytes: part.end - part.start,
            sha256: facts?.sha256 ?? '',
            resend,
            ...(options.title === undefined ? {} : { title: options.title }),
          });
        },
        beforeSend: () =>
          this.deps.runs.extendRedelivery({ id, owner, leaseUntil: this.leaseUntil() }),
        record: (outcome) =>
          this.deps.runs.recordRedeliveredPart({
            id,
            owner,
            partNumber: outcome.partNumber,
            state: outcome.state,
            attemptedAt: outcome.attemptedAt,
            messageId: outcome.messageId,
            detail: outcome.detail,
            reason: outcome.reason,
            attempts: outcome.attempts,
          }),
      },
      { clock: this.deps.clock, sleep: this.deps.sleep, logger: this.deps.logger },
    );

    const deliveredTotal = count - pending.length + pass.delivered;
    if (pass.stopped !== null) {
      const stopped = pass.stopped;
      if (stopped.state === 'NOT_ATTEMPTED' && stopped.deadlinePassed === true) {
        // The window ended (the compaction's bound): the run keeps the state it had, and says
        // how far this re-delivery got.
        const kept = keep.deliveryState;
        await this.deps.runs.finishRedelivery({
          id,
          owner,
          deliveryState: kept,
          deliveryAttemptedAt: attemptedAt,
          deliveryDetail:
            `Re-delivery: ${String(deliveredTotal)} of ${String(count)} part(s) delivered; part ` +
            `${String(stopped.partNumber)}: ${stopped.detail ?? stopped.state}`,
          deliveryReason: run.deliveryReason ?? null,
          summaryDeliveryState: keep.summaryDeliveryState,
        });
        await this.deps.pipeline.reportDelivery(id, kept, deliveredTotal, count);
        return { kind: 'NOT_DELIVERED', reason: run.deliveryReason ?? null };
      }
      if (stopped.state === 'NOT_ATTEMPTED') {
        // The lease was lost (taken over after it lapsed): the new holder owns the run now.
        return { kind: 'NOT_DELIVERED', reason: null };
      }
      const state: BackupDeliveryState = stopped.state;
      await this.deps.runs.finishRedelivery({
        id,
        owner,
        deliveryState: state,
        deliveryAttemptedAt: attemptedAt,
        deliveryDetail:
          `Re-delivery: ${String(deliveredTotal)} of ${String(count)} part(s) delivered; part ` +
          `${String(stopped.partNumber)}: ${stopped.detail ?? stopped.state}`,
        deliveryReason: stopped.reason ?? 'TRANSPORT_ERROR',
        summaryDeliveryState: keep.summaryDeliveryState,
      });
      await this.deps.pipeline.reportDelivery(id, state, deliveredTotal, count);
      return { kind: 'NOT_DELIVERED', reason: stopped.reason };
    }

    const summary = await this.deps.pipeline.sendSummary(resolution.channel, {
      id,
      takenAt,
      totalBytes: Number(run.archiveBytes ?? 0n),
      parts: parts.map((part) => ({ filename: part.filename, sha256: part.sha256 })),
      sevenZip: run.archiveFormat === 'SEVEN_ZIP',
      dumpChecksum: run.checksum ?? '',
      ...(options.title === undefined ? {} : { title: options.title }),
    });
    await this.deps.runs.finishRedelivery({
      id,
      owner,
      deliveryState: 'SUCCEEDED',
      deliveryAttemptedAt: attemptedAt,
      deliveryDetail:
        count === 1
          ? 'Re-delivered.'
          : `Re-delivered: ${summary.detail ?? `all ${String(count)} parts delivered.`}`,
      deliveryReason: null,
      summaryDeliveryState: summary.summaryState,
    });
    await this.deps.pipeline.reportDelivery(id, 'SUCCEEDED', count, count);
    return { kind: 'DELIVERED' };
  }
}
