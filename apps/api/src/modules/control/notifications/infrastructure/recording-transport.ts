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

  get messages(): readonly OutboundMessage[] {
    return this.sent;
  }

  /** Makes the next send fail, so retry and abandonment can be exercised. */
  failNextWith(result: TransportResult): void {
    this.nextResult = result;
  }

  reset(): void {
    this.sent.length = 0;
    this.nextResult = { outcome: 'SUCCEEDED' };
  }

  async send(message: OutboundMessage): Promise<TransportResult> {
    const result = this.nextResult;
    this.nextResult = { outcome: 'SUCCEEDED' };
    if (result.outcome === 'SUCCEEDED') this.sent.push(message);
    return result;
  }
}
