import type { TenantContext } from '@nexa/contracts';
import type { DeliveryService } from './delivery.service.js';
import type { OperationOutcomeAnnouncer } from '../../messaging/application/operation-outcome-announcer.js';
import type { ProvisionerService } from './provisioner.service.js';

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
      readonly tickMs: number;
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
    try {
      const scope = this.options.scope();
      for (let drained = 0; drained < DRAIN_LIMIT; drained += 1) {
        const result = await this.executor.runOnce(scope);
        if (result.kind === 'IDLE') break;
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
      this.lastProgressAt = this.options.now();
    } catch (error: unknown) {
      /*
       * A failed tick makes NO progress, deliberately.
       *
       * Swallowed so one bad tick does not kill the process, and NOT recorded as
       * progress so readiness goes stale if every tick keeps failing. Those two
       * together are what make the heartbeat honest.
       */
      this.options.logger.error({ error }, 'provisioner tick failed');
    } finally {
      this.running = false;
    }
  }

  /** Whether this process has made progress recently enough to be called ready. */
  iterationIsFresh(nowMs: number): boolean {
    if (this.lastProgressAt === null) return false;
    return nowMs - this.lastProgressAt <= this.options.tickMs * STALE_TICK_MULTIPLE;
  }
}

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
