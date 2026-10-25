import type { Logger } from '@nexa/contracts';

/**
 * The last line of defence of a long-running process role, installed by every `main*.ts`.
 *
 * Every timer runs its tick through `guardedTick`, so a loop's failure is that loop's.
 * This is for what is left: a promise some other path dropped. Before it, Node 22's
 * default turned ONE such rejection into the exit of the whole role — v0.8.2's worker
 * crash-looped every thirteen seconds on a single failing exchange-rate source, and took
 * the relay, the dispatcher and every other lane in the process down with it.
 *
 * `unhandledRejection` is logged and the process KEEPS RUNNING. A rejection is an async
 * failure whose stack has already unwound through its own `finally` blocks; what it loses
 * is one outcome nobody was waiting for, and every write here is transactional and
 * idempotent, so the work is retried by the next tick. Exiting instead restarts every
 * lane to lose that same outcome again.
 *
 * `uncaughtException` is logged and the process STILL EXITS (code 1). A synchronous throw
 * that reached the event loop interrupted code that may have been half-way through
 * changing shared state — a re-entrancy flag set and never cleared, a pooled client never
 * released — and Node documents resuming after it as unsafe. The container restarts the
 * role; the redacted log line is what this adds over Node's default stderr dump, which
 * printed the error unredacted.
 */
export interface ProcessBackstopOptions {
  readonly role: string;
  readonly logger: Pick<Logger, 'error'>;
  readonly exit: (code: number) => void;
  /** The process to listen on; a test passes an emitter of its own. */
  readonly target?: Pick<NodeJS.Process, 'on' | 'off'>;
}

export interface ProcessBackstop {
  /** How many rejections it has absorbed. */
  readonly unhandledRejections: () => number;
  uninstall(): void;
}

export function installProcessBackstop(options: ProcessBackstopOptions): ProcessBackstop {
  const target = options.target ?? process;
  let rejections = 0;

  const onRejection = (reason: unknown): void => {
    rejections += 1;
    try {
      // The reason OBJECT, so the redacting logger renders its message, stack and cause.
      options.logger.error(
        { role: options.role, err: reason, unhandledRejections: rejections },
        'unhandled promise rejection; the process keeps running',
      );
    } catch {
      // The logger is what failed; a backstop that throws from here would be an
      // uncaught exception and exit the process it exists to keep up.
    }
  };

  const onException = (error: unknown): void => {
    try {
      options.logger.error(
        { role: options.role, err: error },
        'uncaught exception; the process exits and is restarted',
      );
    } finally {
      options.exit(1);
    }
  };

  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);
  return {
    unhandledRejections: () => rejections,
    uninstall() {
      target.off('unhandledRejection', onRejection);
      target.off('uncaughtException', onException);
    },
  };
}
