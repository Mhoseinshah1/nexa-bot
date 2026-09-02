import type { Logger } from '@nexa/contracts';

export interface ShutdownOptions {
  /** The process role, for the log line. */
  readonly name: string;
  readonly logger: Logger;
  /** Releases the process's resources. Must be safe to await once. */
  readonly close: () => Promise<void>;
  /**
   * How long the close may take before the process leaves anyway.
   *
   * An orchestrator sends SIGTERM, waits its own grace period, then sends
   * SIGKILL. A deadline shorter than that grace period is the difference
   * between a process that reports why it could not finish and one that is
   * killed mid-sentence.
   */
  readonly timeoutMs: number;
  /**
   * Injected so the coordination can be tested without ending the test runner.
   * Production passes `process.exit`.
   */
  readonly exit: (code: number) => void;
}

export interface ShutdownCoordinator {
  /** Idempotent: every call after the first awaits the first one's outcome. */
  shutdown(signal: string): Promise<void>;
  /** How many times `close` was actually invoked. For tests. */
  readonly closes: number;
}

/**
 * One shutdown, however many signals arrive.
 *
 * Both process roles took SIGTERM and SIGINT and ran the same handler per
 * signal. The worker had a boolean guard; the API had none at all, so a
 * SIGINT arriving while a SIGTERM was still closing ran the whole sequence
 * twice — `app.close()` and `container.shutdown()` concurrently with
 * themselves, on a pool and a set of pollers that are not written to be closed
 * twice. In practice an orchestrator sends one signal; in practice is not the
 * standard for the code that releases a database pool.
 *
 * Neither had a deadline. A close that hangs — a connection that will not
 * drain, a poller mid-request against something unreachable — kept the process
 * alive until the orchestrator's SIGKILL, which is the outcome graceful
 * shutdown exists to avoid: the same abrupt death, arrived at slowly, with no
 * log line saying what was stuck.
 *
 * So: the first signal wins and runs `close` exactly once; every later signal
 * awaits that same outcome rather than starting another; and the wait is
 * bounded. Whether the exit was graceful or forced is stated, because the two
 * look identical from outside the process.
 */
export function createShutdownCoordinator(options: ShutdownOptions): ShutdownCoordinator {
  let inFlight: Promise<void> | null = null;
  let closes = 0;

  const runOnce = async (signal: string): Promise<void> => {
    options.logger.info({ signal, role: options.name }, `Shutting down ${options.name}`);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
      // Never the reason the process stays alive.
      timer.unref?.();
    });

    try {
      closes += 1;
      const outcome = await Promise.race([options.close().then(() => 'closed' as const), deadline]);

      if (outcome === 'timeout') {
        options.logger.error(
          { signal, role: options.name, timeoutMs: options.timeoutMs },
          `${options.name} did not finish closing within its deadline; exiting anyway`,
        );
        options.exit(1);
        return;
      }
      options.logger.info({ signal, role: options.name }, `${options.name} shut down cleanly`);
      options.exit(0);
    } catch (error) {
      // A close that THROWS is not a clean exit and must not be reported as
      // one. The process still leaves — there is nothing left to do with a
      // half-released resource — but the exit code says so.
      options.logger.error(
        { signal, role: options.name, err: error instanceof Error ? error.message : String(error) },
        `${options.name} failed to shut down cleanly`,
      );
      options.exit(1);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    shutdown(signal: string): Promise<void> {
      inFlight ??= runOnce(signal);
      return inFlight;
    },
    get closes() {
      return closes;
    },
  };
}
