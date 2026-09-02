import type { NotificationTransportKind } from '@nexa/contracts';
import type {
  NotificationTransport,
  OutboundMessage,
  TransportResult,
} from '../application/ports.js';

/**
 * A transport that keeps what it was given instead of sending it.
 *
 * For tests, and only for tests. It is NOT a production fallback: a deployment
 * that selects it would report every notification delivered while nothing left
 * the process, which is precisely the "reports success for a write that did not
 * happen" pattern this codebase exists to avoid. `loadConfig` refuses it outside
 * development, so choosing it in production fails at boot rather than at 3am.
 */
export class RecordingTransport implements NotificationTransport {
  readonly kind: NotificationTransportKind = 'RECORDING';

  private readonly sent: OutboundMessage[] = [];
  private nextResult: TransportResult = { outcome: 'SUCCEEDED' };
  private nextThrow: Error | null = null;

  private invocations = 0;

  /**
   * A send that has begun and is waiting to be allowed to finish.
   *
   * Every test that drives this transport otherwise completes a whole
   * `tick()` — claim, send, record — before anything else can run, so the one
   * ordering the dispatcher's lease margin actually exists for is unreachable:
   * a send still in flight while its lease expires and the sweep runs, with
   * the outcome arriving afterwards. A held send is how that ordering is
   * reached, rather than approximated by driving the repository directly.
   */
  private held: {
    readonly entered: Promise<void>;
    readonly markEntered: () => void;
    readonly released: Promise<void>;
    readonly release: () => void;
  } | null = null;

  get messages(): readonly OutboundMessage[] {
    return this.sent;
  }

  /**
   * How many times `send` was CALLED, successful or not.
   *
   * Distinct from `messages`, which holds only what succeeded. A ceiling is
   * about calls: an assertion counting messages reported zero while a
   * regression made three failing calls, and passed.
   */
  get calls(): number {
    return this.invocations;
  }

  /** Makes the next send fail, so retry and abandonment can be exercised. */
  failNextWith(result: TransportResult): void {
    this.nextResult = result;
  }

  /**
   * Makes the next send THROW, which is a different case from returning a
   * failure and was handled differently — wrongly — until a test could
   * express it. A real transport raises when a socket dies, and the dispatcher
   * has to treat that as a retryable attempt rather than as an outcome it must
   * guess at.
   */
  throwNextWith(error: Error): void {
    this.nextThrow = error;
  }

  /**
   * Makes the next send PARK inside the transport until it is released.
   *
   * `entered` resolves once a send has actually begun — the intent is claimed,
   * its attempt counter is already incremented and its lease is held — so a
   * caller can expire that lease, run a sweep, or start a second dispatcher
   * while the first send is genuinely outstanding. The outcome is fixed when
   * the send enters, so a failure armed while it is parked belongs to the NEXT
   * call rather than silently rewriting this one's result.
   */
  holdNextSend(): { readonly entered: Promise<void>; readonly release: () => void } {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held = { entered, markEntered, released, release };
    return { entered, release };
  }

  reset(): void {
    // A hold that is still parked would deadlock whatever runs next, and a
    // test that forgot to release one should fail on its assertions rather
    // than by hanging the suite.
    this.held?.release();
    this.held = null;
    this.sent.length = 0;
    this.invocations = 0;
    this.nextResult = { outcome: 'SUCCEEDED' };
    this.nextThrow = null;
  }

  async send(message: OutboundMessage): Promise<TransportResult> {
    this.invocations += 1;
    const thrown = this.nextThrow;
    this.nextThrow = null;
    if (thrown) throw thrown;

    const result = this.nextResult;
    this.nextResult = { outcome: 'SUCCEEDED' };

    const held = this.held;
    if (held) {
      this.held = null;
      held.markEntered();
      await held.released;
    }

    if (result.outcome === 'SUCCEEDED') this.sent.push(message);
    return result;
  }
}
