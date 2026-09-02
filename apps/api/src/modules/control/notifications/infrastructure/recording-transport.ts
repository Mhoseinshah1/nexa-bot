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

  reset(): void {
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
    if (result.outcome === 'SUCCEEDED') this.sent.push(message);
    return result;
  }
}
