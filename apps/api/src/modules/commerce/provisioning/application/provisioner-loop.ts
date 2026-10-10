import type { TenantContext } from '@nexa/contracts';
import type { DeliveryService } from './delivery.service.js';
import type { OperationOutcomeAnnouncer } from '../../messaging/application/operation-outcome-announcer.js';
import type { ProvisionerService } from './provisioner.service.js';
import type { OperationCardEditor } from './operation-card.js';

/**
 * The loop that drives the executor, and the readiness signal it earns.
 *
 * Its OWN FILE, not merely its own class. `worker-health-coverage.test.ts` marks every
 * class declared in a file that contains an `iterationIsFresh` as freshness-bearing,
 * and it is right to: two classes sharing a file where only one has a loop is a shape
 * where "which of these must a role start" stops being answerable by reading. Splitting
 * them makes the container member that must be started and the one that must not
 * distinguishable without knowing this file's contents.
 *
 * Separate from `ProvisionerService` so the executor can be tested one operation at a
 * time without a timer — the thing that made the monitor's own tests possible.
 *
 * Freshness is PROGRESS-based, not "a tick fired". The monitor's readiness learned this
 * the expensive way and its comment says why: a process whose timer still fires while
 * every query throws is not doing its job, and a marker touched regardless would report
 * it healthy for ever. So a tick counts only when it claimed something or established
 * there was nothing to claim; a tick that threw counts for nothing.
 *
 * There is no startup grace. Before the first successful tick this process has never
 * done its job, so it is not ready — an installation whose provisioner is broken must
 * fail its release rather than look fine for the first few minutes and then quietly
 * stop creating the services customers are paying for.
 */
export class ProvisionerLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastProgressAt: number | null = null;
  /**
   * When each LANE last succeeded, and when this loop started (FIX-03, batch 2026-10-10).
   *
   * For reporting only. Readiness is still the single `lastProgressAt` above — any lane's
   * failure costs the tick its progress, exactly as before — but "the provisioner is
   * stale" sends an operator looking at the whole role when one lane is the answer, so
   * each lane's own success is kept and `laneStatuses` names the one that stopped.
   */
  private readonly laneProgressAt = new Map<ProvisionerLane, number>();
  private startedAt: number | null = null;
  /**
   * While a tick is in flight, when it last finished a step; null between ticks (Codex P2
   * on #258).
   *
   * A tick is a sequence of steps, and the drain's steps are provider calls each allowed
   * `PANEL_HTTP_TIMEOUT_MS` — up to 120 s against a tick that can be 1 s. Judged by the
   * lanes' last successes alone, one ordinary call in flight made every lane look stalled
   * and then recovered: an alarm and an all-clear for a provisioner doing its job. So
   * while a tick runs, its own last step is the evidence, held to the tick window PLUS the
   * longest step this installation allows (`inFlightAllowanceMs`). Past that, it is a hang.
   */
  private tickActivityAt: number | null = null;

  constructor(
    private readonly executor: ProvisionerService,
    /**
     * The announcement half, driven by the SAME tick.
     *
     * Here rather than in `ProvisionerService`, and that placement is the rule this
     * pair exists to hold: a failed Telegram message must not be able to reach the
     * provisioning transaction. The executor cannot call the messenger because it does
     * not have one, which is a stronger guarantee than a comment saying it must not.
     *
     * Driven by this loop rather than by a second process because the trigger is
     * immediate: a service reaches `ACTIVE` in the provisioning drain above, and the
     * delivery drain below finds it due in the same tick. A customer who has just paid
     * does not wait for another process's timer.
     */
    private readonly delivery: DeliveryService,
    /**
     * The other announcement half: how the thing a CUSTOMER asked for turned out.
     *
     * Here for the identical reason `delivery` is, and it is the same guarantee seen
     * once more: the executor has no messenger and this class has none either. Both
     * write rows; the worker's lane sends them.
     *
     * Between `bot.service.action_requested` and this, a customer who had PAID for a
     * renewal heard nothing about whether it happened.
     */
    private readonly outcomes: OperationOutcomeAnnouncer,
    private readonly options: {
      readonly scope: () => TenantContext;
      /**
       * The cashback earner (WP8 P9), driven by the SAME tick, after the drain that
       * delivers. A promise whose order was just delivered is credited one tick later at
       * most, and a crash in between costs a tick, never the credit: the promise is a
       * `PENDING` row until this decides it.
       */
      readonly cashback: { settleDue(scope: TenantContext, limit: number): Promise<number> };
      /** The referral commissions the same deliveries earned (WP9 F7). Same shape, same tick. */
      readonly referrals: { settleDue(scope: TenantContext, limit: number): Promise<number> };
      /**
       * WP19: customer refund requests whose provider deletion has just become terminal. The
       * same shape and the same tick as the two above — a credit decided by a sweep over the
       * state, never by a hook at the executor's success site — and after the drain that
       * runs the `TERMINATE`, so a deletion is credited one tick later at most.
       */
      readonly serviceRefunds: { settleDue(scope: TenantContext, limit: number): Promise<number> };
      /** R3 item 10: the service cards to edit when a disable or enable succeeds. */
      readonly cards?: Pick<OperationCardEditor, 'answer' | 'answerDue'>;
      readonly tickMs: number;
      /**
       * The longest ONE step of a tick may legitimately take — a provider exchange at the
       * configured panel HTTP timeout. Reporting only; readiness ignores it. Zero when
       * omitted (a test without provider calls).
       */
      readonly inFlightAllowanceMs?: number;
      readonly now: () => number;
      /**
       * The narrowest shape this loop uses.
       *
       * Structural rather than the platform `Logger` type, so a test can drive the
       * loop with two functions — and matching its `Record<string, unknown>` context
       * exactly, because a wider `object` here is not assignable from it.
       */
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.startedAt ??= this.options.now();
    this.timer = setInterval(() => void this.tick(), this.options.tickMs);
    // Node keeps the event loop alive for a timer; this one should not stop a
    // shutdown that has already begun draining.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One tick, drained until idle or until the budget refuses.
   *
   * Drains rather than doing exactly one operation, so a backlog after an outage
   * clears at the rate the tenant's outbound budget allows rather than at one per
   * tick. The loop stops on `IDLE` — nothing due — and on any refusal, because every
   * refusal this returns means the NEXT operation would hit the same wall.
   *
   * Re-entrancy is refused rather than queued: a tick that overran its interval is a
   * tick still holding a provider call, and starting a second one would double this
   * process's outbound rate exactly when the panels are slowest.
   *
   * Public so a test can drive exactly one tick and assert what it did. A timer-driven
   * private tick can only be observed by waiting, and a test that waits for a loop is a
   * test that passes on a slow machine for the wrong reason.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt ??= this.options.now();
    this.tickActivityAt = this.options.now();
    let scope: TenantContext | null = null;
    let failed = false;
    try {
      scope = this.options.scope();
      for (let drained = 0; drained < DRAIN_LIMIT; drained += 1) {
        const result = await this.executor.runOnce(scope);
        this.touch();
        if (result.kind === 'IDLE') break;
        /*
         * ONE LINE PER OPERATION, and the reason it is here rather than inside
         * the executor.
         *
         * The production report for order `01a0c54b` says the provisioner logs
         * "contained no useful per-operation failure entry", and that was exactly
         * true: this loop logged only a thrown tick, and a refusal does not throw
         * — it returns a value. Seven minutes of retries produced no line at all.
         *
         * At `info` rather than `error`, including for failures: every one of
         * these is an expected outcome the database already records, and a log
         * level is how an operator decides what to wake up for. The operational
         * event and `provisioning.stalled` are the alerting path; this is the
         * trail that says what happened in what order.
         *
         * `secretsSafe` is the shape rather than a filter: `ExecutionResult`
         * carries ids and enums and has nowhere to put a credential, a
         * subscription URL or a provider's body. Spreading it is safe BECAUSE
         * that is true, which is why the type says so at length.
         */
        this.options.logger.info(
          { ...result, worker: 'provisioner' },
          result.kind === 'REFUSED' ? 'provisioning refused' : 'provisioning attempted',
        );
        /*
         * Announced BEFORE the `REFUSED` break, and for a refusal too.
         *
         * Three refusal paths terminalise the operation to `ABANDONED` — a missing
         * service, a capability this release does not implement, a service in a state
         * the operation is not legal from — and this used to break on `REFUSED` first.
         * So a customer whose renewal was refused because their panel type cannot be
         * renewed on was told nothing at all, deterministically, every time. Found by
         * the Codex review of PR #30.
         *
         * `announce` reads the operation's own state and queues nothing for one that is
         * not terminal, so calling it for every refusal — including the ones that hold
         * off and retry — is correct rather than merely harmless. Queued, not sent.
         */
        await this.outcomes.announce(scope, result.operationId);
        this.touch();
        /*
         * R3 item 10: a disable or enable asked from a service card is answered ON the
         * card, in this tick. `answer` claims first and does nothing for any other
         * operation, so calling it for every result is safe.
         */
        await this.options.cards?.answer(scope, result.operationId);
        this.touch();
        if (result.kind === 'REFUSED') break;
      }
      /*
       * Then the announcements, for the services the drain above just activated.
       *
       * ONE batch per tick, not drained to empty like the provisioning half. A
       * provisioning backlog clears against panels this installation's operator owns
       * and whose rate this installation's own budget already bounds; an announcement
       * backlog clears against Telegram, whose limits are somebody else's and which
       * answers a burst by refusing the rest. `DRAIN_LIMIT` per tick is the ceiling,
       * and a backlog larger than that takes more ticks rather than one long one.
       */
      await this.delivery.deliverDue(scope, DRAIN_LIMIT);
      this.touch();
      /*
       * And the operations a CRASH left terminal and unanswered.
       *
       * The line above this tick's drain — `await this.outcomes.announce(...)`
       * — runs in a transaction AFTER the one that terminalised the operation,
       * and a process that dies between them leaves an operation nothing will
       * ever announce again: the loop has moved on and there is one call site.
       * `announceDue` sweeps on the STATE rather than on a call site, so a
       * terminalising path added later is covered without anybody remembering.
       *
       * Its grace period means the ordinary operation never reaches it — the
       * synchronous call above answers within milliseconds — so anything this
       * returns is a crash rather than a race with the loop.
       *
       * ONE batch per tick and not drained, for the same reason `deliverDue`
       * gives one line up: what it queues is claimed against Telegram, whose
       * limits are somebody else's.
       */
      await this.outcomes.announceDue(scope, DRAIN_LIMIT);
      this.touch();
      // R3: cards a crash left unanswered, after the grace.
      await this.options.cards?.answerDue(scope, DRAIN_LIMIT);
      this.laneProgressAt.set('provisioner', this.options.now());
    } catch (error: unknown) {
      /*
       * A failed tick makes NO progress, deliberately.
       *
       * Swallowed so one bad tick does not kill the process, and NOT recorded as
       * progress so readiness goes stale if every tick keeps failing. Those two
       * together are what make the heartbeat honest.
       */
      failed = true;
      this.options.logger.error({ error }, 'provisioner tick failed');
    }
    try {
      if (scope !== null) {
        /*
         * Then the settlement lanes, EACH on its own (Codex review of #83, round 11).
         *
         * The cashback the drain earned or voided, the referral commissions beside it (WP9
         * F7), and the refund requests whose deletion finished (WP19). ONE batch per tick
         * each: every decision is its own short transaction, and a backlog takes more ticks
         * rather than one long one. They used to run in sequence inside the drain's `try`,
         * so one row that failed for ever in an earlier lane — or a failing drain — kept
         * every later lane from running at all: a service already deleted, and its refund
         * never credited. Now a lane's failure is logged under its own name, costs the
         * tick its progress as before, and holds no other lane back.
         */
        for (const [lane, settle, reported] of [
          ['cashback', this.options.cashback, 'provisioner-cashback'],
          ['referrals', this.options.referrals, 'provisioner-referrals'],
          ['serviceRefunds', this.options.serviceRefunds, 'provisioner-service-refunds'],
        ] as const) {
          try {
            await settle.settleDue(scope, DRAIN_LIMIT);
            this.laneProgressAt.set(reported, this.options.now());
            this.touch();
          } catch (error: unknown) {
            failed = true;
            this.touch();
            this.options.logger.error({ error, lane }, 'provisioner settlement lane failed');
          }
        }
      }
      if (!failed) this.lastProgressAt = this.options.now();
    } finally {
      this.running = false;
      this.tickActivityAt = null;
    }
  }

  /** A step of the in-flight tick finished (reporting only; see `tickActivityAt`). */
  private touch(): void {
    this.tickActivityAt = this.options.now();
  }

  /** Whether this process has made progress recently enough to be called ready. */
  iterationIsFresh(nowMs: number): boolean {
    if (this.lastProgressAt === null) return false;
    return nowMs - this.lastProgressAt <= this.options.tickMs * STALE_TICK_MULTIPLE;
  }

  /**
   * Each lane, stalled or not, for the operations log (FIX-03, batch 2026-10-10).
   *
   * Three answers per lane (Codex P2 on #258):
   *
   * - `false`, fresh: it succeeded within the window readiness uses — or the loop was never
   *   started (the provisioner disabled), which closes a condition a previous life opened.
   * - `null`, UNKNOWN: no verdict. Before the lane's first success while the loop is inside
   *   its startup window, or while a tick is in flight and its last step finished within
   *   the window plus `inFlightAllowanceMs`. UNKNOWN neither opens a condition nor closes
   *   one, so a stall inherited from the previous life stays open until the lane actually
   *   succeeds here, and a long provider call raises nothing.
   * - `true`, stalled: anything else.
   */
  laneStatuses(nowMs: number): readonly { name: ProvisionerLane; stalled: boolean | null }[] {
    const window = this.options.tickMs * STALE_TICK_MULTIPLE;
    const inFlight =
      this.tickActivityAt !== null &&
      nowMs - this.tickActivityAt <= window + (this.options.inFlightAllowanceMs ?? 0);
    return PROVISIONER_LANES.map((name) => {
      if (this.startedAt === null) return { name, stalled: false };
      const last = this.laneProgressAt.get(name);
      if (last !== undefined && nowMs - last <= window) return { name, stalled: false };
      if (last === undefined && nowMs - this.startedAt <= window) return { name, stalled: null };
      return { name, stalled: inFlight ? null : true };
    });
  }
}

/**
 * The lanes this loop runs, by the names the operations log reports them under.
 *
 * Prefixed, because a stall's dedupe key is `job.loop_stalled:<name>` and the worker's
 * loops share that namespace: a lane called `referrals` here and a loop of that name in
 * the worker would open and close each other's condition.
 */
export const PROVISIONER_LANES = [
  'provisioner',
  'provisioner-cashback',
  'provisioner-referrals',
  'provisioner-service-refunds',
] as const;
export type ProvisionerLane = (typeof PROVISIONER_LANES)[number];

/** How many operations one tick may drain before yielding. */
export const DRAIN_LIMIT = 10;

/**
 * How many missed ticks before this process stops calling itself ready.
 *
 * Three rather than one, because a single slow provider call legitimately outlasts a
 * tick and a provisioner working through one is not broken. Three consecutive silent
 * intervals is a loop that has stopped.
 */
export const STALE_TICK_MULTIPLE = 3;
