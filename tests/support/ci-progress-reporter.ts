/**
 * A progress line for every test file and test case as it STARTS, plus a
 * heartbeat for anything that runs long.
 *
 * Vitest's default reporter writes a file's line when the file FINISHES. On a
 * serial integration project that means minutes of silence that look the same
 * whether a suite is slow, deadlocked on a row lock, or finished and waiting for
 * an open handle to let the process exit. CI runs the integration shards with
 * this reporter beside `default` and `hanging-process`, so the log answers the
 * question directly:
 *
 * - `▶ file` with test lines still arriving — slow, and making progress;
 * - `▶ file`, then `· test`, then heartbeats naming that test — stuck in that
 *   test (it is ended by `testTimeout`, and the failure names it);
 * - `■ run finished` and then silence — every test is done and something is
 *   holding the process open; `hanging-process` prints what, once vitest's
 *   teardown timeout expires.
 *
 * Only names and timings are printed. The heartbeat timer is `unref`ed, so the
 * reporter can never be the open handle it exists to diagnose.
 *
 * Local runs are unaffected: nothing names this file unless a command line
 * passes `--reporter=./tests/support/ci-progress-reporter.ts`.
 */
import type { Reporter, TestCase, TestModule } from 'vitest/node';

const HEARTBEAT_MS = 30_000;

export default class CiProgressReporter implements Reporter {
  private readonly started = Date.now();
  private current: { name: string; since: number } | null = null;
  private module: { name: string; since: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  onInit(): void {
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  onTestModuleStart(testModule: TestModule): void {
    this.module = { name: testModule.relativeModuleId, since: Date.now() };
    this.line(`▶ ${testModule.relativeModuleId}`);
  }

  onTestModuleEnd(testModule: TestModule): void {
    const took = this.module ? Date.now() - this.module.since : 0;
    this.line(`◀ ${testModule.relativeModuleId} (${seconds(took)})`);
    this.module = null;
    this.current = null;
  }

  onTestCaseReady(testCase: TestCase): void {
    this.current = { name: testCase.fullName, since: Date.now() };
    this.line(`  · ${testCase.fullName}`);
  }

  onTestCaseResult(testCase: TestCase): void {
    const state = testCase.result().state;
    if (state === 'failed') this.line(`  ✗ ${testCase.fullName}`);
    this.current = null;
  }

  onTestRunEnd(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.line(
      '■ run finished. Any silence after this line is teardown: an open handle keeps the ' +
        'process alive, and hanging-process names it when the teardown timeout expires.',
    );
  }

  private heartbeat(): void {
    const now = Date.now();
    if (this.current) {
      this.line(`  … still in "${this.current.name}" after ${seconds(now - this.current.since)}`);
    } else if (this.module) {
      this.line(
        `  … ${this.module.name} has run ${seconds(now - this.module.since)}, between tests (a hook is running)`,
      );
    }
  }

  private line(text: string): void {
    process.stdout.write(`[+${seconds(Date.now() - this.started)}] ${text}\n`);
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
