import { spawnSync } from 'node:child_process';
import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';

/**
 * How the backup pipeline starts the heavy tools: 7-Zip, `pg_dump` and the verification's
 * `pg_restore`. Two things belong to every one of those and to nothing else, so they live in
 * one file rather than at each `spawn`:
 *
 *   - LOW PRIORITY. A backup is the least urgent thing on a small host and the most
 *     I/O-hungry, and the bot answering customers shares its two vCPUs. The tool is started
 *     under `nice -n 10` and `ionice -c3` (idle class), falling back to `ionice -c2 -n7`
 *     where idle is refused, and to no wrapper where a binary is missing.
 *   - SIGNAL DEATH. A tool the kernel killed (SIGKILL, or exit 137 from a shell) is the out
 *     of memory killer, and is told apart from a tool that exited non-zero.
 *
 * The wrapper EXECS the tool (`nice` and `ionice` replace themselves with the command), so
 * the pid, stdin (the 7-Zip password), stdout (the manifest and dump streams) and the exit
 * status or signal are the tool's own.
 */

export type ProbeRunner = (command: string, args: readonly string[]) => boolean;

/** Runs `command args` once and reports whether it exited zero. Never throws. */
export const spawnProbe: ProbeRunner = (command, args) => {
  // A synchronous child inside a transaction would hold a pooled connection for its duration.
  assertOutsideTransaction(`The ${command} probe`);
  try {
    const result = spawnSync(command, [...args], { stdio: 'ignore', timeout: 5_000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
};

/**
 * The argv prefix that lowers a tool's priority: `[]` when neither wrapper works.
 *
 * Each wrapper is PROBED rather than looked up: a container can have `ionice` on PATH and a
 * seccomp profile that refuses the `ioprio_set` call, and a wrapper that fails would fail the
 * backup it was meant to be polite to. `true` is the probe's command.
 */
export function resolveLowPriorityPrefix(probe: ProbeRunner = spawnProbe): readonly string[] {
  const prefix: string[] = [];
  if (probe('ionice', ['-c3', 'true'])) prefix.push('ionice', '-c3');
  else if (probe('ionice', ['-c2', '-n7', 'true'])) prefix.push('ionice', '-c2', '-n7');
  if (probe('nice', ['-n', '10', 'true'])) prefix.push('nice', '-n', '10');
  return prefix;
}

let cachedPrefix: readonly string[] | null = null;

/** Detected once per process. */
export function defaultLowPriorityPrefix(): readonly string[] {
  cachedPrefix ??= resolveLowPriorityPrefix();
  return cachedPrefix;
}

/** Test seam: forget the detected prefix. */
export function resetLowPriorityPrefixForTests(): void {
  cachedPrefix = null;
}

export interface WrappedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** `command args` run under the low-priority prefix (`prefix` empty: unchanged). */
export function wrapLowPriority(
  command: string,
  args: readonly string[],
  prefix: readonly string[] = defaultLowPriorityPrefix(),
): WrappedCommand {
  const [first, ...rest] = prefix;
  if (first === undefined) return { command, args };
  return { command: first, args: [...rest, command, ...args] };
}

/**
 * Whether a tool ended because the kernel (or a shell reporting it) killed it: SIGKILL, or the
 * 128+9 exit status. Callers check their own timeout first — the timeout's second step IS a
 * SIGKILL, and that is a hung tool, not memory.
 */
export function killedBySignal(code: number | null, signal: NodeJS.Signals | null): boolean {
  return signal === 'SIGKILL' || code === 137;
}

export function toolOomKilled(tool: string, code: number | null, signal: NodeJS.Signals | null) {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_TOOL_OOM_KILLED,
    message: `${tool} was killed by the system, which on this host means it ran out of memory.`,
    details: { tool, exitCode: code, signal },
  });
}
