import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { asId, type CorrelationId, type LogLevel, type Logger } from '@nexa/contracts';
import { redactSecrets } from '../redaction.js';

/**
 * Structured logging, with the correlation id carried implicitly.
 *
 * Every log line, audit row, outbox message and operational event from one
 * business transaction shares a correlation id, so a Telegram update can be
 * followed through the queue into a consumer's side effects. The legacy ops log
 * has no ids and no correlation at all, which is why nothing in it can be
 * traced to anything else.
 */

export interface RequestContext {
  readonly correlationId: CorrelationId;
  readonly requestId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): CorrelationId | undefined {
  return storage.getStore()?.correlationId;
}

class PinoLogger implements Logger {
  constructor(private readonly inner: pino.Logger) {}

  child(bindings: Record<string, unknown>): Logger {
    return new PinoLogger(this.inner.child(bindings));
  }

  private emit(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
    context: Record<string, unknown>,
    message: string,
  ): void {
    const correlationId = currentCorrelationId();
    this.inner[level](correlationId ? { ...context, correlationId } : context, message);
  }

  trace(context: Record<string, unknown>, message: string): void {
    this.emit('trace', context, message);
  }
  debug(context: Record<string, unknown>, message: string): void {
    this.emit('debug', context, message);
  }
  info(context: Record<string, unknown>, message: string): void {
    this.emit('info', context, message);
  }
  warn(context: Record<string, unknown>, message: string): void {
    this.emit('warn', context, message);
  }
  error(context: Record<string, unknown>, message: string): void {
    this.emit('error', context, message);
  }
}

/**
 * Redaction runs over the whole log object, not over a list of paths.
 *
 * pino's `redact.paths` is exact-path and case-sensitive, and its `*` matches
 * exactly one level — so `botToken`, `webhookSecret`, anything three levels
 * deep, and anything inside an array all slipped through the path list this
 * replaced. A hook that walks the object shares one implementation, and one
 * definition of "sensitive", with the audit log.
 */
export function createLogger(level: LogLevel, role: string): Logger {
  return new PinoLogger(
    pino({
      level,
      base: { role },
      hooks: {
        logMethod(args, method) {
          const [first, ...rest] = args;
          if (first !== null && typeof first === 'object') {
            method.apply(this, [redactSecrets(first), ...rest] as typeof args);
            return;
          }
          method.apply(this, args);
        },
      },
      formatters: { level: (label) => ({ level: label }) },
      timestamp: pino.stdTimeFunctions.isoTime,
    }),
  );
}

export function newCorrelationId(uuid: string): CorrelationId {
  return asId<'CorrelationId'>(uuid);
}

export const LOGGER = Symbol('LOGGER');
